use crate::{RuntimeState, read_state};
use canister_api_macros::query;
use types::UserId;
use user_index_canister::my_ai_app_keys::{Response::*, *};

#[query(msgpack = true)]
fn my_ai_app_keys(_args: Args) -> Response {
    read_state(my_ai_app_keys_impl)
}

fn my_ai_app_keys_impl(state: &RuntimeState) -> Response {
    let caller = state.env.caller();
    // Caller resolution mirrors `register_ai_app`: a registered user's UserId when the caller is
    // one, otherwise (test_mode only) the caller principal itself. Anonymous/unknown callers simply
    // get an empty list.
    let user_id: Option<UserId> = state
        .data
        .users
        .get_by_principal(&caller)
        .map(|u| u.user_id)
        .or_else(|| state.data.test_mode.then(|| caller.into()));

    let keys = user_id
        .map(|u| state.data.ai_app_user_keys.keys_for_user(u))
        .unwrap_or_default();

    Success(SuccessResult { keys })
}
