use crate::client;
use crate::env::ENV;
use crate::utils::tick_many;
use crate::TestEnv;
use candid::Principal;
use pocket_ic::PocketIc;
use std::ops::Deref;
use testing::rng::random_string;
use types::{
    AiActionCardTemplate, AiActionDefinition, AiActionRule, AiAppManifest, AiAppRegistration, CanisterId, KeywordMapRule,
    KeywordMapping, RuleMode,
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

fn keyword_map_action() -> AiActionDefinition {
    AiActionDefinition {
        name: "expense.import".to_string(),
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
        rules: vec![AiActionRule::KeywordMap(KeywordMapRule {
            field: "template".to_string(),
            mode: RuleMode::Override,
            map: vec![KeywordMapping {
                value: "groceries".to_string(),
                keywords: vec!["supermarket".to_string(), "grocery".to_string()],
            }],
        })],
        accepts_image: false,
    }
}

// Re-registering a name with the BASE manifest (actions = []) wholesale-replaces the stored
// manifest, dropping previously registered keyword_map rules. This pins the destructive
// overwrite so the frontend's re-sync-after-redeploy obligation is explicit.
#[test]
fn re_register_with_base_manifest_drops_keyword_map_rules() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();

    let owner = client::register_diamond_user(env, canister_ids, *controller);
    let name = random_string();

    // v1: one action carrying a keyword_map rule (the IOU saved-types fold).
    let mut with_rules = manifest(name.clone(), "with rules");
    with_rules.actions = vec![keyword_map_action()];
    let id = match register(env, owner.principal, canister_ids.user_index, with_rules) {
        user_index_canister::register_ai_app::Response::Success(reg) => reg.id,
        other => panic!("expected Success, got {other:?}"),
    };
    let apps = ai_apps(env, owner.principal, canister_ids.user_index);
    let app = apps.iter().find(|a| a.id == id).expect("registered app must be listed");
    assert_eq!(app.manifest.actions.len(), 1, "rules must be present before the re-register");

    // v2: fresh-deploy re-registration of the SAME name with the BASE manifest (no actions).
    match register(env, owner.principal, canister_ids.user_index, manifest(name.clone(), "base redeploy")) {
        user_index_canister::register_ai_app::Response::Success(reg) => {
            assert_eq!(reg.id, id, "upsert keeps the id");
        }
        other => panic!("expected Success, got {other:?}"),
    }

    let apps = ai_apps(env, owner.principal, canister_ids.user_index);
    let app = apps.iter().find(|a| a.id == id).expect("app still listed");
    assert!(
        app.manifest.actions.is_empty(),
        "register() replaces the manifest wholesale: keyword_map rules are GONE until the app re-syncs, got {:?}",
        app.manifest.actions
    );
}

// A manifest whose action carries an AiActionRule::KeywordMap registers within caps and the rule
// payload round-trips UNMANGLED through register + ai_apps read-back (per-variant serde renames on
// the wire). Directly covers IOU's saved-types -> manifest fold.
#[test]
fn keyword_map_rules_survive_register_and_read_back() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();

    let owner = client::register_diamond_user(env, canister_ids, *controller);
    let name = random_string();

    let mut with_rules = manifest(name.clone(), "keyword-map app");
    with_rules.actions = vec![keyword_map_action()];
    let id = match register(env, owner.principal, canister_ids.user_index, with_rules) {
        user_index_canister::register_ai_app::Response::Success(reg) => reg.id,
        other => panic!("expected Success, got {other:?}"),
    };

    let apps = ai_apps(env, owner.principal, canister_ids.user_index);
    let app = apps.iter().find(|a| a.id == id).expect("app must be listed");
    assert_eq!(app.manifest.actions.len(), 1);
    let action = &app.manifest.actions[0];
    assert_eq!(action.name, "expense.import");
    assert_eq!(action.rules.len(), 1);
    let AiActionRule::KeywordMap(rule) = &action.rules[0] else {
        panic!("expected KeywordMap rule, got {:?}", action.rules[0]);
    };
    assert_eq!(rule.field, "template");
    assert!(matches!(rule.mode, RuleMode::Override));
    assert_eq!(rule.map.len(), 1);
    assert_eq!(rule.map[0].value, "groceries");
    assert_eq!(rule.map[0].keywords, vec!["supermarket".to_string(), "grocery".to_string()]);
}

