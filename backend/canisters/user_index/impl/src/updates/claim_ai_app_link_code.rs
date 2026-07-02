use crate::model::ai_app_link_codes::ClaimLinkCodeResult;
use crate::updates::set_my_ai_app_key::validate_user_public_key;
use crate::{RuntimeState, mutate_state};
use canister_api_macros::update;
use canister_tracing_macros::trace;
use user_index_canister::claim_ai_app_link_code::{Response::*, *};

// Deliberately NO caller guard, and exposed over candid as well as msgpack: an external app calls
// this on the user's behalf with whatever principal it has (often not an OpenChat user). The
// single-use, short-lived link code carried in the args IS the authorization — it is validated and
// consumed atomically in the body, so possession of an unexpired code is both necessary and
// sufficient (bearer semantics), and the matching inspect_message arm accepts the call unconditionally.
// TODO(rate-limit): upstream should consider throttling failed claims (per caller and/or globally)
// to make brute-forcing the 1M-code space within a code's 10-minute TTL even less practical.
#[update(candid = true, msgpack = true)]
#[trace]
fn claim_ai_app_link_code(args: Args) -> Response {
    mutate_state(|state| claim_ai_app_link_code_impl(args, state))
}

fn claim_ai_app_link_code_impl(args: Args, state: &mut RuntimeState) -> Response {
    // Validate the key before touching the code so an invalid request doesn't burn the code.
    if let Err(message) = validate_user_public_key(&args.public_key) {
        return InvalidRequest(message);
    }

    let now = state.env.now();
    match state.data.ai_app_link_codes.claim(&args.code, now) {
        ClaimLinkCodeResult::Valid(link) => {
            // Same store `set_my_ai_app_key` writes to, keyed by the code's (user, app) pair.
            state.data.ai_app_user_keys.set(link.user_id, link.app_id, args.public_key);
            Success
        }
        ClaimLinkCodeResult::Expired => CodeExpired,
        ClaimLinkCodeResult::NotFound => CodeNotFound,
    }
}
