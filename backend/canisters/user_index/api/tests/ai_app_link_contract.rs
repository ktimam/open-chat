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

#[test]
fn chat_link_launch_contract_is_opaque_exact_app_scoped_and_exact_retry_idempotent() {
    let candid = read_repo_file("backend/canisters/user_index/api/can.did");
    let args = method_args_record(&candid, "c2c_redeem_ai_app_chat_link_token");
    assert!(args.contains("token : blob"));
    assert!(args.contains("expected_app_subject : blob"));
    for raw in ["user_id", "chat_key", "chat_id", "channel_id"] {
        assert!(!args.contains(raw), "redeem args leaked raw coordinate: {raw}");
    }

    let response = method_response_variant(&candid, "c2c_redeem_ai_app_chat_link_token");
    for variant in [
        "TokenNotFound",
        "TokenExpired",
        "NotAuthorized",
        "SubjectMismatch",
        "AppUnavailable",
        "InvalidRequest : text",
        "Error : record { nat16; opt text }",
    ] {
        assert!(response.contains(variant), "missing redemption result: {variant}");
    }
    let success = method_success_record(&candid, "c2c_redeem_ai_app_chat_link_token");
    for field in [
        "app_subject : blob",
        "subject_version : nat16",
        "app_id : nat32",
        "app_revision : nat64",
        "app_canister_id : principal",
        "app_user_key_version : nat64",
        "chat_handle : blob",
        "chat_handle_version : nat16",
        "chat_name : opt text",
    ] {
        assert!(success.contains(field), "missing app-scoped result: {field}");
    }
    for raw in ["user_id", "chat_key", "chat :"] {
        assert!(!success.contains(raw), "redemption leaked raw coordinate: {raw}");
    }

    let redeem = read_repo_file("backend/canisters/user_index/impl/src/updates/c2c_redeem_ai_app_chat_link_token.rs");
    let caller_check = redeem
        .find("caller != token.app_canister_id")
        .expect("exact app caller check");
    let subject_check = redeem
        .find("ct_eq(&token.app_subject)")
        .expect("constant-time expected subject check");
    let redeem_store = redeem
        .find(".redeem(this_canister_id, &args.token, now)")
        .expect("atomic redeem-to-receipt transition");
    assert!(caller_check < redeem_store && subject_check < redeem_store);
    assert!(redeem.contains("already_redeemed"));
    assert!(redeem.contains("success_result(&token)"));
    assert!(redeem.contains("app_user_key_version"));
    assert!(redeem.contains("app_user_key_fingerprint"));

    let model = read_repo_file("backend/canisters/user_index/impl/src/model/ai_app_chat_link_tokens.rs");
    assert!(model.contains("TOKEN_DIGEST_DOMAIN"));
    assert!(model.contains("MAX_OUTSTANDING_PER_USER"));
    assert!(model.contains("MAX_ISSUED_PER_USER_APP_WINDOW"));
    assert!(model.contains("redeemed_receipts"));
    assert!(model.contains("RECEIPT_RECOVERY_WINDOW_MS"));
    assert!(model.contains("MAX_RECEIPTS_PER_USER"));
    assert!(model.contains("MAX_RECEIPTS_PER_APP"));
    assert!(!model.contains("raw_token: Vec"));
}

#[test]
fn every_chat_kind_uses_an_authoritative_route_and_revalidates_after_awaits() {
    let group = read_repo_file("backend/canisters/group/impl/src/updates/create_ai_app_chat_link_token.rs");
    let community = read_repo_file("backend/canisters/community/impl/src/updates/create_ai_app_chat_link_token.rs");
    for source in [&group, &community] {
        assert!(source.contains("AiAppChatLinkAuthorityBindingV1"));
        assert!(!source.contains("AiAppCardContext"));
        assert!(source.contains("enabled_ai_apps.contains"));
        assert!(source.contains("get_calling_member(true)"));
        assert!(!source.contains("get_caller_user_id"));
        let local_prepare = source
            .find("mutate_state(|state| prepare(&args, state))")
            .expect("child-local admission must run in mutable state");
        let remote_issue = source
            .find("ai_app_chat_link_authority::issue")
            .expect("GroupIndex authority issue");
        assert!(
            local_prepare < remote_issue,
            "child-local admission must precede the first await"
        );
        assert!(source.contains(".ai_app_chat_link_admission"));
        assert!(source.contains(".reserve(user_id, args.app_id, state.env.now())"));
        assert!(source.contains("cancel_authority(&prepared).await"));
        assert!(source.contains("release_admission(&prepared)"));
        assert_eq!(source.matches("revalidate(&prepared, state)").count(), 2);
    }
    assert_eq!(group.matches("get_calling_member(true)").count(), 2);
    assert_eq!(community.matches("get_calling_member(true)").count(), 2);
    assert_eq!(
        community.matches("channel.chat.members.get_verified_member(user_id)").count(),
        2
    );

    let user = read_repo_file("backend/canisters/user/impl/src/updates/create_ai_app_chat_link_token.rs");
    assert!(user.contains("caller_is_owner"));
    assert!(user.contains("direct_chats.exists"));
    assert!(user.contains("revalidate(&prepared, state)"));

    let relay = read_repo_file("backend/canisters/local_user_index/impl/src/updates/c2c_create_ai_app_chat_link_token.rs");
    assert!(relay.contains("authoritative_child_registration"));
    assert!(relay.contains("current_registration != initial_registration"));
    assert!(relay.contains("canonical distinct participant pair"));
    assert!(relay.contains("requires dedicated route authority"));
}

