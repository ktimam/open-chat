use std::fs;
use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../..")
        .canonicalize()
        .expect("resolve repository root")
}

fn read_repo_file(relative_path: &str) -> String {
    let path = repo_root().join(relative_path);
    fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

#[test]
fn payload_bearing_action_endpoints_are_not_argument_traced() {
    for endpoint in [
        "backend/canisters/user/impl/src/updates/respond_to_action_card.rs",
        "backend/canisters/user/impl/src/updates/create_ai_app_card_capability.rs",
        "backend/canisters/group/impl/src/updates/respond_to_action_card.rs",
        "backend/canisters/group/impl/src/updates/create_ai_app_card_capability.rs",
        "backend/canisters/group/impl/src/updates/create_ai_app_card_confirmation_grant.rs",
        "backend/canisters/community/impl/src/updates/respond_to_action_card.rs",
        "backend/canisters/community/impl/src/updates/create_ai_app_card_capability.rs",
        "backend/canisters/community/impl/src/updates/create_ai_app_card_confirmation_grant.rs",
        "backend/canisters/local_user_index/impl/src/updates/c2c_deposit_action_confirmed.rs",
        "backend/canisters/local_user_index/impl/src/updates/c2c_validate_ai_app_card_provenance.rs",
        "backend/canisters/local_user_index/impl/src/updates/c2c_create_ai_app_card_capability.rs",
        "backend/canisters/local_user_index/impl/src/updates/c2c_create_ai_app_card_confirmation_grant.rs",
        "backend/canisters/local_user_index/impl/src/updates/c2c_consume_ai_app_card_confirmation_grant.rs",
        "backend/canisters/user_index/impl/src/updates/create_ai_app_link_code.rs",
        "backend/canisters/user_index/impl/src/updates/claim_ai_app_link_code.rs",
        "backend/canisters/user_index/impl/src/updates/c2c_claim_ai_app_link_code.rs",
        "backend/canisters/user_index/impl/src/updates/set_my_ai_app_key.rs",
        "backend/canisters/user_index/impl/src/updates/remove_my_ai_app_key.rs",
        "backend/canisters/user_index/impl/src/updates/revoke_ai_app_user_key.rs",
        "backend/canisters/user_index/impl/src/updates/create_ai_app_card_provenance.rs",
        "backend/canisters/user_index/impl/src/updates/c2c_validate_ai_app_card_provenance.rs",
        "backend/canisters/user_index/impl/src/updates/c2c_create_ai_app_card_capability.rs",
        "backend/canisters/user_index/impl/src/updates/c2c_redeem_ai_app_card_capability.rs",
        "backend/canisters/user_index/impl/src/updates/c2c_create_ai_app_card_confirmation_grant.rs",
        "backend/canisters/user_index/impl/src/updates/c2c_consume_ai_app_card_confirmation_grant.rs",
        "backend/canisters/user_index/impl/src/updates/c2c_ai_app_confirmed_action_route.rs",
        "backend/canisters/user_index/impl/src/updates/c2c_deposit_actions.rs",
        "backend/canisters/group_index/impl/src/updates/c2c_issue_ai_app_card_authority_v1.rs",
        "backend/canisters/group_index/impl/src/updates/c2c_validate_ai_app_card_authority_v1.rs",
        "backend/canisters/group_index/impl/src/updates/c2c_consume_ai_app_card_authority_v1.rs",
        "backend/canisters/action_inbox/impl/src/updates/c2c_notify_actions.rs",
        "backend/canisters/action_inbox/impl/src/updates/acknowledge_actions.rs",
    ] {
        let source = read_repo_file(endpoint);
        let has_trace_attribute = source.lines().any(|line| line.trim() == "#[trace]");
        assert!(
            !source.contains("canister_tracing_macros::trace") && !has_trace_attribute,
            "{endpoint} must not trace plaintext, ciphertext, signatures, or full request structs"
        );
    }
}

#[test]
fn affected_upgrade_hooks_purge_only_their_pr2_sensitive_history_markers() {
    for (lifecycle, markers) in [
        (
            "backend/canisters/user/impl/src/lifecycle/post_upgrade.rs",
            &["respond_to_action_card", "create_ai_app_card_capability"][..],
        ),
        (
            "backend/canisters/group/impl/src/lifecycle/post_upgrade.rs",
            &[
                "respond_to_action_card",
                "create_ai_app_card_capability",
                "create_ai_app_card_confirmation_grant",
            ][..],
        ),
        (
            "backend/canisters/community/impl/src/lifecycle/post_upgrade.rs",
            &[
                "respond_to_action_card",
                "create_ai_app_card_capability",
                "create_ai_app_card_confirmation_grant",
            ][..],
        ),
        (
            "backend/canisters/local_user_index/impl/src/lifecycle/post_upgrade.rs",
            &[
                "c2c_deposit_action_confirmed",
                "c2c_validate_ai_app_card_provenance",
                "c2c_create_ai_app_card_capability",
                "c2c_create_ai_app_card_confirmation_grant",
                "c2c_consume_ai_app_card_confirmation_grant",
            ][..],
        ),
        (
            "backend/canisters/user_index/impl/src/lifecycle/post_upgrade.rs",
            &[
                "create_ai_app_link_code",
                "claim_ai_app_link_code",
                "c2c_claim_ai_app_link_code",
                "set_my_ai_app_key",
                "remove_my_ai_app_key",
                "revoke_ai_app_user_key",
                "create_ai_app_card_provenance",
                "c2c_validate_ai_app_card_provenance",
                "c2c_create_ai_app_card_capability",
                "c2c_redeem_ai_app_card_capability",
                "c2c_create_ai_app_card_confirmation_grant",
                "c2c_consume_ai_app_card_confirmation_grant",
                "c2c_ai_app_confirmed_action_route",
                "c2c_deposit_actions",
            ][..],
        ),
        (
            "backend/canisters/group_index/impl/src/lifecycle/post_upgrade.rs",
            &[
                "c2c_issue_ai_app_card_authority_v1",
                "c2c_validate_ai_app_card_authority_v1",
                "c2c_consume_ai_app_card_authority_v1",
            ][..],
        ),
    ] {
        let source = read_repo_file(lifecycle);
        assert!(
            source.contains("canister_logger::purge_history_containing"),
            "{lifecycle} must purge historical PR2-sensitive entries before logger initialization"
        );
        let purge = source.find("canister_logger::purge_history_containing").unwrap();
        let init = source.find("canister_logger::init_with_logs").unwrap();
        assert!(purge < init, "{lifecycle} must purge before exposing restored logger history");
        for marker in markers {
            assert!(source.contains(marker), "{lifecycle} is missing historical marker {marker}");
        }
    }
}
