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
    fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
        .replace("\r\n", "\n")
}

#[test]
fn authenticated_claim_and_card_redemption_are_in_the_checked_in_candid() {
    let candid = read_repo_file("backend/canisters/user_index/api/can.did");
    assert!(candid.contains("c2c_claim_ai_app_link_code :"));
    assert!(candid.contains("c2c_redeem_ai_app_card_capability :"));
    let claim = method_success_record(&candid, "c2c_claim_ai_app_link_code");
    for field in [
        "app_subject : blob",
        "subject_version : nat16",
        "app_revision : nat64",
        "app_id : nat32",
        "app_canister_id : principal",
        "key_version : nat64",
        "consumer_queue_selector : blob",
        "consumer_queue_selector_version : nat16",
    ] {
        assert!(claim.contains(field), "missing authenticated-claim field: {field}");
    }
    assert!(
        !claim.contains("user_id : principal"),
        "claim leaked the global OpenChat user id"
    );

    let redemption = method_success_record(&candid, "c2c_redeem_ai_app_card_capability");
    assert!(redemption.contains("context : AppScopedCardContext"));
    assert!(redemption.contains("recipient_public_key : blob"));
    assert!(redemption.contains("recipient_key_scheme : text"));
    let external_context = type_block(&candid, "AppScopedCardContext");
    for field in ["app_subject : blob", "chat_handle : blob", "message_handle : blob"] {
        assert!(external_context.contains(field), "missing scoped context field: {field}");
    }
    for raw_field in ["user_id : principal", "chat : Chat", "chat_key : text", "message_id : nat64"] {
        assert!(
            !external_context.contains(raw_field),
            "external context leaked raw field: {raw_field}"
        );
    }

    let revoke_marker = candid.find("signature : blob").expect("revoke signature field");
    let revoke_start = candid[..revoke_marker].rfind("type Args_").expect("revoke args block");
    let revoke_end = candid[revoke_marker..].find("};").expect("revoke args terminator") + revoke_marker + 2;
    let revoke = &candid[revoke_start..revoke_end];
    assert!(revoke.contains("app_subject : blob"));
    assert!(
        !revoke.contains("user_id : principal"),
        "revocation must not require a global user id"
    );
}

#[test]
fn confirmed_action_delivery_exposes_only_app_scoped_context() {
    let route_api = read_repo_file("backend/canisters/user_index/api/src/updates/c2c_ai_app_confirmed_action_route.rs");
    assert!(route_api.contains("pub external_context: AppScopedCardContext"));
    let route_impl = read_repo_file("backend/canisters/user_index/impl/src/updates/c2c_ai_app_confirmed_action_route.rs");
    assert!(route_impl.contains("app_scoped_context("));

    let envelope_source = read_repo_file("backend/canisters/local_user_index/impl/src/action_deposit_envelope.rs");
    let envelope_body = envelope_source
        .split_once("pub fn wrap_plaintext(")
        .expect("scoped plaintext wrapper")
        .1
        .split_once("#[cfg(test)]")
        .expect("wrapper test boundary")
        .0;
    for scoped_field in ["appSubject", "chatHandle", "messageHandle", "contextVersion"] {
        assert!(
            envelope_body.contains(scoped_field),
            "missing scoped envelope field: {scoped_field}"
        );
    }
    for raw_field in ["confirmedBy", "messageId", "threadRootMessageIndex", "\"chat\"", "userId"] {
        assert!(
            !envelope_body.contains(raw_field),
            "raw OpenChat context leaked into envelope: {raw_field}"
        );
    }

    let deposit_impl = read_repo_file("backend/canisters/user_index/impl/src/updates/c2c_deposit_actions.rs");
    assert!(deposit_impl.contains("action_card_context_hash_v2"));
    assert!(!deposit_impl.contains("action_card_context_hash_v1"));
}

#[test]
fn queue_selectors_require_user_index_secret_and_are_privately_distributed() {
    let identity = read_repo_file("backend/canisters/user_index/impl/src/model/ai_app_scoped_identity.rs");
    let selector = identity
        .split_once("pub fn consumer_queue_selector(")
        .expect("HMAC selector method")
        .1
        .split_once("fn mac(")
        .expect("selector method boundary")
        .0;
    assert!(selector.contains("CONSUMER_QUEUE_SELECTOR_DOMAIN_V1"));
    assert!(selector.contains("app_canister_id"));
    assert!(selector.contains("inbox_canister_id"));
    assert!(selector.contains("self.mac(&preimage)"));
    assert!(!selector.contains("sha256::"));

    let lui = read_repo_file("backend/canisters/local_user_index/impl/src/updates/c2c_deposit_action_confirmed.rs");
    assert!(lui.contains("route.consumer_queue_selector"));
    assert!(!lui.contains("scoped_key_fingerprint("));
    assert!(!lui.contains("key_fingerprint("));

    let deposit = read_repo_file("backend/canisters/user_index/impl/src/updates/c2c_deposit_actions.rs");
    assert!(deposit.contains("consumer_queue_selector("));
    assert!(!deposit.contains("scoped_key_fingerprint("));

    let private_app_route =
        read_repo_file("backend/canisters/user_index/impl/src/updates/c2c_get_ai_app_action_inbox_selector.rs");
    assert!(private_app_route.contains("app.manifest.app_canister_id != Some(caller)"));
    assert!(private_app_route.contains("consumer_queue_selector("));

    let public_derivation = read_repo_file("backend/libraries/ecies_payload/src/lib.rs");
    assert!(!public_derivation.contains("pub fn scoped_key_fingerprint("));
}

