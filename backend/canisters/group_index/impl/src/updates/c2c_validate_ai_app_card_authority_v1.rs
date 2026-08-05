use crate::guards::caller_is_user_index_canister;
use crate::model::ai_app_card_authority::CheckResult;
use crate::mutate_state;
use crate::updates::c2c_issue_ai_app_card_authority_v1::resolve_route;
use canister_api_macros::update;
use group_index_canister::ai_app_card_authority::AI_APP_CARD_AUTHORITY_TOKEN_BYTES;
use group_index_canister::c2c_validate_ai_app_card_authority_v1::{Response::*, *};

#[update(guard = "caller_is_user_index_canister", msgpack = true)]
fn c2c_validate_ai_app_card_authority_v1(args: Args) -> Response {
    if args.token.len() != AI_APP_CARD_AUTHORITY_TOKEN_BYTES {
        return NotFound;
    }
    let canister_version = ic_cdk::api::canister_version();
    mutate_state(|state| {
        crate::pr2_entropy::ensure_current_version(state, canister_version);
        if !state.data.pr2_entropy.is_ready(canister_version) {
            return NotFound;
        }
        let owner = resolve_route(&args.binding, None, state).map(|(_, owner)| owner);
        let stored_binding = state.data.ai_app_card_authority.stored_binding(&args.token);
        map_result(
            state
                .data
                .ai_app_card_authority
                .check(&args.token, &args.binding, owner, state.env.now()),
            stored_binding,
        )
    })
}

pub(crate) fn map_result(
    value: CheckResult,
    binding: Option<group_index_canister::ai_app_card_authority::AiAppCardAuthorityBindingV1>,
) -> Response {
    match value {
        CheckResult::Valid => Success(SuccessResult {
            binding: binding.expect("a valid authority has a stored binding"),
        }),
        CheckResult::NotFound => NotFound,
        CheckResult::Expired => Expired,
        CheckResult::InvalidBinding => InvalidBinding,
        CheckResult::RouteChanged => RouteChanged,
    }
}
