use crate::client;
use crate::env::ENV;
use crate::utils::now_millis;
use crate::TestEnv;
use candid::Principal;
use oc_error_codes::OCErrorCode;
use p256_key_pair::P256KeyPair;
use pocket_ic::PocketIc;
use rand::SeedableRng;
use rand::rngs::StdRng;
use std::ops::Deref;
use testing::rng::{random_principal, random_string};
use types::{AiAppId, AiAppManifest, CanisterId, TimestampMillis};

// Must match backend/canisters/user_index/impl/src/updates/revoke_ai_app_user_key.rs exactly.
const REVOKE_CHALLENGE_DOMAIN: &[u8] = b"oc-revoke-ai-app-user-key-v1";

fn revoke_challenge_preimage(canister_id: Principal, public_key: &str, timestamp: TimestampMillis) -> Vec<u8> {
    let canister_id_bytes = canister_id.as_slice();
    let mut preimage = Vec::with_capacity(REVOKE_CHALLENGE_DOMAIN.len() + canister_id_bytes.len() + public_key.len() + 8);
    preimage.extend_from_slice(REVOKE_CHALLENGE_DOMAIN);
    preimage.extend_from_slice(canister_id_bytes);
    preimage.extend_from_slice(public_key.as_bytes());
    preimage.extend_from_slice(&timestamp.to_le_bytes());
    preimage
}

fn register_per_user_app(env: &mut PocketIc, sender: Principal, user_index: CanisterId) -> AiAppId {
    client::user_index::happy_path::register_ai_app(
        env,
        sender,
        user_index,
        AiAppManifest {
            name: random_string(),
            description: "revoke test app".to_string(),
            icon_url: None,
            app_canister_id: None,
            inbox_canister_id: None,
            consumer_public_key: String::new(),
            per_user_keys: true,
            actions: vec![],
            surfaces: vec![],
        },
    )
}

// Pairs a fresh delivery key with the owner via a link code, returning the keypair so the caller can
// sign the revoke challenge with the matching private key.
fn pair_key(
    env: &mut PocketIc,
    owner: Principal,
    user_index: CanisterId,
    app_id: AiAppId,
    rng: &mut StdRng,
) -> P256KeyPair {
    let kp = P256KeyPair::new(rng);
    let code = match client::execute_msgpack_update::<_, user_index_canister::create_ai_app_link_code::Response>(
        env,
        owner,
        user_index,
        "create_ai_app_link_code_msgpack",
        &user_index_canister::create_ai_app_link_code::Args { app_id },
    ) {
        user_index_canister::create_ai_app_link_code::Response::Success(r) => r.code,
        other => panic!("expected code, got {other:?}"),
    };
    let claim: user_index_canister::claim_ai_app_link_code::Response = client::execute_msgpack_update(
        env,
        random_principal(),
        user_index,
        "claim_ai_app_link_code_msgpack",
        &user_index_canister::claim_ai_app_link_code::Args {
            code,
            public_key: kp.public_key_pem().to_string(),
        },
    );
    assert!(
        matches!(claim, user_index_canister::claim_ai_app_link_code::Response::Success),
        "pairing claim must Succeed: {claim:?}"
    );
    kp
}

