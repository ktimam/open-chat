use crate::read_state;
use canister_api_macros::query;
use local_user_index_canister::action_inbox_canister::{Response::*, *};

#[query(candid = true, msgpack = true)]
fn action_inbox_canister(_args: Args) -> Response {
    read_state(|state| Success(state.data.action_inbox_canister_id))
}
