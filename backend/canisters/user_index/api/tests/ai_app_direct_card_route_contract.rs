use std::fs;
use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../..")
        .canonicalize()
        .expect("resolve repository root")
}

fn source(relative_path: &str) -> String {
    let path = repo_root().join(relative_path);
    fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

#[test]
fn every_user_index_direct_card_outer_branch_uses_the_current_home_lui_gate() {
    let handlers = [
        "c2c_validate_ai_app_card_provenance.rs",
        "c2c_create_ai_app_card_capability.rs",
        "c2c_create_ai_app_card_confirmation_grant.rs",
        "c2c_consume_ai_app_card_confirmation_grant.rs",
        "c2c_ai_app_confirmed_action_route.rs",
        "c2c_deposit_actions.rs",
    ];
    for handler in handlers {
        let path = format!("backend/canisters/user_index/impl/src/updates/{handler}");
        let body = source(&path);
        assert!(
            body.contains("Chat::Direct(_)") || body.contains("types::Chat::Direct(_)"),
            "{path}"
        );
        assert!(body.contains("validate_direct_card_lui_route"), "{path}");
        assert!(
            body.contains("ai_app_card_authority::"),
            "{path} must retain GroupIndex authority for group and channel cards"
        );
    }

    let common = source("backend/canisters/user_index/impl/src/updates/create_ai_app_card_provenance.rs");
    assert!(common.contains("if !authority.is_empty()"));
    assert!(common.contains("canonical_card_chat_key(context.user_id, context.chat)"));
    assert!(common.contains("local_index_map.get_index_canister(&context.user_id) != Some(caller)"));
    assert!(common.contains("users.get_by_user_id(&context.user_id).is_none()"));
}

#[test]
fn every_local_user_index_direct_card_relay_rejects_group_authority() {
    for handler in [
        "c2c_validate_ai_app_card_provenance.rs",
        "c2c_create_ai_app_card_capability.rs",
        "c2c_create_ai_app_card_confirmation_grant.rs",
        "c2c_consume_ai_app_card_confirmation_grant.rs",
        "c2c_deposit_action_confirmed.rs",
    ] {
        let path = format!("backend/canisters/local_user_index/impl/src/updates/{handler}");
        let body = source(&path);
        assert!(body.contains("Direct(_)) && !args."), "{path}");
        assert!(body.contains("direct chat must not carry group route authority"), "{path}");
        assert!(body.contains("authoritative_child_registration"), "{path}");
    }
}

#[test]
fn every_async_user_index_card_relay_keeps_the_ingress_caller_across_awaits() {
    for handler in [
        "c2c_validate_ai_app_card_provenance.rs",
        "c2c_create_ai_app_card_capability.rs",
        "c2c_create_ai_app_card_confirmation_grant.rs",
        "c2c_consume_ai_app_card_confirmation_grant.rs",
        "c2c_ai_app_confirmed_action_route.rs",
        "c2c_deposit_actions.rs",
    ] {
        let path = format!("backend/canisters/user_index/impl/src/updates/{handler}");
        let body = source(&path);
        let first_await = body.find(".await").unwrap_or_else(|| panic!("{path} must remain async"));
        let before_await = &body[..first_await];
        let after_await = &body[first_await..];
        assert!(
            before_await.contains("let caller = ic_cdk::api::msg_caller();")
                || before_await.contains("let caller = read_state(|state| state.env.caller());"),
            "{path} must capture its ingress caller before the first await"
        );
        assert!(
            !after_await.contains("msg_caller()") && !after_await.contains("state.env.caller()"),
            "{path} must revalidate the captured caller rather than the callback caller"
        );
    }
}