fn revoke(
    env: &mut PocketIc,
    caller: Principal,
    user_index: CanisterId,
    public_key: String,
    signature: Vec<u8>,
    timestamp: TimestampMillis,
) -> user_index_canister::revoke_ai_app_user_key::Response {
    client::execute_msgpack_update(
        env,
        caller,
        user_index,
        "revoke_ai_app_user_key_msgpack",
        &user_index_canister::revoke_ai_app_user_key::Args {
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
        env, canister_ids, controller, ..
    } = wrapper.env();
    let user_index = canister_ids.user_index;

    let owner = client::register_diamond_user(env, canister_ids, *controller);
    let app_id = register_per_user_app(env, owner.principal, user_index);

    let mut rng = StdRng::seed_from_u64(1_001);
    let kp = pair_key(env, owner.principal, user_index, app_id, &mut rng);
    let pem = kp.public_key_pem().to_string();

    let timestamp = now_millis(env);
    let preimage = revoke_challenge_preimage(user_index, &pem, timestamp);
    // jwt::sign_bytes produces the exact ECDSA-SHA256 raw (r||s) signature the endpoint verifies.
    let signature = jwt::sign_bytes(&preimage, kp.secret_key_der(), &mut rng).unwrap();

    let first = revoke(env, random_principal(), user_index, pem.clone(), signature.clone(), timestamp);
    assert!(
        matches!(first, user_index_canister::revoke_ai_app_user_key::Response::Success),
        "valid signature must revoke, got {first:?}"
    );

    // The key is gone now, so a repeat (fresh valid signature) is KeyNotFound.
    let timestamp2 = now_millis(env);
    let preimage2 = revoke_challenge_preimage(user_index, &pem, timestamp2);
    let signature2 = jwt::sign_bytes(&preimage2, kp.secret_key_der(), &mut rng).unwrap();
    let second = revoke(env, random_principal(), user_index, pem, signature2, timestamp2);
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
        env, canister_ids, controller, ..
    } = wrapper.env();
    let user_index = canister_ids.user_index;

    let owner = client::register_diamond_user(env, canister_ids, *controller);
    let app_id = register_per_user_app(env, owner.principal, user_index);

    let mut rng = StdRng::seed_from_u64(2_002);
    let kp = pair_key(env, owner.principal, user_index, app_id, &mut rng);
    let pem = kp.public_key_pem().to_string();

    let timestamp = now_millis(env);
    // A valid signature, but over the WRONG message -> verifies against neither the preimage nor key.
    let wrong_signature = jwt::sign_bytes(b"not the challenge", kp.secret_key_der(), &mut rng).unwrap();

    let response = revoke(env, random_principal(), user_index, pem, wrong_signature, timestamp);
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
        env, canister_ids, controller, ..
    } = wrapper.env();
    let user_index = canister_ids.user_index;

    let owner = client::register_diamond_user(env, canister_ids, *controller);
    let app_id = register_per_user_app(env, owner.principal, user_index);

    let mut rng = StdRng::seed_from_u64(3_003);
    let kp = pair_key(env, owner.principal, user_index, app_id, &mut rng);
    let pem = kp.public_key_pem().to_string();

    // 6 minutes in the past — beyond the 5-minute REVOKE_PAST_WINDOW_MS. Signature is valid over
    // this exact (stale) preimage, so the ONLY reason to reject is the window: pins Expired.
    let stale = now_millis(env).saturating_sub(6 * 60 * 1000);
    let preimage = revoke_challenge_preimage(user_index, &pem, stale);
    let signature = jwt::sign_bytes(&preimage, kp.secret_key_der(), &mut rng).unwrap();

    let response = revoke(env, random_principal(), user_index, pem, signature, stale);
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
        env, canister_ids, ..
    } = wrapper.env();
    let user_index = canister_ids.user_index;

    // A real, well-formed key so claim gets past key validation and reaches the code lookup (which
    // is what records a failure). The code itself never exists -> CodeNotFound each time. claim has
    // no caller guard, so no registered user is needed.
    let mut rng = StdRng::seed_from_u64(4_004);
    let pem = P256KeyPair::new(&mut rng).public_key_pem().to_string();

    // A single fresh caller so all failures land on ONE per-caller bucket.
    let caller = random_principal();

    // First 10 failures: each a genuine miss (CodeNotFound), each counted.
    for i in 0..10 {
        let response: user_index_canister::claim_ai_app_link_code::Response = client::execute_msgpack_update(
            env,
            caller,
            user_index,
            "claim_ai_app_link_code_msgpack",
            &user_index_canister::claim_ai_app_link_code::Args {
                code: format!("no-such-code-{i}-{}", random_string()),
                public_key: pem.clone(),
            },
        );
        assert!(
            matches!(response, user_index_canister::claim_ai_app_link_code::Response::CodeNotFound),
            "miss #{i} should be CodeNotFound, got {response:?}"
        );
    }

    // The 11th call is rejected by the throttle before the lookup.
    let throttled: user_index_canister::claim_ai_app_link_code::Response = client::execute_msgpack_update(
        env,
        caller,
        user_index,
        "claim_ai_app_link_code_msgpack",
        &user_index_canister::claim_ai_app_link_code::Args {
            code: format!("no-such-code-final-{}", random_string()),
            public_key: pem,
        },
    );
    match throttled {
        user_index_canister::claim_ai_app_link_code::Response::Error(e) => {
            assert!(e.matches_code(OCErrorCode::Throttled), "expected Throttled, got {e:?}");
        }
        other => panic!("11th failed claim must be Error(Throttled), got {other:?}"),
    }
}
