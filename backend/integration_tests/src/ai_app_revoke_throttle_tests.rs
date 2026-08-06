use crate::TestEnv;
use crate::client;
use crate::env::ENV;
use crate::fan_out_delivery_tests;
use crate::utils::now_millis;
use candid::Principal;
use oc_error_codes::OCErrorCode;
use p256_key_pair::P256KeyPair;
use pocket_ic::PocketIc;
use rand::SeedableRng;
use rand::rngs::StdRng;
use std::ops::Deref;
use testing::rng::random_string;
use types::{AiAppId, AiAppRegistration, CanisterId, TimestampMillis};

// Must match backend/canisters/user_index/impl/src/updates/revoke_ai_app_user_key.rs exactly.
const REVOKE_CHALLENGE_DOMAIN: &[u8] = b"oc-revoke-ai-app-user-key-v3\0";

fn revoke_challenge_preimage(
    canister_id: Principal,
    app_subject: &[u8],
    app_id: AiAppId,
    key_version: u64,
    public_key: &str,
    timestamp: TimestampMillis,
) -> Vec<u8> {
    let canister_id_bytes = canister_id.as_slice();
    let mut preimage =
        Vec::with_capacity(REVOKE_CHALLENGE_DOMAIN.len() + canister_id_bytes.len() + app_subject.len() + public_key.len() + 24);
    preimage.extend_from_slice(REVOKE_CHALLENGE_DOMAIN);
    preimage.extend_from_slice(canister_id_bytes);
    preimage.extend_from_slice(app_subject);
    preimage.extend_from_slice(&app_id.to_le_bytes());
    preimage.extend_from_slice(&key_version.to_le_bytes());
    preimage.extend_from_slice(public_key.as_bytes());
    preimage.extend_from_slice(&timestamp.to_le_bytes());
    preimage
}

fn register_per_user_app(
    env: &mut PocketIc,
    canister_ids: &crate::CanisterIds,
    controller: Principal,
    owner: &crate::User,
) -> AiAppRegistration {
    let inbox = client::create_canister(env, controller);
    let draft = fan_out_delivery_tests::register_per_user_app(env, canister_ids.user_index, controller, owner, Some(inbox));
    fan_out_delivery_tests::install_inbox_at(env, controller, canister_ids, inbox, draft.id, canister_ids.user_index);
    fan_out_delivery_tests::publish_registered_app(env, canister_ids.user_index, owner, draft.id)
}

fn app_canister(app: &AiAppRegistration) -> CanisterId {
    app.manifest.app_canister_id.expect("test app must pin its verifier canister")
}

struct PairedKey {
    keypair: P256KeyPair,
    app_subject: Vec<u8>,
    key_version: u64,
}

// Pairs a fresh delivery key with the owner via a link code, returning the keypair so the caller can
// sign the revoke challenge with the matching private key.
fn pair_key(
    env: &mut PocketIc,
    owner: Principal,
    user_index: CanisterId,
    app: &AiAppRegistration,
    rng: &mut StdRng,
) -> PairedKey {
    let kp = P256KeyPair::new(rng);
    let code = match client::execute_msgpack_update::<_, user_index_canister::create_ai_app_link_code::Response>(
        env,
        owner,
        user_index,
        "create_ai_app_link_code_msgpack",
        &user_index_canister::create_ai_app_link_code::Args { app_id: app.id },
    ) {
        user_index_canister::create_ai_app_link_code::Response::Success(r) => r.code,
        other => panic!("expected code, got {other:?}"),
    };
    let claim = fan_out_delivery_tests::claim_link_code_via_app(
        env,
        app_canister(app),
        user_index,
        user_index_canister::c2c_claim_ai_app_link_code::Args {
            code,
            public_key: kp.public_key_pem().to_string(),
        },
    );
    match claim {
        user_index_canister::c2c_claim_ai_app_link_code::Response::Success(result) => {
            assert_eq!(result.app_id, app.id);
            assert_eq!(result.app_canister_id, app_canister(app));
            assert_eq!(result.app_subject.len(), 32);
            PairedKey {
                keypair: kp,
                app_subject: result.app_subject.to_vec(),
                key_version: result.key_version,
            }
        }
        other => panic!("app-authenticated pairing claim must succeed: {other:?}"),
    }
}

fn revoke(
    env: &mut PocketIc,
    caller: Principal,
    user_index: CanisterId,
    app_subject: Vec<u8>,
    app_id: AiAppId,
    key_version: u64,
    public_key: String,
    signature: Vec<u8>,
    timestamp: TimestampMillis,
) -> user_index_canister::revoke_ai_app_user_key::Response {
    fan_out_delivery_tests::revoke_user_key_via_app(
        env,
        caller,
        user_index,
        user_index_canister::revoke_ai_app_user_key::Args {
            app_subject,
            app_id,
            key_version,
            public_key,
            signature,
            timestamp,
        },
    )
}

