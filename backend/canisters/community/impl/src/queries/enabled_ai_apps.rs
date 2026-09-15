use crate::{RuntimeState, read_state};
use canister_api_macros::query;
use community_canister::enabled_ai_apps::{Response::*, *};

#[query(msgpack = true)]
fn enabled_ai_apps(args: Args) -> Response {
    read_state(|state| enabled_ai_apps_impl(args, state))
}

fn enabled_ai_apps_impl(args: Args, state: &RuntimeState) -> Response {
    // Same access gate as the group canister's query: anyone who can see the community can read
    // which apps a channel has enabled.
    if let Err(error) = state.data.verify_is_accessible(state.env.caller(), None) {
        return Error(error.into());
    }

    let channel = match state.data.channels.get_or_err(&args.channel_id) {
        Ok(channel) => channel,
        Err(error) => return Error(error.into()),
    };

    Success(SuccessResult {
        app_ids: channel.enabled_ai_apps.iter().copied().collect(),
    })
}
