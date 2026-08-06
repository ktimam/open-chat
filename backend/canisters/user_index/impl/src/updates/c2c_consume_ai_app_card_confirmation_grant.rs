use crate::guards::caller_is_local_user_index_canister;
use crate::model::ai_app_card_tokens::{LookupConfirmationGrantResult, TOKEN_BYTES};
use crate::updates::c2c_create_ai_app_card_confirmation_grant::current_user_key_binding;
use crate::updates::c2c_redeem_ai_app_card_capability::app_user_key_binding_matches;
use crate::updates::create_ai_app_card_provenance::{canonical_non_direct_chat_key, resolve_current_card_app};
use crate::{mutate_state, read_state};
use canister_api_macros::update;
use user_index_canister::c2c_consume_ai_app_card_confirmation_grant::{Response::*, *};

#[update(guard = "caller_is_local_user_index_canister", msgpack = true)]
async fn c2c_consume_ai_app_card_confirmation_grant(args: Args) -> Response {
    if args.confirmation_lease_generation == 0 {
        return InvalidRequest("invalid confirmation lease generation".to_string());
    }
    if !read_state(crate::pr2_entropy::is_ready) {
        return InvalidRequest("confirmation grant service temporarily unavailable".to_string());
    }
    let binding = group_index_canister::ai_app_card_authority::AiAppCardAuthorityBindingV1 {
        local_user_index_canister_id: ic_cdk::api::msg_caller(),
        context: args.context.clone(),
        content_hash: args.content_hash,
        operation: group_index_canister::ai_app_card_authority::AiAppCardAuthorityOperationV1::ConsumeConfirmationGrant {
            confirm_payload_hash: args.confirm_payload_hash,
            confirmation_grant_hash: group_index_canister::ai_app_card_authority::opaque_hash_v1(
                group_index_canister::ai_app_card_authority::OpaqueHashPurposeV1::ConfirmationGrant,
                &args.grant,
            ),
            confirmation_lease_generation: args.confirmation_lease_generation,
        },
    };
    if crate::ai_app_card_authority::consume(binding, &args.authority).await.is_err() {
        return InvalidRequest("invalid or replayed card authority".to_string());
    }
    mutate_state(|state| {
        if !crate::pr2_entropy::is_ready(state) {
            return InvalidRequest("confirmation grant service temporarily unavailable".to_string());
        }
        if args.grant.len() != TOKEN_BYTES {
            return InvalidRequest(format!("grant must contain exactly {TOKEN_BYTES} bytes"));
        }
        let Ok(chat_key) = canonical_non_direct_chat_key(args.context.chat) else {
            return InvalidRequest("confirmation grants are unavailable in direct chats".to_string());
        };
        if chat_key != args.context.chat_key {
            return InvalidRequest("non-canonical chat key".to_string());
        }
        let now = state.env.now();
        let grant = match state
            .data
            .ai_app_card_tokens
            .lookup_confirmation_grant(state.env.canister_id(), &args.grant, now)
        {
            LookupConfirmationGrantResult::Valid(grant) => grant,
            LookupConfirmationGrantResult::Expired => return Expired,
            LookupConfirmationGrantResult::NotFound => return NotFound,
        };
        if grant.context != args.context
            || grant.content_hash != args.content_hash
            || grant.confirm_payload_hash != args.confirm_payload_hash
        {
            return InvalidRequest("confirmation grant binding does not match the card and payload".to_string());
        }
        let Some(app) = resolve_current_card_app(
            &state.data.ai_apps,
            grant.context.app_id,
            grant.context.app_revision,
            &grant.context.action_id,
        ) else {
            return AppUnavailable;
        };
        if app.manifest.app_canister_id != Some(grant.app_canister_id) {
            return AppUnavailable;
        }
        let Ok((current_fingerprint, current_version)) = current_user_key_binding(state, app, &grant.context) else {
            return AppUnavailable;
        };
        if !app_user_key_binding_matches(
            app.manifest.per_user_keys,
            grant.app_user_key_fingerprint,
            grant.app_user_key_version,
            current_fingerprint,
            current_version,
        ) {
            return AppUnavailable;
        }
        if !state
            .data
            .ai_app_card_tokens
            .consume_confirmation_grant(state.env.canister_id(), &args.grant)
        {
            return NotFound;
        }
        Success
    })
}
