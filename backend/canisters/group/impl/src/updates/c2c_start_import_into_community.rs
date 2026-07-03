use crate::guards::caller_is_group_index_or_local_user_index;
use crate::{CommunityBeingImportedInto, RuntimeState, execute_update};
use canister_api_macros::update;
use canister_tracing_macros::trace;
use group_canister::c2c_start_import_into_community::{Response::*, *};
use oc_error_codes::OCErrorCode;
use types::OCResult;

#[update(guard = "caller_is_group_index_or_local_user_index", msgpack = true)]
#[trace]
fn c2c_start_import_into_community(args: Args) -> Response {
    match execute_update(|state| c2c_start_import_into_community_impl(args, state)) {
        Ok(result) => Success(result),
        Err(error) => Error(error),
    }
}

fn c2c_start_import_into_community_impl(args: Args, state: &mut RuntimeState) -> OCResult<SuccessResult> {
    if args.user_id != state.data.proposals_bot_user_id {
        let member = state.data.chat.members.get_verified_member(args.user_id)?;
        if !member.role().is_owner() {
            return Err(OCErrorCode::InitiatorNotAuthorized.into());
        }
    }

    // Snapshot the enabled AI apps before the import freezes the group, so the
    // imported channel can inherit them (freeze doesn't clear the set).
    let enabled_ai_apps = state.data.enabled_ai_apps.clone();
    state
        .start_importing_into_community(CommunityBeingImportedInto::Existing(args.community_id))
        .map(|result| SuccessResult {
            total_bytes: result.total_bytes,
            enabled_ai_apps,
        })
}