// Happy path: a signature over the canonical challenge (with the paired private key) revokes the
// key; revoking again is KeyNotFound (the key is already gone).
#[test]
fn revoke_with_valid_signature_then_key_not_found() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env,
        canister_ids,
        controller,
        ..
    } = wrapper.env();
    let user_index = canister_ids.user_index;

    let owner = client::register_diamond_user(env, canister_ids, *controller);
    let app = register_per_user_app(env, canister_ids, *controller, &owner);
    let app_id = app.id;

    let mut rng = StdRng::seed_from_u64(1_001);
    let PairedKey {
        keypair: kp,
        app_subject,
        key_version,
    } = pair_key(env, owner.principal, user_index, &app, &mut rng);
    let pem = kp.public_key_pem().to_string();

    let timestamp = now_millis(env);
    let preimage = revoke_challenge_preimage(user_index, &app_subject, app_id, key_version, &pem, timestamp);
    // jwt::sign_bytes produces the exact ECDSA-SHA256 raw (r||s) signature the endpoint verifies.
    let signature = jwt::sign_bytes(&preimage, kp.secret_key_der(), &mut rng).unwrap();

    let first = revoke(
        env,
        app_canister(&app),
        user_index,
        app_subject.clone(),
        app_id,
        key_version,
        pem.clone(),
        signature.clone(),
        timestamp,
    );
    assert!(
        matches!(first, user_index_canister::revoke_ai_app_user_key::Response::Success),
        "valid signature must revoke, got {first:?}"
    );

    // The key is gone now, so a repeat (fresh valid signature) is KeyNotFound.
    let timestamp2 = now_millis(env);
    let preimage2 = revoke_challenge_preimage(user_index, &app_subject, app_id, key_version, &pem, timestamp2);
    let signature2 = jwt::sign_bytes(&preimage2, kp.secret_key_der(), &mut rng).unwrap();
    let second = revoke(
        env,
        app_canister(&app),
        user_index,
        app_subject,
        app_id,
        key_version,
        pem,
        signature2,
        timestamp2,
    );
    assert!(
        matches!(second, user_index_canister::revoke_ai_app_user_key::Response::KeyNotFound),
        "revoking an already-removed key must be KeyNotFound, got {second:?}"
    );
}

// A syntactically valid-length but wrong signature fails verification -> Error(InvalidSignature).
#[test]
fn revoke_with_bad_signature_is_invalid_signature() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env,
        canister_ids,
        controller,
        ..
    } = wrapper.env();
    let user_index = canister_ids.user_index;

    let owner = client::register_diamond_user(env, canister_ids, *controller);
    let app = register_per_user_app(env, canister_ids, *controller, &owner);
    let app_id = app.id;

    let mut rng = StdRng::seed_from_u64(2_002);
    let PairedKey {
        keypair: kp,
        app_subject,
        key_version,
    } = pair_key(env, owner.principal, user_index, &app, &mut rng);
    let pem = kp.public_key_pem().to_string();

    let timestamp = now_millis(env);
    // A valid signature, but over the WRONG message -> verifies against neither the preimage nor key.
    let wrong_signature = jwt::sign_bytes(b"not the challenge", kp.secret_key_der(), &mut rng).unwrap();

    let response = revoke(
        env,
        app_canister(&app),
        user_index,
        app_subject,
        app_id,
        key_version,
        pem,
        wrong_signature,
        timestamp,
    );
    match response {
        user_index_canister::revoke_ai_app_user_key::Response::Error(e) => {
            assert!(
                e.matches_code(OCErrorCode::InvalidSignature),
                "expected InvalidSignature, got {e:?}"
            );
        }
        other => panic!("expected Error(InvalidSignature), got {other:?}"),
    }
}

