use crate::model::inbox::{
    ACTION_RETENTION_MILLIS, MAX_ACTIONS_PER_KEY, MAX_BYTES_PER_KEY, MAX_CIPHERTEXT_BYTES, MAX_EXPIRED_ACTIONS_PRUNED_PER_CALL,
    MAX_EXPIRED_TOMBSTONES_PRUNED_PER_CALL, MAX_MIGRATION_ITEMS_PER_STEP, MAX_SEEN_IDEMPOTENCY_KEYS, MAX_TOTAL_ACTIONS,
    MAX_TOTAL_BYTES,
};
use crate::read_state;
use action_inbox_canister::configuration::{Response::*, *};
use canister_api_macros::query;

#[query(candid = true, msgpack = true)]
fn configuration(_args: Args) -> Response {
    read_state(|state| {
        let mut authorized_depositors: Vec<_> = state.data.authorized_depositors.iter().copied().collect();
        authorized_depositors.sort_unstable();
        Success(SuccessResult {
            app_id: state.data.app_id,
            user_index_canister_id: state.data.user_index_canister_id,
            authorized_depositors,
            action_retention_millis: ACTION_RETENTION_MILLIS,
            max_actions_per_key: MAX_ACTIONS_PER_KEY as u32,
            max_total_actions: MAX_TOTAL_ACTIONS as u32,
            max_ciphertext_bytes: MAX_CIPHERTEXT_BYTES as u32,
            max_bytes_per_key: MAX_BYTES_PER_KEY,
            max_total_bytes: MAX_TOTAL_BYTES,
            action_capacity_fail_closed: true,
            max_deposit_batch_encoded_bytes: action_inbox_canister::c2c_notify_actions::MAX_DEPOSIT_BATCH_ENCODED_BYTES as u32,
            max_query_response_encoded_bytes: action_inbox_canister::actions::MAX_QUERY_RESPONSE_ENCODED_BYTES as u32,
            max_idempotency_tombstones: MAX_SEEN_IDEMPOTENCY_KEYS as u32,
            max_expired_tombstones_pruned_per_call: MAX_EXPIRED_TOMBSTONES_PRUNED_PER_CALL as u32,
            max_expired_actions_pruned_per_call: MAX_EXPIRED_ACTIONS_PRUNED_PER_CALL as u32,
            max_migration_items_per_step: MAX_MIGRATION_ITEMS_PER_STEP as u32,
            max_query_results: 100,
        })
    })
}
