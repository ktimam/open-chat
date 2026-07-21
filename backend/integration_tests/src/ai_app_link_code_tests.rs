use crate::client;
use crate::env::ENV;
use crate::TestEnv;
use candid::Principal;
use p256_key_pair::P256KeyPair;
use pocket_ic::PocketIc;
use rand::SeedableRng;
use rand::rngs::StdRng;
use std::ops::Deref;
use std::time::Duration;
use testing::rng::random_string;
use types::{AiAppId, AiAppManifest, CanisterId};

const TEST_SPKI_PEM: &str = "-----BEGIN PUBLIC KEY-----\n\
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEqEJ3Fh3nq0pXwq3B0m1yq0m8m0z1\n\
4Yb0d3fZq7Xk5c1m0e6qg8sB9r2n0aQ7l5Yy8dW1s0N6vF3wR4p9xK5rQ==\n\
-----END PUBLIC KEY-----\n";

fn register_per_user_app(
    env: &mut PocketIc,
    sender: Principal,
    user_index: CanisterId,
) -> AiAppId {
    client::user_index::happy_path::register_ai_app(
        env,
        sender,
        user_index,
        AiAppManifest {
            name: random_string(),
            description: "link-code test app".to_string(),
            icon_url: None,
            app_canister_id: None,
            inbox_canister_id: None,
            // per_user_keys apps may leave the app-level key empty.
            consumer_public_key: String::new(),
            per_user_keys: true,
            actions: vec![],
            surfaces: vec![],
        },
    )
}

fn create_link_code(
    env: &mut PocketIc,
    sender: Principal,
    user_index: CanisterId,
    app_id: AiAppId,
) -> String {
    let response: user_index_canister::create_ai_app_link_code::Response = client::execute_msgpack_update(
        env,
        sender,
        user_index,
        "create_ai_app_link_code_msgpack",
        &user_index_canister::create_ai_app_link_code::Args { app_id },
    );
    match response {
        user_index_canister::create_ai_app_link_code::Response::Success(result) => result.code,
        other => panic!("expected a link code, got {other:?}"),
    }
}

fn claim(
    env: &mut PocketIc,
    caller: Principal,
    user_index: CanisterId,
    code: String,
    public_key: String,
) -> user_index_canister::claim_ai_app_link_code::Response {
    client::execute_msgpack_update(
        env,
        caller,
        user_index,
        "claim_ai_app_link_code_msgpack",
        &user_index_canister::claim_ai_app_link_code::Args { code, public_key },
    )
}

fn my_keys(
    env: &PocketIc,
    caller: Principal,
    user_index: CanisterId,
) -> Vec<types::AiAppUserKey> {
    let response: user_index_canister::my_ai_app_keys::Response =
        client::execute_msgpack_query(env, caller, user_index, "my_ai_app_keys_msgpack", &user_index_canister::my_ai_app_keys::Args {});
    match response {
        user_index_canister::my_ai_app_keys::Response::Success(result) => result.keys,
    }
}

// Happy path: owner creates a code, the external app claims it with a delivery key, and that key
// then shows up in the owner's key list. A second claim of the same code is CodeNotFound (single-use).
#[test]
fn link_code_happy_path_is_single_use() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();

    let owner = client::register_diamond_user(env, canister_ids, *controller);
    let app_id = register_per_user_app(env, owner.principal, canister_ids.user_index);

    let mut rng = StdRng::seed_from_u64(101);
    let delivery_pem = P256KeyPair::new(&mut rng).public_key_pem().to_string();

    let code = create_link_code(env, owner.principal, canister_ids.user_index, app_id);

    // The external app claims with an arbitrary principal (bearer authorization is the code itself).
    let claimer = testing::rng::random_principal();
    assert!(
        matches!(
            claim(env, claimer, canister_ids.user_index, code.clone(), delivery_pem.clone()),
            user_index_canister::claim_ai_app_link_code::Response::Success
        ),
        "first claim must Succeed"
    );

    // The key is registered for the CODE's (user, app) pair == the owner who created it.
    let keys = my_keys(env, owner.principal, canister_ids.user_index);
    assert!(
        keys.iter().any(|k| k.app_id == app_id && k.public_key == delivery_pem),
        "owner's key list must contain the claimed delivery key: {keys:?}"
    );

    // Single-use: the code is consumed, so re-claiming is CodeNotFound.
    assert!(
        matches!(
            claim(env, claimer, canister_ids.user_index, code, delivery_pem),
            user_index_canister::claim_ai_app_link_code::Response::CodeNotFound
        ),
        "second claim of a consumed code must be CodeNotFound"
    );
}

