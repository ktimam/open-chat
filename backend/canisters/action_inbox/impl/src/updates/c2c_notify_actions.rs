use crate::guards::caller_is_authorized_depositor;
use crate::{RuntimeState, mutate_state};
use action_inbox_canister::c2c_notify_actions::{Response::*, *};
use canister_api_macros::update;
use canister_tracing_macros::trace;

#[update(guard = "caller_is_authorized_depositor", msgpack = true)]
#[trace]
fn c2c_notify_actions(args: Args) -> Response {
    mutate_state(|state| c2c_notify_actions_impl(args, state))
}

fn c2c_notify_actions_impl(args: Args, state: &mut RuntimeState) -> Response {
    for deposit in args.deposits {
        state.data.inbox.deposit(
            deposit.consumer_key_fingerprint.into_vec(),
            deposit.idempotency_id,
            deposit.ephemeral_public_key,
            deposit.ciphertext,
            deposit.oc_signature,
            deposit.created_at,
        );
    }
    Success
}
