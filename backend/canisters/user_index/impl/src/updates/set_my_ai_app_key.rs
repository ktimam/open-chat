use crate::guards::caller_is_openchat_user_or_test_mode;
use crate::{RuntimeState, mutate_state};
use canister_api_macros::update;
use canister_tracing_macros::trace;
use types::UserId;
use user_index_canister::set_my_ai_app_key::{Response::*, *};

#[update(guard = "caller_is_openchat_user_or_test_mode", msgpack = true)]
#[trace]
fn set_my_ai_app_key(args: Args) -> Response {
    mutate_state(|state| set_my_ai_app_key_impl(args, state))
}

fn set_my_ai_app_key_impl(args: Args, state: &mut RuntimeState) -> Response {
    let caller = state.env.caller();
    // Caller resolution mirrors `register_ai_app`: a registered user's UserId when the caller is
    // one, otherwise (test_mode only) the caller principal itself.
    let user_id: UserId = if let Some(user) = state.data.users.get_by_principal(&caller) {
        user.user_id
    } else if state.data.test_mode {
        caller.into()
    } else {
        return InvalidRequest("caller is not a registered user".to_string());
    };

    if let Err(message) = validate_user_public_key(&args.public_key) {
        return InvalidRequest(message);
    }

    if !state.data.ai_apps.contains(args.app_id) {
        return AppNotFound;
    }

    state.data.ai_app_user_keys.set(user_id, args.app_id, args.public_key);
    Success
}

const MAX_PUBLIC_KEY_LENGTH: usize = 2000;

// Same rules the app-level `consumer_public_key` is validated against in `register_ai_app`; also
// reused by `claim_ai_app_link_code` (the other write path into the per-user key store).
pub(crate) fn validate_user_public_key(public_key: &str) -> Result<(), String> {
    let key_length = public_key.chars().count();
    if key_length == 0 || key_length > MAX_PUBLIC_KEY_LENGTH {
        return Err(format!("public_key must be between 1 and {MAX_PUBLIC_KEY_LENGTH} characters"));
    }
    if !public_key.contains("BEGIN PUBLIC KEY") {
        return Err("public_key must be a PEM encoded public key".to_string());
    }
    Ok(())
}
