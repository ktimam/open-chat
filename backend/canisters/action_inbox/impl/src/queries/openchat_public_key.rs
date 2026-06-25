use crate::{RuntimeState, read_state};
use action_inbox_canister::openchat_public_key::{Response::*, *};
use canister_api_macros::query;

#[query(candid = true, msgpack = true)]
fn openchat_public_key(_args: Args) -> Response {
    read_state(openchat_public_key_impl)
}

fn openchat_public_key_impl(state: &RuntimeState) -> Response {
    Success(state.data.oc_signing_public_key_pem.clone())
}
