use crate::guards::caller_is_openchat_user_or_test_mode;
use crate::{RuntimeState, mutate_state};
use canister_api_macros::update;
use canister_tracing_macros::trace;
use types::UserId;
use user_index_canister::remove_my_ai_app_key::{Response::*, *};

// A user removing their OWN per-app delivery key — the OpenChat side of a one-sided "disconnect".
// After this, confirmed actions from this user are no longer encrypted+delivered to the app (the
// app's registration is untouched; other users are unaffected). msgpack-only, mirroring
// set_my_ai_app_key. No key material is supplied — removal needs none, so the E2E invariant holds.
#[update(guard = "caller_is_openchat_user_or_test_mode", msgpack = true)]
#[trace]
fn remove_my_ai_app_key(args: Args) -> Response {
    mutate_state(|state| remove_my_ai_app_key_impl(args, state))
}

fn remove_my_ai_app_key_impl(args: Args, state: &mut RuntimeState) -> Response {
    let caller = state.env.caller();
    // Caller resolution mirrors set_my_ai_app_key: a registered user's UserId, else (test_mode
    // only) the caller principal itself.
    let user_id: UserId = if let Some(user) = state.data.users.get_by_principal(&caller) {
        user.user_id
    } else if state.data.test_mode {
        caller.into()
    } else {
        return InvalidRequest("caller is not a registered user".to_string());
    };

    // Idempotent: removing an absent key is still a successful disconnect.
    state.data.ai_app_user_keys.remove(user_id, args.app_id);
    Success
}
