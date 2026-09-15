use crate::guards::caller_is_local_user_index_canister;
use crate::model::ai_app_chat_link_tokens::TOKEN_BYTES;
use crate::mutate_state;
use canister_api_macros::update;
use user_index_canister::c2c_cancel_ai_app_chat_link_token::{Response::*, *};

// This exact-bearer endpoint must never be traced.
#[update(guard = "caller_is_local_user_index_canister", msgpack = true)]
fn c2c_cancel_ai_app_chat_link_token(args: Args) -> Response {
    if args.token.len() != TOKEN_BYTES {
        return InvalidRequest(format!("token must contain exactly {TOKEN_BYTES} bytes"));
    }
    let issuer_local_user_index_canister_id = ic_cdk::api::msg_caller();
    mutate_state(|state| {
        state.data.ai_app_chat_link_tokens.cancel_from_issuer(
            state.env.canister_id(),
            &args.token,
            issuer_local_user_index_canister_id,
            args.user_id,
            args.chat,
            args.app_id,
            args.app_revision,
            state.env.now(),
        );
    });
    Success
}
