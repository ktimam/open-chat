use crate::guards::caller_is_openchat_user_or_test_mode;
use crate::{RuntimeState, mutate_state};
use canister_api_macros::update;
use canister_tracing_macros::trace;
use types::UserId;
use user_index_canister::delete_ai_app::{Response::*, *};

// Exposed over candid as well as msgpack so that an external app can remove its manifest with a
// plain candid call from a deploy script.
#[update(guard = "caller_is_openchat_user_or_test_mode", candid = true, msgpack = true)]
#[trace]
fn delete_ai_app(args: Args) -> Response {
    mutate_state(|state| delete_ai_app_impl(args, state))
}

fn delete_ai_app_impl(args: Args, state: &mut RuntimeState) -> Response {
    let caller = state.env.caller();
    // Owner resolution mirrors `register_ai_app`: a registered user's UserId when the caller is
    // one, otherwise (test_mode only) the caller principal itself.
    let owner: UserId = if let Some(user) = state.data.users.get_by_principal(&caller) {
        user.user_id
    } else if state.data.test_mode {
        caller.into()
    } else {
        return NotFound;
    };

    if state.data.ai_apps.delete(owner, &args.name) { Success } else { NotFound }
}
