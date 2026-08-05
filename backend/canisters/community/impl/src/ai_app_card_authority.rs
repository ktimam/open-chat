use group_index_canister::ai_app_card_authority::AiAppCardAuthorityBindingV1;
use group_index_canister::c2c_issue_ai_app_card_authority_v1::{Response, *};
use oc_error_codes::{OCError, OCErrorCode};
use serde_bytes::ByteBuf;
use types::CanisterId;

pub async fn issue(group_index_canister_id: CanisterId, binding: AiAppCardAuthorityBindingV1) -> Result<ByteBuf, OCError> {
    match group_index_canister_c2c_client::c2c_issue_ai_app_card_authority_v1(group_index_canister_id, &Args { binding }).await
    {
        Ok(Response::Success(result)) => Ok(result.token),
        Ok(Response::InvalidRoute) => Err(OCErrorCode::InitiatorNotAuthorized.with_message("card authority route is invalid")),
        Ok(Response::InvalidRequest(error)) => Err(OCErrorCode::InvalidRequest.with_message(error)),
        Ok(Response::CapacityExceeded) => Err(OCErrorCode::Throttled.with_message("card authority capacity exceeded")),
        Ok(Response::EntropyUnavailable) => {
            Err(OCErrorCode::C2CError.with_message("card authority service temporarily unavailable"))
        }
        Err(_) => Err(OCErrorCode::C2CError.with_message("card authority service unavailable")),
    }
}
