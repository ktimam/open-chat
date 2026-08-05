use crate::{RuntimeState, execute_update_async, mutate_state, read_state};
use canister_api_macros::update;
use canister_tracing_macros::trace;
use group_canister::set_ai_app_enabled::*;
use group_community_common::{
    MAX_ENABLED_AI_APPS_PER_CHAT, ReconcileEnabledAiAppsError, reconcile_and_enable_ai_app,
    set_ai_app_enabled as apply_ai_app_enabled,
};
use oc_error_codes::OCErrorCode;
use std::collections::BTreeSet;
use types::{AiAppId, CanisterId};

const _: () = assert!(user_index_canister::c2c_published_ai_app_ids::MAX_APP_IDS == MAX_ENABLED_AI_APPS_PER_CHAT + 1);

#[update(candid = true, msgpack = true)]
#[trace]
async fn set_ai_app_enabled(args: Args) -> Response {
    execute_update_async(|| set_ai_app_enabled_impl(args)).await
}

async fn set_ai_app_enabled_impl(args: Args) -> Response {
    // Disabling is always local and available, including for an app that was deleted or while the
    // directory is unavailable.
    if !args.enabled {
        return mutate_state(|state| disable_ai_app(args.app_id, state));
    }

    let prepared = match read_state(|state| prepare_enable(args.app_id, state)) {
        Ok(prepared) => prepared,
        Err(response) => return response,
    };
    let response = user_index_canister_c2c_client::c2c_published_ai_app_ids(
        prepared.user_index_canister_id,
        &user_index_canister::c2c_published_ai_app_ids::Args {
            app_ids: prepared.checked_app_ids.iter().copied().collect(),
        },
    )
    .await;
    let published_app_ids = match response {
        Ok(user_index_canister::c2c_published_ai_app_ids::Response::Success(result)) => result.app_ids.into_iter().collect(),
        Ok(user_index_canister::c2c_published_ai_app_ids::Response::TooManyApps(_)) => {
            return Response::Error(OCErrorCode::InvalidRequest.with_message("AI-app validation set exceeds the chat limit"));
        }
        Err(error) => return Response::Error(error.into()),
    };

    mutate_state(|state| commit_enable(args.app_id, prepared, published_app_ids, state))
}

struct PrepareEnable {
    user_index_canister_id: CanisterId,
    enabled_ai_apps_snapshot: BTreeSet<AiAppId>,
    checked_app_ids: BTreeSet<AiAppId>,
}

fn prepare_enable(app_id: AiAppId, state: &RuntimeState) -> Result<PrepareEnable, Response> {
    authorize(state)?;
    let enabled_ai_apps_snapshot = state.data.enabled_ai_apps.clone();
    let mut checked_app_ids = enabled_ai_apps_snapshot.clone();
    checked_app_ids.insert(app_id);
    Ok(PrepareEnable {
        user_index_canister_id: state.data.user_index_canister_id,
        enabled_ai_apps_snapshot,
        checked_app_ids,
    })
}

fn commit_enable(
    app_id: AiAppId,
    prepared: PrepareEnable,
    published_app_ids: BTreeSet<AiAppId>,
    state: &mut RuntimeState,
) -> Response {
    if let Err(response) = authorize(state) {
        return response;
    }
    if state.data.user_index_canister_id != prepared.user_index_canister_id {
        return Response::Error(OCErrorCode::InvalidRequest.with_message("AI-app directory route changed"));
    }
    match reconcile_and_enable_ai_app(
        &mut state.data.enabled_ai_apps,
        &prepared.enabled_ai_apps_snapshot,
        &prepared.checked_app_ids,
        &published_app_ids,
        app_id,
    ) {
        Ok(_) => Response::Success,
        Err(ReconcileEnabledAiAppsError::ConfigurationChanged) => Response::Error(
            OCErrorCode::InvalidRequest.with_message("AI-app configuration changed during directory validation"),
        ),
        Err(ReconcileEnabledAiAppsError::AppUnavailable) => {
            Response::Error(OCErrorCode::InvalidRequest.with_message("AI app is not currently published"))
        }
        Err(ReconcileEnabledAiAppsError::LimitReached) => Response::Error(
            OCErrorCode::InvalidRequest
                .with_message(format!("a chat may enable at most {MAX_ENABLED_AI_APPS_PER_CHAT} AI apps")),
        ),
    }
}

fn disable_ai_app(app_id: AiAppId, state: &mut RuntimeState) -> Response {
    if let Err(response) = authorize(state) {
        return response;
    }
    apply_ai_app_enabled(&mut state.data.enabled_ai_apps, app_id, false).expect("disabling an AI app cannot exceed the limit");
    Response::Success
}

fn authorize(state: &RuntimeState) -> Result<(), Response> {
    if let Err(error) = state.data.verify_not_frozen() {
        return Err(Response::Error(error.into()));
    }

    let member = state.get_calling_member(true).map_err(|_| Response::UserNotInGroup)?;
    if !member.role().is_owner() && !member.role().is_admin() {
        return Err(Response::NotAuthorized);
    }
    Ok(())
}
