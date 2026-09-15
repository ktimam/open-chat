use candid::CandidType;
use serde::{Deserialize, Serialize};
use types::{AiAppId, CanisterId, TimestampMillis};

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Args {}

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
}

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    pub app_id: AiAppId,
    pub user_index_canister_id: CanisterId,
    pub authorized_depositors: Vec<CanisterId>,
    pub action_retention_millis: TimestampMillis,
    pub max_actions_per_key: u32,
    pub max_total_actions: u32,
    pub max_ciphertext_bytes: u32,
    pub max_bytes_per_key: u64,
    pub max_total_bytes: u64,
    pub action_capacity_fail_closed: bool,
    pub max_deposit_batch_encoded_bytes: u32,
    pub max_query_response_encoded_bytes: u32,
    pub max_idempotency_tombstones: u32,
    pub max_expired_tombstones_pruned_per_call: u32,
    pub max_expired_actions_pruned_per_call: u32,
    pub max_migration_items_per_step: u32,
    pub max_query_results: u32,
}
