use group_index_canister::ai_app_chat_link_authority::AiAppChatLinkAuthorityBindingV1;
use group_index_canister::c2c_issue_ai_app_chat_link_authority_v1::{Args, Response};
use oc_error_codes::{OCError, OCErrorCode};
use serde_bytes::ByteBuf;
use types::CanisterId;

pub async fn issue(group_index_canister_id: CanisterId, binding: AiAppChatLinkAuthorityBindingV1) -> Result<ByteBuf, OCError> {
    let response =
        group_index_canister_c2c_client::c2c_issue_ai_app_chat_link_authority_v1(group_index_canister_id, &Args { binding })
            .await
            .map_err(|_| OCErrorCode::C2CError.with_message("chat-link authority service unavailable"))?;
    map_response(response)
}

pub async fn cancel(group_index_canister_id: CanisterId, binding: AiAppChatLinkAuthorityBindingV1, token: &ByteBuf) {
    let _ = group_index_canister_c2c_client::c2c_cancel_ai_app_chat_link_authority_v1(
        group_index_canister_id,
        &group_index_canister::c2c_cancel_ai_app_chat_link_authority_v1::Args {
            binding,
            token: token.clone(),
        },
    )
    .await;
}

fn map_response(response: Response) -> Result<ByteBuf, OCError> {
    match response {
        Response::Success(result) => Ok(result.token),
        Response::InvalidRoute => Err(OCErrorCode::InitiatorNotAuthorized.with_message("chat-link authority route invalid")),
        Response::InvalidRequest(error) => Err(OCErrorCode::InvalidRequest.with_message(error)),
        Response::CapacityExceeded => Err(OCErrorCode::Throttled.with_message("chat-link authority capacity exceeded")),
        Response::EntropyUnavailable => Err(OCErrorCode::C2CError.with_message("chat-link authority entropy unavailable")),
    }
}
