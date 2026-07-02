use crate::{RuntimeState, execute_update};
use canister_api_macros::update;
use canister_tracing_macros::trace;
use group_canister::set_ai_app_enabled::*;

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
        Err(_) => return Response::UserNotInGroup,
    };

    if !member.role().is_owner() && !member.role().is_admin() {
        return Response::NotAuthorized;
    }

    // The group deliberately does NOT validate that `app_id` refers to a registered AI app: the
    // client only offers real apps (from the user_index AI-app directory) when toggling, and a
    // dangling id is harmless — it simply never matches an app when the client intersects this
    // set with the directory.
    if args.enabled {
        state.data.enabled_ai_apps.insert(args.app_id);
    } else {
        state.data.enabled_ai_apps.remove(&args.app_id);
    }

    Response::Success
}
