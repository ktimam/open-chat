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
fn every_lui_card_relay_revalidates_the_captured_child_registration_after_await() {
    for path in [
        "backend/canisters/local_user_index/impl/src/updates/c2c_validate_ai_app_card_provenance.rs",
        "backend/canisters/local_user_index/impl/src/updates/c2c_create_ai_app_card_capability.rs",
        "backend/canisters/local_user_index/impl/src/updates/c2c_create_ai_app_card_confirmation_grant.rs",
        "backend/canisters/local_user_index/impl/src/updates/c2c_consume_ai_app_card_confirmation_grant.rs",
        "backend/canisters/local_user_index/impl/src/updates/c2c_deposit_action_confirmed.rs",
    ] {
        let body = source(path);
        assert!(
            body.contains("let caller = ic_cdk::api::msg_caller();"),
            "{path} must capture ingress caller before awaiting"
        );
        assert!(
            body.contains("caller_registration"),
            "{path} must snapshot the exact child registration"
        );
        assert!(
            body.matches("authoritative_child_registration(state, caller)").count() >= 2,
            "{path} must re-read the captured child after awaiting"
        );
        assert!(
            !body.contains("read_state(authoritative_child_kind)"),
            "{path} must not classify callback msg_caller"
        );
    }
}

#[test]
fn group_and_community_post_await_checks_never_re_resolve_callback_caller() {
    for path in [
        "backend/canisters/group/impl/src/updates/send_message.rs",
        "backend/canisters/community/impl/src/updates/send_message.rs",
    ] {
        let body = source(path);
        let start = body.find("fn revalidate_app_card_post").expect("post-await revalidator");
        let end = body[start..]
            .find("#[update")
            .map(|offset| start + offset)
            .expect("next update");
        let revalidator = &body[start..end];
        assert!(
            !revalidator.contains("state.env.caller()"),
            "{path} must use captured ingress identity"
        );
        assert!(
            !revalidator.contains("verified_caller(None)"),
            "{path} must not resolve callback caller"
        );
        assert!(
            revalidator.contains("principal_mapping_generation"),
            "{path} must reject principal-remap ABA"
        );
        assert!(
            revalidator.contains("get_verified_member"),
            "{path} must recheck current membership and suspension"
        );
    }
}

#[test]
fn mapping_and_child_registries_keep_monotonic_aba_generations() {
    let principal_map = source("backend/libraries/principal_to_user_id_map/src/lib.rs");
    assert!(principal_map.contains("fn on_inserted"));
    assert!(principal_map.contains("fn on_removed"));
    assert!(principal_map.matches("self.bump_generation();").count() >= 2);
    for path in [
        "backend/canisters/local_user_index/impl/src/model/local_user_map.rs",
        "backend/canisters/local_user_index/impl/src/model/local_group_map.rs",
        "backend/canisters/local_user_index/impl/src/model/local_community_map.rs",
    ] {
        let body = source(path);
        assert!(
            body.contains("registration_generations"),
            "{path} must retain ABA tombstone generations"
        );
        assert!(
            body.contains("saturating_add(1)"),
            "{path} must advance registration generations"
        );
    }
}
