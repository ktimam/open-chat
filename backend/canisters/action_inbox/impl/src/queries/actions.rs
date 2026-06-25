use crate::{RuntimeState, read_state};
use action_inbox_canister::actions::{Response::*, *};
use canister_api_macros::query;

#[query(candid = true, msgpack = true)]
fn actions(args: Args) -> Response {
    read_state(|state| actions_impl(args, state))
}

fn actions_impl(args: Args, state: &RuntimeState) -> Response {
    let actions =
        state
            .data
            .inbox
            .query(args.consumer_key_fingerprint.as_ref(), args.since_id, args.max_results as usize);
    Success(SuccessResult { actions })
}