// A code claimed after its 10-minute TTL is CodeExpired (distinct from CodeNotFound).
#[test]
fn link_code_expires_after_ttl() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();

    let owner = client::register_diamond_user(env, canister_ids, *controller);
    let app_id = register_per_user_app(env, owner.principal, canister_ids.user_index);

    let mut rng = StdRng::seed_from_u64(202);
    let delivery_pem = P256KeyPair::new(&mut rng).public_key_pem().to_string();

    let code = create_link_code(env, owner.principal, canister_ids.user_index, app_id);

    // Advance past the 10-minute TTL (add slack) and let the clock take effect.
    env.advance_time(Duration::from_secs(11 * 60));
    env.tick();

    let claimer = testing::rng::random_principal();
    assert!(
        matches!(
            claim(env, claimer, canister_ids.user_index, code, delivery_pem),
            user_index_canister::claim_ai_app_link_code::Response::CodeExpired
        ),
        "claim after TTL must be CodeExpired"
    );
}

// set_my_ai_app_key registers a key the caller owns; remove_my_ai_app_key removes it and is
// idempotent (removing an absent key still reports Success — a disconnect must always succeed).
#[test]
fn set_and_remove_my_key_is_idempotent() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();

    let owner = client::register_diamond_user(env, canister_ids, *controller);
    // per_user_keys not required for set_my_ai_app_key; a plain app with a valid app-level key is fine.
    let app_id = client::user_index::happy_path::register_ai_app(
        env,
        owner.principal,
        canister_ids.user_index,
        AiAppManifest {
            name: random_string(),
            description: "set/remove key app".to_string(),
            icon_url: None,
            app_canister_id: None,
            inbox_canister_id: None,
            consumer_public_key: TEST_SPKI_PEM.to_string(),
            per_user_keys: true,
            actions: vec![],
            surfaces: vec![],
        },
    );

    let mut rng = StdRng::seed_from_u64(303);
    let pem = P256KeyPair::new(&mut rng).public_key_pem().to_string();

    let set: user_index_canister::set_my_ai_app_key::Response = client::execute_msgpack_update(
        env,
        owner.principal,
        canister_ids.user_index,
        "set_my_ai_app_key_msgpack",
        &user_index_canister::set_my_ai_app_key::Args {
            app_id,
            public_key: pem.clone(),
        },
    );
    assert!(matches!(set, user_index_canister::set_my_ai_app_key::Response::Success), "set must Succeed: {set:?}");

    assert!(
        my_keys(env, owner.principal, canister_ids.user_index)
            .iter()
            .any(|k| k.app_id == app_id && k.public_key == pem),
        "key list must contain the set key"
    );

    // set_my_ai_app_key for an unknown app id -> AppNotFound.
    let unknown: user_index_canister::set_my_ai_app_key::Response = client::execute_msgpack_update(
        env,
        owner.principal,
        canister_ids.user_index,
        "set_my_ai_app_key_msgpack",
        &user_index_canister::set_my_ai_app_key::Args {
            app_id: u32::MAX,
            public_key: pem.clone(),
        },
    );
    assert!(
        matches!(unknown, user_index_canister::set_my_ai_app_key::Response::AppNotFound),
        "set for unknown app must be AppNotFound, got {unknown:?}"
    );

    // Remove -> gone.
    let remove: user_index_canister::remove_my_ai_app_key::Response = client::execute_msgpack_update(
        env,
        owner.principal,
        canister_ids.user_index,
        "remove_my_ai_app_key_msgpack",
        &user_index_canister::remove_my_ai_app_key::Args { app_id },
    );
    assert!(matches!(remove, user_index_canister::remove_my_ai_app_key::Response::Success), "remove must Succeed");
    assert!(
        !my_keys(env, owner.principal, canister_ids.user_index)
            .iter()
            .any(|k| k.app_id == app_id),
        "key must be gone after remove"
    );

    // Remove again (absent key) -> still Success (idempotent disconnect).
    let remove_again: user_index_canister::remove_my_ai_app_key::Response = client::execute_msgpack_update(
        env,
        owner.principal,
        canister_ids.user_index,
        "remove_my_ai_app_key_msgpack",
        &user_index_canister::remove_my_ai_app_key::Args { app_id },
    );
    assert!(
        matches!(remove_again, user_index_canister::remove_my_ai_app_key::Response::Success),
        "removing an absent key must still be Success (idempotent), got {remove_again:?}"
    );
}

