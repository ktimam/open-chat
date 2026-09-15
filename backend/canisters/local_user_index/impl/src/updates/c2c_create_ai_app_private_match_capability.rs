use crate::action_deposit_envelope;
use crate::guards::caller_is_local_child_canister;
use crate::read_state;
use crate::updates::c2c_create_ai_app_card_capability::{
    authoritative_child_registration, validate_authoritative_child_context,
};
use canister_api_macros::update;
use local_user_index_canister::c2c_create_ai_app_private_match_capability::{Response::*, *};
use types::{AiAppCardContext, Chat};

#[update(guard = "caller_is_local_child_canister", msgpack = true)]
async fn c2c_create_ai_app_private_match_capability(args: Args) -> Response {
    if args.source_binding.iter().all(|byte| *byte == 0) {
        return InvalidSource;
    }
    if matches!(args.chat, Chat::Direct(_)) && !args.authority.is_empty() {
        return InvalidRequest("direct chat must not carry group route authority".to_string());
    }
    let caller = ic_cdk::api::msg_caller();
    let expected_user_id = args.user_id;
    let expected_chat = args.chat;
    let expected_member_user_ids = args.member_user_ids.clone();
    let caller_registration = read_state(|state| authoritative_child_registration(state, caller));
    if let Err(error) = validate_authoritative_child_context(
        args.user_id,
        args.chat,
        &args.member_user_ids,
        caller,
        caller_registration.kind,
    ) {
        return InvalidRequest(error);
    }
    let chat_key = match action_deposit_envelope::chat_key(&args.chat, &args.member_user_ids) {
        Ok(value) => value,
        Err(error) => return InvalidRequest(error),
    };
    let context = AiAppCardContext {
        user_id: args.user_id,
        chat: args.chat,
        chat_key,
        thread_root_message_index: args.thread_root_message_index,
        message_id: args.message_id,
        app_id: args.app_id,
        app_revision: args.app_revision,
        action_id: args.action_id,
    };
    let user_index_canister_id = read_state(|state| state.data.user_index_canister_id);
    match user_index_canister_c2c_client::c2c_create_ai_app_private_match_capability(
        user_index_canister_id,
        &user_index_canister::c2c_create_ai_app_private_match_capability::Args {
            context,
            source_binding: args.source_binding,
            recipient_key_scheme: args.recipient_key_scheme,
            recipient_public_key: args.recipient_public_key,
            authority: args.authority,
        },
    )
    .await
    {
        Ok(user_index_canister::c2c_create_ai_app_private_match_capability::Response::Success(result)) => {
            let current_registration = read_state(|state| authoritative_child_registration(state, caller));
            if current_registration != caller_registration {
                return InvalidRequest("local child registration changed while private match was created".to_string());
            }
            if let Err(error) = validate_authoritative_child_context(
                expected_user_id,
                expected_chat,
                &expected_member_user_ids,
                caller,
                current_registration.kind,
            ) {
                return InvalidRequest(error);
            }
            Success(SuccessResult {
                token: result.token,
                expires_at: result.expires_at,
                context: result.context,
            })
        }
        Ok(user_index_canister::c2c_create_ai_app_private_match_capability::Response::InvalidSource) => InvalidSource,
        Ok(user_index_canister::c2c_create_ai_app_private_match_capability::Response::AppUnavailable) => AppUnavailable,
        Ok(user_index_canister::c2c_create_ai_app_private_match_capability::Response::InvalidRequest(error)) => {
            InvalidRequest(error)
        }
        Ok(user_index_canister::c2c_create_ai_app_private_match_capability::Response::Error(_)) | Err(_) => {
            Error("AI-app private-match capability service unavailable".to_string())
        }
    }
}