// A signature that is valid but timestamped outside the 5-minute past window -> Error(Expired).
#[test]
fn revoke_with_stale_timestamp_is_expired() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env,
        canister_ids,
        controller,
        ..
    } = wrapper.env();
    let user_index = canister_ids.user_index;

    let owner = client::register_diamond_user(env, canister_ids, *controller);
    let app = register_per_user_app(env, canister_ids, *controller, &owner);
    let app_id = app.id;

    let mut rng = StdRng::seed_from_u64(3_003);
    let PairedKey {
        keypair: kp,
        app_subject,
        key_version,
    } = pair_key(env, owner.principal, user_index, &app, &mut rng);
    let pem = kp.public_key_pem().to_string();

    // 6 minutes in the past — beyond the 5-minute REVOKE_PAST_WINDOW_MS. Signature is valid over
    // this exact (stale) preimage, so the ONLY reason to reject is the window: pins Expired.
    let stale = now_millis(env).saturating_sub(6 * 60 * 1000);
    let preimage = revoke_challenge_preimage(user_index, &app_subject, app_id, key_version, &pem, stale);
    let signature = jwt::sign_bytes(&preimage, kp.secret_key_der(), &mut rng).unwrap();

    let response = revoke(
        env,
        app_canister(&app),
        user_index,
        app_subject,
        app_id,
        key_version,
        pem,
        signature,
        stale,
    );
    match response {
        user_index_canister::revoke_ai_app_user_key::Response::Error(e) => {
            assert!(e.matches_code(OCErrorCode::Expired), "expected Expired, got {e:?}");
        }
        other => panic!("expected Error(Expired), got {other:?}"),
    }
}

// From ONE fresh caller, more than MAX_FAILURES_PER_CALLER (10) failed claims trip the throttle:
// the 11th call returns Error(Throttled) before the code space can be probed further.
#[test]
fn repeated_failed_claims_are_throttled() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env,
        canister_ids,
        controller,
        ..
    } = wrapper.env();
    let user_index = canister_ids.user_index;

    // A real, well-formed key and a non-existent token. The registered verifier performs the actual
    // C2C calls so this exercises the endpoint's bounded per-app failure bucket, not ingress guards.
    let mut rng = StdRng::seed_from_u64(4_004);
    let pem = P256KeyPair::new(&mut rng).public_key_pem().to_string();
    let owner = client::register_diamond_user(env, canister_ids, *controller);
    let app = register_per_user_app(env, canister_ids, *controller, &owner);
    let caller = app_canister(&app);

    // First 10 failures: each a genuine miss (CodeNotFound), each counted.
    for i in 0..10 {
        let response = fan_out_delivery_tests::claim_link_code_via_app(
            env,
            caller,
            user_index,
            user_index_canister::c2c_claim_ai_app_link_code::Args {
                code: format!("no-such-code-{i}-{}", random_string()),
                public_key: pem.clone(),
            },
        );
        assert!(
            matches!(
                response,
                user_index_canister::c2c_claim_ai_app_link_code::Response::CodeNotFound
            ),
            "miss #{i} should be CodeNotFound, got {response:?}"
        );
    }

    // The 11th call is rejected by the throttle before the lookup.
    let throttled = fan_out_delivery_tests::claim_link_code_via_app(
        env,
        caller,
        user_index,
        user_index_canister::c2c_claim_ai_app_link_code::Args {
            code: format!("no-such-code-final-{}", random_string()),
            public_key: pem,
        },
    );
    match throttled {
        user_index_canister::c2c_claim_ai_app_link_code::Response::Error(e) => {
            assert!(e.matches_code(OCErrorCode::Throttled), "expected Throttled, got {e:?}");
        }
        other => panic!("11th failed claim must be Error(Throttled), got {other:?}"),
    }
}