// A claim whose public_key fails validation is rejected BEFORE the code store is touched, so the
// code is NOT burned: the same code subsequently claims with a valid key. A regression that
// reordered validation after claim() would silently consume codes on malformed requests.
#[test]
fn claim_with_invalid_key_does_not_burn_the_code() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();

    let owner = client::register_diamond_user(env, canister_ids, *controller);
    let app_id = register_per_user_app(env, owner.principal, canister_ids.user_index);
    let code = create_link_code(env, owner.principal, canister_ids.user_index, app_id);

    let claimer = testing::rng::random_principal();

    // Malformed key (no "BEGIN PUBLIC KEY") -> InvalidRequest, and the code must survive.
    assert!(
        matches!(
            claim(env, claimer, canister_ids.user_index, code.clone(), "not-a-pem".to_string()),
            user_index_canister::claim_ai_app_link_code::Response::InvalidRequest(_)
        ),
        "malformed key must be InvalidRequest"
    );

    // The SAME code still claims with a valid key — the invalid attempt did not consume it.
    let mut rng = StdRng::seed_from_u64(404);
    let delivery_pem = P256KeyPair::new(&mut rng).public_key_pem().to_string();
    assert!(
        matches!(
            claim(env, claimer, canister_ids.user_index, code, delivery_pem.clone()),
            user_index_canister::claim_ai_app_link_code::Response::Success
        ),
        "claim with a valid key after a rejected invalid claim must Succeed (code not burned)"
    );

    // And the key landed for the code's (user, app) pair.
    assert!(
        my_keys(env, owner.principal, canister_ids.user_index)
            .iter()
            .any(|k| k.app_id == app_id && k.public_key == delivery_pem),
        "owner's key list must contain the delivery key"
    );
}

// A NEW code for the same (user, app) pair retires the prior one: only the latest code is claimable.
#[test]
fn new_link_code_retires_prior_code_for_same_pair() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();

    let owner = client::register_diamond_user(env, canister_ids, *controller);
    let app_id = register_per_user_app(env, owner.principal, canister_ids.user_index);

    let mut rng = StdRng::seed_from_u64(405);
    let delivery_pem = P256KeyPair::new(&mut rng).public_key_pem().to_string();

    let code1 = create_link_code(env, owner.principal, canister_ids.user_index, app_id);
    let code2 = create_link_code(env, owner.principal, canister_ids.user_index, app_id);

    let claimer = testing::rng::random_principal();
    // The retired first code is dead — reported exactly like a code that never existed.
    assert!(
        matches!(
            claim(env, claimer, canister_ids.user_index, code1, delivery_pem.clone()),
            user_index_canister::claim_ai_app_link_code::Response::CodeNotFound
        ),
        "a retired (superseded) code must be CodeNotFound"
    );
    // Only the LATEST code claims.
    assert!(
        matches!(
            claim(env, claimer, canister_ids.user_index, code2, delivery_pem.clone()),
            user_index_canister::claim_ai_app_link_code::Response::Success
        ),
        "the replacement code must claim successfully"
    );
    assert!(
        my_keys(env, owner.principal, canister_ids.user_index)
            .iter()
            .any(|k| k.app_id == app_id && k.public_key == delivery_pem),
        "the key claimed via the replacement code must be registered"
    );
}

