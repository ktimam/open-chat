use candid::{CandidType, Principal};
use serde::{Deserialize, Serialize};
use types::{AiAppId, BuildVersion, CanisterId};

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Args {
    // One inbox is one app namespace. Allocate the canister id, register the app manifest against
    // it, then install this canister with the returned immutable app id before publication.
    pub app_id: AiAppId,
    pub user_index_canister_id: CanisterId,
    pub cycles_dispenser_canister_id: CanisterId,
    pub deployment_operators: Vec<Principal>,
    // Canisters allowed to deposit confirmed actions (the local_user_index shards that sign + deposit).
    pub authorized_depositors: Vec<CanisterId>,
    pub wasm_version: BuildVersion,
    pub test_mode: bool,
}