// Full round-trip: CLAIM (pair) -> REVOKE -> RECONNECT with a FRESH keypair. After the round-trip
// the (user, app) row must hold ONLY the new key — deposits target the new fingerprint.
#[test]
fn claim_revoke_reclaim_round_trip_uses_fresh_key() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env,
        canister_ids,
        controller,
        ..
    } = wrapper.env();
    let user_index = canister_ids.user_index;

    let owner = client::register_diamond_user(env, canister_ids, *controller);
    let app = register_per_user_app(env, canister_ids, *controller, &owner);
    let app_id = app.id;
    let mut rng = StdRng::seed_from_u64(5_005);

    // 1) CLAIM happy path: pair kp1 via a link code.
    let PairedKey {
        keypair: kp1,
        app_subject: app_subject1,
        key_version: key_version1,
    } = pair_key(env, owner.principal, user_index, &app, &mut rng);
    let pem1 = kp1.public_key_pem().to_string();

    // 2) REVOKE happy path: valid challenge signature over the canonical preimage.
    let timestamp = now_millis(env);
    let preimage = revoke_challenge_preimage(user_index, &app_subject1, app_id, key_version1, &pem1, timestamp);
    let signature = jwt::sign_bytes(&preimage, kp1.secret_key_der(), &mut rng).unwrap();
    let revoked = revoke(
        env,
        app_canister(&app),
        user_index,
        app_subject1,
        app_id,
        key_version1,
        pem1.clone(),
        signature,
        timestamp,
    );
    assert!(
        matches!(revoked, user_index_canister::revoke_ai_app_user_key::Response::Success),
        "revoke must Succeed: {revoked:?}"
    );

    // 3) RECONNECT: a fresh code + a FRESH keypair claims successfully (old one was cleared).
    let PairedKey {
        keypair: kp2,
        app_subject: app_subject2,
        key_version: key_version2,
    } = pair_key(env, owner.principal, user_index, &app, &mut rng);
    let pem2 = kp2.public_key_pem().to_string();
    assert_eq!(app_subject2.len(), 32);
    assert!(key_version2 > key_version1, "reconnect must advance the binding version");
    assert_ne!(pem1, pem2, "the reconnect must use a new keypair");
    assert_ne!(
        ecies_payload::key_fingerprint(&pem1).unwrap(),
        ecies_payload::key_fingerprint(&pem2).unwrap(),
        "the delivery fingerprint must change across the round-trip"
    );

    // The (user, app) row holds ONLY the new key: deposits after reconnect target pem2.
    let user_index_canister::my_ai_app_keys::Response::Success(result) = client::execute_msgpack_query(
        env,
        owner.principal,
        user_index,
        "my_ai_app_keys_msgpack",
        &user_index_canister::my_ai_app_keys::Args {},
    );
    let keys: Vec<_> = result.keys.iter().filter(|k| k.app_id == app_id).collect();
    assert_eq!(keys.len(), 1, "exactly one key after the round-trip: {keys:?}");
    assert_eq!(keys[0].public_key, pem2, "only the reconnect key must remain");
}

// Recovery: after the 1-hour window elapses, a previously-throttled caller's legitimate claim
// succeeds — the throttle is a sliding window, not a permanent lock-out.
#[test]
fn throttled_caller_recovers_after_window() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env,
        canister_ids,
        controller,
        ..
    } = wrapper.env();
    let user_index = canister_ids.user_index;

    let mut rng = StdRng::seed_from_u64(6_006);
    let pem = P256KeyPair::new(&mut rng).public_key_pem().to_string();
    let owner = client::register_diamond_user(env, canister_ids, *controller);
    let app = register_per_user_app(env, canister_ids, *controller, &owner);
    let caller = app_canister(&app);

    // Trip the per-caller throttle: 10 genuine misses...
    for i in 0..10 {
        let response = fan_out_delivery_tests::claim_link_code_via_app(
            env,
            caller,
            user_index,
            user_index_canister::c2c_claim_ai_app_link_code::Args {
                code: format!("miss-{i}-{}", random_string()),
                public_key: pem.clone(),
            },
        );
        assert!(matches!(
            response,
            user_index_canister::c2c_claim_ai_app_link_code::Response::CodeNotFound
        ));
    }
    // ...and prove it tripped (11th call is Throttled).
    let throttled = fan_out_delivery_tests::claim_link_code_via_app(
        env,
        caller,
        user_index,
        user_index_canister::c2c_claim_ai_app_link_code::Args {
            code: random_string(),
            public_key: pem.clone(),
        },
    );
    match throttled {
        user_index_canister::c2c_claim_ai_app_link_code::Response::Error(e) => {
            assert!(e.matches_code(OCErrorCode::Throttled), "expected Throttled, got {e:?}");
        }
        other => panic!("11th failed claim must be Error(Throttled), got {other:?}"),
    }

    // Let every counted failure age out of the sliding 1-hour WINDOW.
    env.advance_time(std::time::Duration::from_secs(61 * 60));
    env.tick();

    // Mint a REAL code AFTER the advance (codes carry a 10-minute TTL)...
    let app_id = app.id;
    let code = match client::execute_msgpack_update::<_, user_index_canister::create_ai_app_link_code::Response>(
        env,
        owner.principal,
        user_index,
        "create_ai_app_link_code_msgpack",
        &user_index_canister::create_ai_app_link_code::Args { app_id },
    ) {
        user_index_canister::create_ai_app_link_code::Response::Success(r) => r.code,
        other => panic!("expected code, got {other:?}"),
    };
    // ...and claim it from the PREVIOUSLY-THROTTLED caller: the failure bucket was pruned.
    let recovered = fan_out_delivery_tests::claim_link_code_via_app(
        env,
        caller,
        user_index,
        user_index_canister::c2c_claim_ai_app_link_code::Args { code, public_key: pem },
    );
    assert!(
        matches!(
            recovered,
            user_index_canister::c2c_claim_ai_app_link_code::Response::Success(_)
        ),
        "post-window claim must Succeed (no permanent lock-out), got {recovered:?}"
    );
}
