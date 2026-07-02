use crate::{RuntimeState, read_state};
use canister_api_macros::query;
use user_index_canister::ai_apps::{Response::*, *};

#[query(candid = true, msgpack = true)]
fn ai_apps(_args: Args) -> Response {
    read_state(ai_apps_impl)
}

fn ai_apps_impl(state: &RuntimeState) -> Response {
    Success(SuccessResult {
        apps: state.data.ai_apps.list(),
    })
}
