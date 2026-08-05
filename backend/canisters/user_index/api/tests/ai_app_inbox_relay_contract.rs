use std::fs;
use std::path::Path;

fn repository_file(path: &str) -> String {
    let repository_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(4)
        .expect("user_index/api has four ancestors below the repository root");
    fs::read_to_string(repository_root.join(path)).expect("contract source must be readable")
}

#[test]
fn relay_contract_carries_app_identity_not_an_authoritative_destination() {
    let source = repository_file("backend/canisters/user_index/api/src/updates/c2c_deposit_actions.rs");

    assert!(
        source.contains("pub app_id: AiAppId"),
        "relay must carry immutable app identity"
    );
    assert!(
        source.contains("pub app_revision: TimestampMillis"),
        "relay must carry the card's immutable manifest revision"
    );
    assert!(
        !source.contains("pub inbox_canister_id:"),
        "a LocalUserIndex must not choose the destination used with UserIndex authority"
    );
}

#[test]
fn inbox_deposit_contract_is_namespaced_by_app() {
    let source = repository_file("backend/canisters/action_inbox/api/src/updates/c2c_notify_actions.rs");
    assert!(source.contains("pub app_id: AiAppId"), "inbox deposits need an app namespace");
}

#[test]
fn publication_requires_user_index_as_the_only_inbox_depositor() {
    let source = repository_file("backend/canisters/user_index/impl/src/updates/publish_ai_app.rs");
    assert!(
        source.contains("authorized_depositors == vec![expected_user_index]"),
        "publication must reject an inbox that grants relay authority to any other principal"
    );
}

#[test]
fn relay_persists_the_exact_signed_request_before_the_first_inbox_await() {
    let source = repository_file("backend/canisters/user_index/impl/src/updates/c2c_deposit_actions.rs");
    let store = source
        .find(".store_prepared(")
        .expect("relay must durably store the final request");
    let dispatch = source
        .rfind("deliver_and_complete(dispatch).await")
        .expect("relay must dispatch only through the durable outbox");
    assert!(
        store < dispatch,
        "the exact signed request must be persisted before the inbox await"
    );
    assert!(source.contains("serialize_action_inbox_request(&inbox_args)"));
    assert!(source.contains("abort_action_delivery_preparation"));
}

#[test]
fn retry_job_uses_only_stored_bytes_and_destination_with_a_bounded_call() {
    let source = repository_file("backend/canisters/user_index/impl/src/jobs/action_delivery_outbox.rs");
    assert!(source.contains(".with_raw_args(&dispatch.request)"));
    assert!(source.contains("Call::bounded_wait(dispatch.destination"));
    assert!(source.contains("ACTION_INBOX_CALL_TIMEOUT_SECONDS: u32 = 10"));
    for forbidden in [
        "resolve_current_route",
        "ai_app_user_keys",
        "action_signing_keyring",
        "authority::consume",
        "authority::validate",
    ] {
        assert!(!source.contains(forbidden), "retry job must not use {forbidden}");
    }
    for sensitive_log in ["tracing::", "ic_cdk::println", "canister_logger"] {
        assert!(
            !source.contains(sensitive_log),
            "outbox job must not emit identifiers via {sensitive_log}"
        );
    }
}

#[test]
fn first_dispatch_uses_non_consuming_exact_authority_validation_and_secret_selectors() {
    let relay = repository_file("backend/canisters/user_index/impl/src/updates/c2c_deposit_actions.rs");
    assert!(relay.contains("ai_app_card_authority::validate("));
    assert!(
        !relay.contains("ai_app_card_authority::consume("),
        "GroupIndex validation must have no remote consume side effect before request persistence"
    );
    assert!(relay.contains(".consumer_queue_selector("));
    assert!(
        !relay.contains("scoped_key_fingerprint"),
        "queue selectors must not be publicly derivable"
    );

    let client = repository_file("backend/canisters/group_index/c2c_client/src/lib.rs");
    assert!(
        client.contains("generate_c2c_call!(c2c_validate_ai_app_card_authority_v1, 10);"),
        "authority validation must use the bounded ten-second client call"
    );
}

#[test]
fn outbox_is_serde_default_upgrade_state_and_restarts_with_user_index_jobs() {
    let state = repository_file("backend/canisters/user_index/impl/src/lib.rs");
    assert!(state.contains("#[serde(default)]\n    pub action_delivery_outbox:"));
    let jobs = repository_file("backend/canisters/user_index/impl/src/jobs/mod.rs");
    assert!(jobs.contains("action_delivery_outbox::start_job_if_required(state)"));
    let lifecycle = repository_file("backend/canisters/user_index/impl/src/lifecycle/mod.rs");
    assert!(lifecycle.contains("crate::jobs::start(&state)"));
}
