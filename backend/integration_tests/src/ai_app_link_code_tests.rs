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
