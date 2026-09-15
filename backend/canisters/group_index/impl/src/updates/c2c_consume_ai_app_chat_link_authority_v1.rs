use crate::guards::caller_is_user_index_canister;
use crate::model::ai_app_chat_link_authority::ConsumeResult;
use crate::updates::c2c_issue_ai_app_chat_link_authority_v1::{resolve_route, validate_binding_shape};
use crate::{RuntimeState, mutate_state};
use canister_api_macros::update;
use group_index_canister::ai_app_chat_link_authority::AI_APP_CHAT_LINK_AUTHORITY_TOKEN_BYTES;
use group_index_canister::c2c_consume_ai_app_chat_link_authority_v1::{Response::*, *};

#[update(guard = "caller_is_user_index_canister", msgpack = true)]
fn c2c_consume_ai_app_chat_link_authority_v1(args: Args) -> Response {
    mutate_state(|state| consume(args, state))
}

fn consume(args: Args, state: &mut RuntimeState) -> Response {
    if args.token.len() != AI_APP_CHAT_LINK_AUTHORITY_TOKEN_BYTES {
        return InvalidRequest(format!(
            "authority token must contain exactly {AI_APP_CHAT_LINK_AUTHORITY_TOKEN_BYTES} bytes"
        ));
    }
    if let Err(error) = validate_binding_shape(&args.binding) {
        return InvalidRequest(error);
    }
    if resolve_route(&args.binding, None, state).is_none() {
        return InvalidRoute;
    }
    match state
        .data
        .ai_app_chat_link_authority
        .consume(state.env.canister_id(), &args.token, &args.binding, state.env.now())
    {
        ConsumeResult::Valid => Success(SuccessResult { binding: args.binding }),
        ConsumeResult::NotFound => NotFound,
        ConsumeResult::Expired => Expired,
        ConsumeResult::BindingMismatch => BindingMismatch,
    }
}