#[test]
fn local_admission_precedes_remote_authority_and_every_post_mint_rejection_cleans_up() {
    let user_index = read_repo_file("backend/canisters/user_index/impl/src/updates/c2c_create_ai_app_chat_link_token.rs");
    let admission = user_index
        .find(".check_admission(args.user_id, args.app_id, now)")
        .expect("local admission check");
    let authority = user_index
        .find("crate::ai_app_chat_link_authority::consume")
        .expect("remote authority consumption");
    assert!(
        admission < authority,
        "local limits must reject before remote authority consumption"
    );

    let model = read_repo_file("backend/canisters/user_index/impl/src/model/ai_app_chat_link_tokens.rs");
    assert!(model.contains("self.check_admission(entry.user_id, entry.app_id, now)?"));
    assert!(model.contains("cancel_from_issuer"));
    assert!(model.contains("issuer_local_user_index_canister_id"));

    for endpoint in [
        "backend/canisters/group/impl/src/updates/create_ai_app_chat_link_token.rs",
        "backend/canisters/community/impl/src/updates/create_ai_app_chat_link_token.rs",
        "backend/canisters/user/impl/src/updates/create_ai_app_chat_link_token.rs",
    ] {
        let source = read_repo_file(endpoint);
        assert!(source.contains("cleanup_success(&prepared"));
        assert!(source.contains("c2c_cancel_ai_app_chat_link_token"));
    }
    let relay = read_repo_file("backend/canisters/local_user_index/impl/src/updates/c2c_create_ai_app_chat_link_token.rs");
    assert_eq!(
        relay
            .matches("cleanup_success(user_index_canister_id, &args, &result).await")
            .count(),
        2
    );
    assert!(relay.contains("user_index_canister_c2c_client::c2c_cancel_ai_app_chat_link_token"));

    let child_admission = read_repo_file("backend/libraries/group_community_common/src/ai_app_chat_link_admission.rs");
    assert!(child_admission.contains("MAX_CHAT_LINK_ATTEMPTS_PER_USER_APP_WINDOW"));
    assert!(child_admission.contains("MAX_CHAT_LINK_ATTEMPTS_PER_CHILD_WINDOW"));
    assert!(child_admission.contains("MAX_TRACKED_CHAT_LINK_ADMISSION_SUBJECTS"));
    assert!(child_admission.contains("pub fn is_current"));
    assert!(child_admission.contains("pub fn release"));

    let authority_cancel =
        read_repo_file("backend/canisters/group_index/impl/src/updates/c2c_cancel_ai_app_chat_link_authority_v1.rs");
    assert!(authority_cancel.contains("caller_is_group_or_community_canister"));
    assert!(authority_cancel.contains("caller_matches_chat"));
    let authority_cancel_compact: String = authority_cancel
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    assert!(authority_cancel_compact.contains(".ai_app_chat_link_authority.consume("));
    assert!(!authority_cancel.contains("resolve_route"));
}

#[test]
fn chat_link_manifest_accepts_only_one_fragment_token_and_no_other_surface_can_use_it() {
    let source = read_repo_file("backend/canisters/user_index/impl/src/updates/register_ai_app.rs");
    assert!(source.contains("token_count != 1"));
    assert!(source.contains("token <= fragment"));
    assert!(source.contains("token_count != 0"));
    assert!(source.contains("chat_link_requires_one_fragment_only_opaque_launch_token"));
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

fn method_args_record<'a>(candid: &'a str, method: &str) -> &'a str {
    let service = candid
        .split_once("service : {")
        .map(|(_, service)| service)
        .expect("Candid service block");
    let signature = service
        .lines()
        .find(|line| line.trim_start().starts_with(&format!("{method} :")))
        .unwrap_or_else(|| panic!("missing Candid method {method}"));
    let args_type = signature
        .split_once(": (")
        .and_then(|(_, args)| args.split_once(')'))
        .map(|(args, _)| args)
        .unwrap_or_else(|| panic!("missing args type for Candid method {method}"));
    type_block(candid, args_type)
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
        "c2c_create_ai_app_chat_link_token.rs",
        "c2c_cancel_ai_app_chat_link_token.rs",
        "c2c_redeem_ai_app_chat_link_token.rs",
        "cancel_ai_app_chat_link_token.rs",
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
        "backend/canisters/local_user_index/impl/src/updates/c2c_create_ai_app_chat_link_token.rs",
        "backend/canisters/local_user_index/impl/src/updates/c2c_cancel_ai_app_chat_link_token.rs",
        "backend/canisters/group_index/impl/src/updates/c2c_cancel_ai_app_chat_link_authority_v1.rs",
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
