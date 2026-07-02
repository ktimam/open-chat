use crate::guards::caller_is_openchat_user_or_test_mode;
use crate::{RuntimeState, mutate_state};
use canister_api_macros::update;
use canister_tracing_macros::trace;
use constants::MINUTE_IN_MS;
use oc_error_codes::OCErrorCode;
use rand::Rng;
use types::{Milliseconds, UserId};
use user_index_canister::create_ai_app_link_code::{Response::*, *};

const LINK_CODE_TTL: Milliseconds = 10 * MINUTE_IN_MS;
const MAX_CODE_GENERATION_ATTEMPTS: usize = 10;

#[update(guard = "caller_is_openchat_user_or_test_mode", msgpack = true)]
#[trace]
fn create_ai_app_link_code(args: Args) -> Response {
    mutate_state(|state| create_ai_app_link_code_impl(args, state))
}

fn create_ai_app_link_code_impl(args: Args, state: &mut RuntimeState) -> Response {
    let caller = state.env.caller();
    // Caller resolution mirrors `register_ai_app`: a registered user's UserId when the caller is
    // one, otherwise (test_mode only) the caller principal itself.
    let user_id: UserId = if let Some(user) = state.data.users.get_by_principal(&caller) {
        user.user_id
    } else if state.data.test_mode {
        caller.into()
    } else {
        return Error(OCErrorCode::InitiatorNotFound.into());
    };

    if !state.data.ai_apps.contains(args.app_id) {
        return AppNotFound;
    }

    // 6 random digits from the canister's seeded rng, retried for uniqueness against the
    // outstanding codes (mirrors `register_bot::generate_random_user_id`).
    let Some(code) = generate_unique_code(state) else {
        return Error(OCErrorCode::Impossible.with_message("can't generate unique link code"));
    };

    let now = state.env.now();
    let expires_at = now + LINK_CODE_TTL;
    // Creating a new code for the same (user, app) pair replaces the old one.
    state
        .data
        .ai_app_link_codes
        .insert(code.clone(), user_id, args.app_id, expires_at, now);

    Success(SuccessResult { code, expires_at })
}

fn generate_unique_code(state: &mut RuntimeState) -> Option<String> {
    for _ in 0..MAX_CODE_GENERATION_ATTEMPTS {
        let code = format!("{:06}", state.env.rng().gen_range(0..1_000_000u32));
        if !state.data.ai_app_link_codes.contains(&code) {
            return Some(code);
        }
    }
    None
}
