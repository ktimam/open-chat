use crate::client;
use crate::env::ENV;
use crate::utils::tick_many;
use crate::TestEnv;
use candid::Principal;
use pocket_ic::PocketIc;
use std::ops::Deref;
use testing::rng::random_string;
use types::{
    AiActionCardTemplate, AiActionDefinition, AiAppManifest, AiAppRegistration, CanisterId,
};

// A real P-256 SPKI PEM (register only checks it CONTAINS "BEGIN PUBLIC KEY"; it is not parsed here).
const TEST_SPKI_PEM: &str = "-----BEGIN PUBLIC KEY-----\n\
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEqEJ3Fh3nq0pXwq3B0m1yq0m8m0z1\n\
4Yb0d3fZq7Xk5c1m0e6qg8sB9r2n0aQ7l5Yy8dW1s0N6vF3wR4p9xK5rQ==\n\
-----END PUBLIC KEY-----\n";

fn manifest(name: String, description: &str) -> AiAppManifest {
    AiAppManifest {
        name,
        description: description.to_string(),
        icon_url: None,
        app_canister_id: None,
        inbox_canister_id: None,
        consumer_public_key: TEST_SPKI_PEM.to_string(),
        per_user_keys: false,
        actions: vec![],
        surfaces: vec![],
    }
}

// Raw register call so the exact Response variant (incl. InvalidRequest) is observable — the
// happy_path helper panics on anything but Success.
fn register(
    env: &mut PocketIc,
    sender: Principal,
    user_index: CanisterId,
    manifest: AiAppManifest,
) -> user_index_canister::register_ai_app::Response {
    client::execute_msgpack_update(
        env,
        sender,
        user_index,
        "register_ai_app_msgpack",
        &user_index_canister::register_ai_app::Args { manifest },
    )
}

fn ai_apps(env: &PocketIc, sender: Principal, user_index: CanisterId) -> Vec<AiAppRegistration> {
    let response: user_index_canister::ai_apps::Response =
        client::execute_msgpack_query(env, sender, user_index, "ai_apps_msgpack", &user_index_canister::ai_apps::Args {});
    match response {
        user_index_canister::ai_apps::Response::Success(result) => result.apps,
    }
}

// Registering the SAME name (same owner) again upserts the existing entry in place: the id and
// created timestamp survive (per-chat enablement stores the id, so it must be stable), only the
// manifest + `updated` change. The read-back over `ai_apps` must reflect the new description.
#[test]
fn re_register_same_name_upserts_in_place() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();

    let owner = client::register_diamond_user(env, canister_ids, *controller);
    let name = random_string();

    let first_id = match register(env, owner.principal, canister_ids.user_index, manifest(name.clone(), "v1")) {
        user_index_canister::register_ai_app::Response::Success(reg) => {
            assert_eq!(reg.manifest.description, "v1");
            reg.id
        }
        other => panic!("expected Success, got {other:?}"),
    };

    // Same name, same owner, changed description -> Success with the SAME id and the new description.
    match register(env, owner.principal, canister_ids.user_index, manifest(name.clone(), "v2")) {
        user_index_canister::register_ai_app::Response::Success(reg) => {
            assert_eq!(reg.id, first_id, "upsert must keep the id stable");
            assert_eq!(reg.manifest.description, "v2");
        }
        other => panic!("expected Success on re-register, got {other:?}"),
    }

    // Read-back over ai_apps (the owner sees its own unpublished app) reflects the upsert.
    let apps = ai_apps(env, owner.principal, canister_ids.user_index);
    let found = apps.iter().find(|a| a.id == first_id).expect("re-registered app must be listed");
    assert_eq!(found.manifest.name, name);
    assert_eq!(found.manifest.description, "v2");
}

// In test_mode a name currently owned by ANOTHER owner is RE-OWNED by a fresh registration (a dev
// convenience for local re-deploys under a new identity): the id is preserved, owner replaced.
#[test]
fn re_register_by_different_user_reowns_in_test_mode() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();

    let owner_a = client::register_diamond_user(env, canister_ids, *controller);
    let owner_b = client::register_diamond_user(env, canister_ids, *controller);
    let name = random_string();

    let id = match register(env, owner_a.principal, canister_ids.user_index, manifest(name.clone(), "by-a")) {
        user_index_canister::register_ai_app::Response::Success(reg) => {
            assert_eq!(reg.owner, owner_a.user_id);
            reg.id
        }
        other => panic!("expected Success, got {other:?}"),
    };

    match register(env, owner_b.principal, canister_ids.user_index, manifest(name.clone(), "by-b")) {
        user_index_canister::register_ai_app::Response::Success(reg) => {
            assert_eq!(reg.id, id, "re-own keeps the id");
            assert_eq!(reg.owner, owner_b.user_id, "re-own transfers ownership in test_mode");
        }
        other => panic!("expected Success (re-own) got {other:?}"),
    }
}

