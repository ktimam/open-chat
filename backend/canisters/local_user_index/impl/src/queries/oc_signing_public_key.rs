use crate::{RuntimeState, read_state};
use canister_api_macros::query;
use canister_tracing_macros::trace;
use local_user_index_canister::oc_signing_public_key::{Response::*, *};

#[query(candid = true, msgpack = true)]
#[trace]
fn oc_signing_public_key(_args: Args) -> Response {
    read_state(oc_signing_public_key_impl)
}

fn oc_signing_public_key_impl(state: &RuntimeState) -> Response {
    Success(state.data.oc_key_pair.public_key_pem().to_string())
}
