use crate::guards::caller_is_governance_principal;
use crate::{RuntimeState, mutate_state};
use canister_api_macros::{proposal, update};
use canister_tracing_macros::trace;
use user_index_canister::publish_ai_app::{Args, Response};

// Publishing makes a registered AI app visible in the directory/explorer for everyone (a new
// registration is private to its owner). Gated like publish_bot: an SNS proposal in production,
// open in test_mode so local deploys can self-publish. Candid-exposed as well as msgpack because
// external apps' deploy scripts drive registration+publication over plain candid.
#[proposal(guard = "caller_is_governance_principal")]
#[trace]
fn publish_ai_app(args: Args) -> Response {
    mutate_state(|state| publish_ai_app_impl(args, state))
}

#[update(msgpack = true)]
#[trace]
fn publish_ai_app(args: Args) -> Response {
    mutate_state(
        |state| {
            if state.data.test_mode { publish_ai_app_impl(args, state) } else { Response::NotAuthorised }
        },
    )
}

fn publish_ai_app_impl(args: Args, state: &mut RuntimeState) -> Response {
    // Unlike bots there is no per-LUI replication to notify — clients query the registry directly.
    if state.data.ai_apps.publish(args.app_id, state.env.now()) { Response::Success } else { Response::NotFound }
}
