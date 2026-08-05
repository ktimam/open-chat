use crate::guards::caller_is_platform_operator_or_test_mode;
use crate::mutate_state;
use canister_api_macros::update;
use canister_tracing_macros::trace;
use local_user_index_canister::set_action_inbox_canister::{Response::*, *};

// Configures the action_inbox canister that confirmed-action deposits are forwarded to.
#[update(guard = "caller_is_platform_operator_or_test_mode", candid = true, msgpack = true)]
#[trace]
fn set_action_inbox_canister(args: Args) -> Response {
    mutate_state(|state| state.data.action_inbox_canister_id = Some(args.canister_id));
    Success
}