// publish_ai_app for a manifest with NO app_canister_id -> NotVerified (the anti-squat gate
// requires a canister that can vouch; it fails closed), and the app stays out of the explorer.
#[test]
fn publish_without_app_canister_is_not_verified() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();

    let owner = client::register_diamond_user(env, canister_ids, *controller);
    let name = random_string();

    // manifest() sets app_canister_id: None.
    let id = match register(env, owner.principal, canister_ids.user_index, manifest(name.clone(), "unverifiable")) {
        user_index_canister::register_ai_app::Response::Success(reg) => reg.id,
        other => panic!("expected Success, got {other:?}"),
    };

    let publish: user_index_canister::publish_ai_app::Response = client::execute_msgpack_update(
        env,
        owner.principal,
        canister_ids.user_index,
        "publish_ai_app_msgpack",
        &user_index_canister::publish_ai_app::Args { app_id: id },
    );
    assert!(
        matches!(publish, user_index_canister::publish_ai_app::Response::NotVerified),
        "absent app_canister_id must be NotVerified, got {publish:?}"
    );

    // Still unpublished: absent from the public explorer (search covers PUBLISHED apps only).
    let explore: user_index_canister::explore_ai_apps::Response = client::execute_msgpack_query(
        env,
        owner.principal,
        canister_ids.user_index,
        "explore_ai_apps_msgpack",
        &user_index_canister::explore_ai_apps::Args {
            search_term: Some(name.clone()),
            page_index: 0,
            page_size: 10,
        },
    );
    if let user_index_canister::explore_ai_apps::Response::Success(result) = explore {
        assert!(
            !result.matches.iter().any(|a| a.id == id),
            "an unpublished app must not appear in explore"
        );
    }
}

// SECURITY (fail closed): every non-vouch outcome maps to NotVerified and the app never becomes
// published. Covers the reject paths reachable without a stub: an empty canister (no wasm) and a
// live canister that does not implement c2c_verify_ai_app.
#[test]
fn publish_fails_closed_when_verifier_cannot_vouch() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();
    let user_index = canister_ids.user_index;

    let owner = client::register_diamond_user(env, canister_ids, *controller);

    fn publish(
        env: &mut PocketIc,
        sender: Principal,
        user_index: CanisterId,
        app_id: types::AiAppId,
    ) -> user_index_canister::publish_ai_app::Response {
        client::execute_msgpack_update(
            env,
            sender,
            user_index,
            "publish_ai_app_msgpack",
            &user_index_canister::publish_ai_app::Args { app_id },
        )
    }

    // Variant 1: app_canister_id points at an EMPTY canister (created, no wasm) -> c2c rejects.
    let empty_canister = client::create_canister(env, *controller);
    let mut m1 = manifest(random_string(), "empty verifier");
    m1.app_canister_id = Some(empty_canister);
    let id1 = match register(env, owner.principal, user_index, m1) {
        user_index_canister::register_ai_app::Response::Success(reg) => reg.id,
        other => panic!("expected Success, got {other:?}"),
    };
    let r1 = publish(env, owner.principal, user_index, id1);
    assert!(
        matches!(r1, user_index_canister::publish_ai_app::Response::NotVerified),
        "empty verifier canister must be NotVerified, got {r1:?}"
    );

    // Variant 2: a LIVE canister that does not implement c2c_verify_ai_app (method not found).
    let mut m2 = manifest(random_string(), "non-verifier canister");
    m2.app_canister_id = Some(user_index);
    let id2 = match register(env, owner.principal, user_index, m2) {
        user_index_canister::register_ai_app::Response::Success(reg) => reg.id,
        other => panic!("expected Success, got {other:?}"),
    };
    let r2 = publish(env, owner.principal, user_index, id2);
    assert!(
        matches!(r2, user_index_canister::publish_ai_app::Response::NotVerified),
        "a canister without c2c_verify_ai_app must be NotVerified, got {r2:?}"
    );

    // Neither app ever became published: both absent from the public explorer for a non-owner.
    let other_user = client::register_diamond_user(env, canister_ids, *controller);
    let apps = ai_apps(env, other_user.principal, user_index);
    assert!(
        !apps.iter().any(|a| a.id == id1 || a.id == id2),
        "failed publishes must leave the apps invisible to non-owners"
    );
}

// Upsert preserves the id, but delete + re-register does NOT: the fresh registration mints a
// NEW id, so any per-chat enablement that stored the old id is left dangling. Documents the
// id-stability difference between the two "redeploy" flows (a deploy script that
// deletes-then-registers silently breaks enablement; the in-place upsert does not).
#[test]
fn delete_then_re_register_mints_a_new_id() {
    let mut wrapper = ENV.deref().get();
    let TestEnv {
        env, canister_ids, controller, ..
    } = wrapper.env();

    let owner = client::register_diamond_user(env, canister_ids, *controller);
    let name = random_string();

    let id1 = match register(env, owner.principal, canister_ids.user_index, manifest(name.clone(), "v1")) {
        user_index_canister::register_ai_app::Response::Success(reg) => reg.id,
        other => panic!("expected Success, got {other:?}"),
    };

    let deleted: user_index_canister::delete_ai_app::Response = client::execute_msgpack_update(
        env,
        owner.principal,
        canister_ids.user_index,
        "delete_ai_app_msgpack",
        &user_index_canister::delete_ai_app::Args { name: name.clone() },
    );
    assert!(matches!(deleted, user_index_canister::delete_ai_app::Response::Success));

    match register(env, owner.principal, canister_ids.user_index, manifest(name, "v2")) {
        user_index_canister::register_ai_app::Response::Success(reg) => {
            assert_ne!(reg.id, id1, "delete + re-register mints a FRESH id (unlike the in-place upsert)");
        }
        other => panic!("expected Success on re-register, got {other:?}"),
    }
}
