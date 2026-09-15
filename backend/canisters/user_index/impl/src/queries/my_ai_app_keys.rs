use crate::{RuntimeState, read_state};
use canister_api_macros::query;
use types::UserId;
use user_index_canister::my_ai_app_keys::{Response::*, *};

#[query(msgpack = true)]
fn my_ai_app_keys(_args: Args) -> Response {
    read_state(my_ai_app_keys_impl)
}

fn my_ai_app_keys_impl(state: &RuntimeState) -> Response {
    let caller = state.env.caller();
    // ONLY a registered OpenChat user resolves here. `register_ai_app` deliberately falls back to the
    // caller principal in test_mode so a deploy script's standalone principal can own a manifest — but
    // that rationale does not carry to a PER-USER query. Copying it here fabricated a UserId out of
    // whatever principal happened to call (e.g. a consumer app's own identity), which is the right
    // TYPE and entirely the wrong IDENTITY: anything comparing it against a real
    // `context.confirmedBy` would find no match and treat every action as someone else's. Worse, it
    // was gated on test_mode, so it would have behaved one way locally and another in production.
    // An unknown caller now gets None and an empty list, which is the honest answer.
    let user_id: Option<UserId> = state.data.users.get_by_principal(&caller).map(|u| u.user_id);

    let keys = user_id
        .map(|u| {
            state
                .data
                .ai_app_user_keys
                .keys_for_user(u)
                .unwrap_or_else(|error| ic_cdk::trap(error.message()))
        })
        .unwrap_or_default();

    // The resolved id travels with the keys: a caller that IS an OpenChat user can learn which
    // account its keys belong to without a second round trip.
    Success(SuccessResult { user_id, keys })
}
