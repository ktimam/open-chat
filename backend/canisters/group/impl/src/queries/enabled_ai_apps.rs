use crate::RuntimeState;
use crate::read_state;
use canister_api_macros::query;
use group_canister::enabled_ai_apps::{Response::*, *};

#[query(msgpack = true)]
fn enabled_ai_apps(_args: Args) -> Response {
    read_state(enabled_ai_apps_impl)
}

fn enabled_ai_apps_impl(state: &RuntimeState) -> Response {
    let caller = state.env.caller();

    if let Err(error) = state.data.verify_is_accessible(caller, None) {
        return Error(error.into());
    }

    Success(SuccessResult {
        app_ids: state.data.enabled_ai_apps.iter().copied().collect(),
    })
}
