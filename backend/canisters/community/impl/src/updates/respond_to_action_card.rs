use crate::activity_notifications::handle_activity_notification;
use crate::{RuntimeState, execute_update};
use canister_api_macros::update;
use canister_tracing_macros::trace;
use community_canister::respond_to_action_card::{Response::*, *};
use types::{ActionCardState, OCResult};

#[update(msgpack = true)]
#[trace]
fn respond_to_action_card(args: Args) -> Response {
    match execute_update(|state| respond_to_action_card_impl(args, state)) {
        Ok(state) => Success(state),
        Err(error) => Error(error),
    }
}

fn respond_to_action_card_impl(args: Args, state: &mut RuntimeState) -> OCResult<ActionCardState> {
    state.data.verify_not_frozen()?;

    let member = state.get_calling_member(true)?;
    let channel = state.data.channels.get_mut_or_err(&args.channel_id)?;
    let user_id = member.user_id;
    let now = state.env.now();

    let result = channel.chat.respond_to_action_card(
        user_id,
        args.thread_root_message_index,
        args.message_id,
        args.response,
        now,
    )?;

    state.push_bot_notification(result.bot_notification);
    handle_activity_notification(state);

    Ok(result.value)
}