fn type_block<'a>(candid: &'a str, name: &str) -> &'a str {
    let marker = format!("type {name} = record {{");
    let start = candid.find(&marker).unwrap_or_else(|| panic!("missing Candid type {name}"));
    let end = candid[start..]
        .find("};")
        .map(|offset| start + offset + 2)
        .unwrap_or_else(|| panic!("unterminated Candid type {name}"));
    &candid[start..end]
}

fn method_response_variant<'a>(candid: &'a str, method: &str) -> &'a str {
    let service = candid
        .split_once("service : {")
        .map(|(_, service)| service)
        .expect("Candid service block");
    let signature = service
        .lines()
        .find(|line| line.trim_start().starts_with(&format!("{method} :")))
        .unwrap_or_else(|| panic!("missing Candid method {method}"));
    let response_type = signature
        .split_once("-> (")
        .and_then(|(_, response)| response.split_once(')'))
        .map(|(response, _)| response)
        .unwrap_or_else(|| panic!("missing response type for Candid method {method}"));
    let marker = format!("type {response_type} = variant {{");
    let start = candid
        .find(&marker)
        .unwrap_or_else(|| panic!("missing Candid response type {response_type}"));
    let end = candid[start..]
        .find("\n};")
        .map(|offset| start + offset + 3)
        .unwrap_or_else(|| panic!("unterminated Candid response type {response_type}"));
    &candid[start..end]
}

fn method_success_record<'a>(candid: &'a str, method: &str) -> &'a str {
    let response = method_response_variant(candid, method);
    let success_type = response
        .split_once("Success : ")
        .and_then(|(_, success)| success.split([';', '}']).next())
        .map(str::trim)
        .unwrap_or_else(|| panic!("Candid method {method} has no typed Success response"));
    type_block(candid, success_type)
}

#[test]
fn legacy_public_claim_remains_wire_compatible_but_fail_closed() {
    let candid = read_repo_file("backend/canisters/user_index/api/can.did");
    assert!(candid.contains("claim_ai_app_link_code :"));
    let source = read_repo_file("backend/canisters/user_index/impl/src/updates/claim_ai_app_link_code.rs");
    assert!(source.contains("link codes must be claimed by the registered app canister"));
    assert!(!source.contains("ai_app_user_keys"));
    let response = method_response_variant(&candid, "claim_ai_app_link_code");
    assert!(
        !response.contains("Success"),
        "legacy public claim must not expose a successful response"
    );
    assert!(!candid.contains("type AiAppCardContext = record"));
    assert!(!candid.contains("{chatKey}"));
}

#[test]
fn claim_token_contract_documents_full_entropy() {
    let candid = read_repo_file("backend/canisters/user_index/api/can.did");
    assert!(candid.contains("256-bit lowercase-hex"));
}

#[test]
fn bearer_token_endpoints_are_not_argument_or_result_traced() {
    for endpoint in [
        "cancel_ai_app_link_code.rs",
        "claim_ai_app_link_code.rs",
        "create_ai_app_link_code.rs",
        "c2c_claim_ai_app_link_code.rs",
        "create_ai_app_card_provenance.rs",
        "c2c_validate_ai_app_card_provenance.rs",
        "c2c_create_ai_app_card_capability.rs",
        "c2c_redeem_ai_app_card_capability.rs",
        "c2c_deposit_actions.rs",
        "revoke_ai_app_user_key.rs",
        "set_my_ai_app_key.rs",
        "remove_my_ai_app_key.rs",
        "register_ai_app.rs",
    ] {
        let source = read_repo_file(&format!("backend/canisters/user_index/impl/src/updates/{endpoint}"));
        let has_trace_attribute = source.lines().any(|line| line.trim() == "#[trace]");
        assert!(
            !source.contains("canister_tracing_macros::trace") && !has_trace_attribute,
            "{endpoint} must not trace live claim-token request or response material"
        );
    }

    for endpoint in [
        "backend/canisters/local_user_index/impl/src/updates/c2c_deposit_action_confirmed.rs",
        "backend/canisters/action_inbox/impl/src/updates/c2c_notify_actions.rs",
    ] {
        let source = read_repo_file(endpoint);
        let has_trace_attribute = source.lines().any(|line| line.trim() == "#[trace]");
        assert!(
            !source.contains("canister_tracing_macros::trace") && !has_trace_attribute,
            "{endpoint} must not trace deposits"
        );
    }
}
