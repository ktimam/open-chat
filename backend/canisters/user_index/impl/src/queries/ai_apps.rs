use crate::{RuntimeState, read_state};
use canister_api_macros::query;
use user_index_canister::ai_apps::{Response::*, *};

#[query(candid = true, msgpack = true)]
fn ai_apps(_args: Args) -> Response {
    read_state(ai_apps_impl)
}

fn ai_apps_impl(state: &RuntimeState) -> Response {
    // Published apps for everyone, plus the caller's own unpublished ones. Caller resolution
    // mirrors register_ai_app: a registered user's UserId, else (test_mode only) the raw
    // principal — so a local deploy-script owner can still see its own pre-publish registration.
    let caller = state.env.caller();
    let user_id = state
        .data
        .users
        .get_by_principal(&caller)
        .map(|u| u.user_id)
        .or_else(|| state.data.test_mode.then(|| caller.into()));
    Success(SuccessResult {
        apps: state.data.ai_apps.list_visible(user_id),
    })
}
