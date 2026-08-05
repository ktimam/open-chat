use crate::guards::caller_is_local_user_index_canister;
use crate::{RuntimeState, read_state};
use canister_api_macros::query;
use user_index_canister::ai_app_user_keys::{Response::*, *};

// Guarded fan-out lookup (see the API-side doc): registered delivery keys for requested users/app.
// Only a local_user_index canister can call it, and the bounded result is used during confirmation.
const MAX_USERS_PER_LOOKUP: usize = 8;

#[query(guard = "caller_is_local_user_index_canister", msgpack = true)]
fn ai_app_user_keys(args: Args) -> Response {
    read_state(|state| ai_app_user_keys_impl(args, state))
}

fn ai_app_user_keys_impl(args: Args, state: &RuntimeState) -> Response {
    let user_ids: Vec<_> = args.user_ids.into_iter().take(MAX_USERS_PER_LOOKUP).collect();
    let keys = state
        .data
        .ai_app_user_keys
        .keys_for_users(args.app_id, &user_ids)
        .unwrap_or_else(|error| ic_cdk::trap(&error.message()));
    Success(SuccessResult { keys })
}