// Rotation: set_my_ai_app_key UPSERTS by (user, app) — the new key REPLACES the old (exactly one
// row remains) and the fan-out lookup only ever sees the latest key.
#[test]
fn set_my_ai_app_key_rotation_replaces_previous_key() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();

    let owner = client::register_diamond_user(env, canister_ids, *controller);
    let app_id = register_per_user_app(env, owner.principal, canister_ids.user_index);

    let mut rng = StdRng::seed_from_u64(505);
    let key1 = P256KeyPair::new(&mut rng).public_key_pem().to_string();
    let key2 = P256KeyPair::new(&mut rng).public_key_pem().to_string();

    for key in [&key1, &key2] {
        let set: user_index_canister::set_my_ai_app_key::Response = client::execute_msgpack_update(
            env,
            owner.principal,
            canister_ids.user_index,
            "set_my_ai_app_key_msgpack",
            &user_index_canister::set_my_ai_app_key::Args {
                app_id,
                public_key: key.clone(),
            },
        );
        assert!(matches!(set, user_index_canister::set_my_ai_app_key::Response::Success), "set failed: {set:?}");
    }

    // my_ai_app_keys: exactly ONE row for the app, and it is key2 (replaced, not appended).
    let rows: Vec<_> = my_keys(env, owner.principal, canister_ids.user_index)
        .into_iter()
        .filter(|k| k.app_id == app_id)
        .collect();
    assert_eq!(rows.len(), 1, "rotation must not leave a second row: {rows:?}");
    assert_eq!(rows[0].public_key, key2, "the LATEST key must have replaced the old one");

    // The fan-out lookup (what a proposer uses to address deposits) also returns ONLY key2 — a
    // lingering key1 would keep receiving fan-out envelopes after rotation.
    let response: user_index_canister::ai_app_user_keys::Response = client::execute_msgpack_query(
        env,
        owner.principal,
        canister_ids.user_index,
        "ai_app_user_keys_msgpack",
        &user_index_canister::ai_app_user_keys::Args {
            app_id,
            user_ids: vec![owner.user_id],
        },
    );
    let user_index_canister::ai_app_user_keys::Response::Success(result) = response;
    assert_eq!(result.keys.len(), 1);
    assert_eq!(result.keys[0].public_key, key2, "fan-out lookup must resolve to the rotated key only");
}

// delete_ai_app removes ONLY the registry entry: the user's paired delivery key and any
// outstanding link code survive (orphan cleanup is not implemented — despite the
// AiAppUserKeys::remove doc comment claiming it backs 'app-deletion cleanup').
// Pinned here so the leak is either fixed deliberately or accepted explicitly.
#[test]
fn delete_ai_app_leaves_per_user_keys_and_outstanding_codes_behind() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();

    let owner = client::register_diamond_user(env, canister_ids, *controller);
    let name = random_string();
    let app_id = client::user_index::happy_path::register_ai_app(
        env,
        owner.principal,
        canister_ids.user_index,
        AiAppManifest {
            name: name.clone(),
            description: "orphan cleanup pin".to_string(),
            icon_url: None,
            app_canister_id: None,
            inbox_canister_id: None,
            consumer_public_key: String::new(),
            per_user_keys: true,
            actions: vec![],
            surfaces: vec![],
        },
    );

    // Pair a delivery key via the claim path, and mint a SECOND, still-outstanding code.
    let mut rng = StdRng::seed_from_u64(406);
    let pem1 = P256KeyPair::new(&mut rng).public_key_pem().to_string();
    let code1 = create_link_code(env, owner.principal, canister_ids.user_index, app_id);
    assert!(matches!(
        claim(env, testing::rng::random_principal(), canister_ids.user_index, code1, pem1.clone()),
        user_index_canister::claim_ai_app_link_code::Response::Success
    ));
    let code2 = create_link_code(env, owner.principal, canister_ids.user_index, app_id);

    let deleted: user_index_canister::delete_ai_app::Response = client::execute_msgpack_update(
        env,
        owner.principal,
        canister_ids.user_index,
        "delete_ai_app_msgpack",
        &user_index_canister::delete_ai_app::Args { name },
    );
    assert!(matches!(deleted, user_index_canister::delete_ai_app::Response::Success));

    // PINNED LEAK 1: the per-user delivery key is still listed for the dead app id...
    assert!(
        my_keys(env, owner.principal, canister_ids.user_index)
            .iter()
            .any(|k| k.app_id == app_id && k.public_key == pem1),
        "delete_ai_app currently leaves the paired key behind"
    );
    // ...and still served to fan-out lookups.
    let user_index_canister::ai_app_user_keys::Response::Success(result) = client::execute_msgpack_query(
        env,
        owner.principal,
        canister_ids.user_index,
        "ai_app_user_keys_msgpack",
        &user_index_canister::ai_app_user_keys::Args {
            app_id,
            user_ids: vec![owner.user_id],
        },
    );
    assert_eq!(result.keys.len(), 1, "fan-out lookup still returns the orphaned key");

    // PINNED LEAK 2: an outstanding code minted before deletion still claims successfully,
    // registering a key for an app that no longer exists (claim never checks app existence).
    let pem2 = P256KeyPair::new(&mut rng).public_key_pem().to_string();
    assert!(matches!(
        claim(env, testing::rng::random_principal(), canister_ids.user_index, code2, pem2),
        user_index_canister::claim_ai_app_link_code::Response::Success
    ));
}
