use crate::{RuntimeState, read_state};
use canister_api_macros::query;
use user_index_canister::ai_actions::{Response::*, *};

#[query(msgpack = true)]
fn ai_actions(_args: Args) -> Response {
    read_state(ai_actions_impl)
}

fn ai_actions_impl(state: &RuntimeState) -> Response {
    Success(SuccessResult {
        actions: state.data.ai_actions.list(),
    })
}
