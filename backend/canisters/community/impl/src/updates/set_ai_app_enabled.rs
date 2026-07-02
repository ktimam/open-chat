use crate::{RuntimeState, execute_update};
use canister_api_macros::update;
use canister_tracing_macros::trace;
use community_canister::set_ai_app_enabled::*;

#[update(candid = true, msgpack = true)]
#[trace]
fn set_ai_app_enabled(args: Args) -> Response {
    execute_update(|state| set_ai_app_enabled_impl(args, state))
}

fn set_ai_app_enabled_impl(args: Args, state: &mut RuntimeState) -> Response {
    if let Err(error) = state.data.verify_not_frozen() {
        return Response::Error(error.into());
    }

    let member = match state.get_calling_member(true) {
        Ok(member) => member,
        Err(_) => return Response::UserNotInCommunity,
    };

    // Two-level gate (the delete_channel pattern): a community owner/admin may manage any
    // channel's apps whether or not they joined the channel; anyone else needs a channel
    // owner/admin role.
    let community_role_ok = member.role().is_owner() || member.role().is_admin();
    let user_id = member.user_id;

    let Some(channel) = state.data.channels.get_mut(&args.channel_id) else {
        return Response::ChannelNotFound;
    };

    if !community_role_ok {
        let Ok(channel_member) = channel.chat.members.get_verified_member(user_id) else {
            return Response::NotAuthorized;
        };
        if !channel_member.role().is_owner() && !channel_member.role().is_admin() {
            return Response::NotAuthorized;
        }
    }

    // Same as the group canister: ids only, deliberately not validated against the user_index
    // directory — a dangling id never matches an app when the client intersects this set with it.
    if args.enabled {
        channel.enabled_ai_apps.insert(args.app_id);
    } else {
        channel.enabled_ai_apps.remove(&args.app_id);
    }

    Response::Success
}
