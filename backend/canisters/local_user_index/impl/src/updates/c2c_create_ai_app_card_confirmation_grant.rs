use crate::action_deposit_envelope;
use crate::guards::caller_is_local_child_canister;
use crate::read_state;
use crate::updates::c2c_create_ai_app_card_capability::{
    authoritative_child_registration, validate_authoritative_child_context,
};
use canister_api_macros::update;
use local_user_index_canister::c2c_create_ai_app_card_confirmation_grant::{Response::*, *};
use types::AiAppCardContext;

#[update(guard = "caller_is_local_child_canister", msgpack = true)]
async fn c2c_create_ai_app_card_confirmation_grant(args: Args) -> Response {
    if matches!(args.chat, types::Chat::Direct(_)) && !args.authority.is_empty() {
        return InvalidRequest("direct chat must not carry group route authority".to_string());
    }
    if args.confirm_payload.is_empty() || args.confirm_payload.len() > types::MAX_AI_APP_CONFIRM_PAYLOAD_BYTES {
        return InvalidRequest(format!(
            "confirmation payload must contain 1..={} bytes",
            types::MAX_AI_APP_CONFIRM_PAYLOAD_BYTES
        ));
    }
    let caller = ic_cdk::api::msg_caller();
    let caller_registration = read_state(|state| authoritative_child_registration(state, caller));
    let expected_user_id = args.user_id;
    let expected_chat = args.chat;
    let expected_members = args.member_user_ids.clone();
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
    let result = user_index_canister_c2c_client::c2c_create_ai_app_card_confirmation_grant(
        read_state(|state| state.data.user_index_canister_id),
        &user_index_canister::c2c_create_ai_app_card_confirmation_grant::Args {
            context,
            content_hash: args.content_hash,
            confirm_payload: args.confirm_payload,
            authority: args.authority,
        },
    )
    .await;
    let current_registration = read_state(|state| authoritative_child_registration(state, caller));
    if current_registration != caller_registration {
        return InvalidRequest("local child registration changed while confirmation grant was created".to_string());
    }
    if let Err(error) = validate_authoritative_child_context(
        expected_user_id,
        expected_chat,
        &expected_members,
        caller,
        current_registration.kind,
    ) {
        return InvalidRequest(error);
    }
    match result {
        Ok(user_index_canister::c2c_create_ai_app_card_confirmation_grant::Response::Success(result)) => {
            Success(SuccessResult {
                grant: result.grant,
                expires_at: result.expires_at,
            })
        }
        Ok(user_index_canister::c2c_create_ai_app_card_confirmation_grant::Response::InvalidProvenance) => InvalidProvenance,
        Ok(user_index_canister::c2c_create_ai_app_card_confirmation_grant::Response::AppUnavailable) => AppUnavailable,
        Ok(user_index_canister::c2c_create_ai_app_card_confirmation_grant::Response::InvalidRequest(error)) => {
            InvalidRequest(error)
        }
        Ok(user_index_canister::c2c_create_ai_app_card_confirmation_grant::Response::Error(_)) | Err(_) => {
            Error("confirmation grant service unavailable".to_string())
        }
    }
}
