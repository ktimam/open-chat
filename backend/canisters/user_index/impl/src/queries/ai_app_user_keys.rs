use crate::{RuntimeState, read_state};
use canister_api_macros::query;
use user_index_canister::ai_app_user_keys::{Response::*, *};

// Fan-out key lookup (see the api-side doc): registered per-user delivery keys for the requested
// users + app. PUBLIC key material only — the same PEMs delivery already encrypts to — so exposing
// them to other (authenticated-or-not) users grants no decryption power; the request is bounded to
// keep the lookup cheap.
const MAX_USERS_PER_LOOKUP: usize = 32;

#[query(msgpack = true)]
fn ai_app_user_keys(args: Args) -> Response {
    read_state(|state| ai_app_user_keys_impl(args, state))
}

fn ai_app_user_keys_impl(args: Args, state: &RuntimeState) -> Response {
    let mut user_ids = args.user_ids;
    user_ids.truncate(MAX_USERS_PER_LOOKUP);
    let keys = state.data.ai_app_user_keys.keys_for_users(args.app_id, &user_ids);
    Success(SuccessResult { keys })
}