// An empty consumer_public_key with per_user_keys=false is rejected (the app-level key IS read in
// that mode), and a manifest with more than the 20-action cap is rejected.
#[test]
fn register_rejects_invalid_manifests() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();

    let owner = client::register_diamond_user(env, canister_ids, *controller);

    // Empty key + per_user_keys=false -> InvalidRequest.
    let mut empty_key = manifest(random_string(), "no key");
    empty_key.consumer_public_key = String::new();
    empty_key.per_user_keys = false;
    assert!(
        matches!(
            register(env, owner.principal, canister_ids.user_index, empty_key),
            user_index_canister::register_ai_app::Response::InvalidRequest(_)
        ),
        "empty consumer_public_key with per_user_keys=false must be InvalidRequest"
    );

    // 21 actions (cap is 20) -> InvalidRequest. The length check runs before per-action validation,
    // but each action is still built valid for robustness.
    let action = AiActionDefinition {
        name: "act".to_string(),
        description: "d".to_string(),
        prompt_template: "p".to_string(),
        response_schema: "{}".to_string(),
        card: AiActionCardTemplate {
            title: "t".to_string(),
            confirm_label: "ok".to_string(),
            cancel_label: "no".to_string(),
            rows: vec![],
            disclosure: None,
        },
        endpoint: "https://example.com/hook".to_string(),
        consumer_public_key: None,
        rules: vec![],
        accepts_image: false,
    };
    let mut too_many = manifest(random_string(), "too many actions");
    too_many.actions = vec![action; 21];
    assert!(
        matches!(
            register(env, owner.principal, canister_ids.user_index, too_many),
            user_index_canister::register_ai_app::Response::InvalidRequest(_)
        ),
        ">20 actions must be InvalidRequest"
    );
}

// explore_ai_apps enforces a 2-char minimum search term.
#[test]
fn explore_rejects_short_term_and_accepts_normal() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();

    let owner = client::register_diamond_user(env, canister_ids, *controller);

    let short: user_index_canister::explore_ai_apps::Response = client::execute_msgpack_query(
        env,
        owner.principal,
        canister_ids.user_index,
        "explore_ai_apps_msgpack",
        &user_index_canister::explore_ai_apps::Args {
            search_term: Some("a".to_string()),
            page_index: 0,
            page_size: 10,
        },
    );
    assert!(
        matches!(short, user_index_canister::explore_ai_apps::Response::TermTooShort(2)),
        "1-char term must be TermTooShort(2), got {short:?}"
    );

    let normal: user_index_canister::explore_ai_apps::Response = client::execute_msgpack_query(
        env,
        owner.principal,
        canister_ids.user_index,
        "explore_ai_apps_msgpack",
        &user_index_canister::explore_ai_apps::Args {
            search_term: Some("test".to_string()),
            page_index: 0,
            page_size: 10,
        },
    );
    assert!(
        matches!(normal, user_index_canister::explore_ai_apps::Response::Success(_)),
        "a normal-length term must be Success, got {normal:?}"
    );
}

// delete_ai_app removes the caller's app by name; a second delete of the same name is NotFound.
#[test]
fn delete_then_not_found() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();

    let owner = client::register_diamond_user(env, canister_ids, *controller);
    let name = random_string();
    let _ = register(env, owner.principal, canister_ids.user_index, manifest(name.clone(), "to delete"));
    tick_many(env, 1);

    let first: user_index_canister::delete_ai_app::Response = client::execute_msgpack_update(
        env,
        owner.principal,
        canister_ids.user_index,
        "delete_ai_app_msgpack",
        &user_index_canister::delete_ai_app::Args { name: name.clone() },
    );
    assert!(
        matches!(first, user_index_canister::delete_ai_app::Response::Success),
        "first delete must Succeed, got {first:?}"
    );

    let second: user_index_canister::delete_ai_app::Response = client::execute_msgpack_update(
        env,
        owner.principal,
        canister_ids.user_index,
        "delete_ai_app_msgpack",
        &user_index_canister::delete_ai_app::Args { name },
    );
    assert!(
        matches!(second, user_index_canister::delete_ai_app::Response::NotFound),
        "second delete must be NotFound, got {second:?}"
    );
}
