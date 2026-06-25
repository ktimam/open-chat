use candid::{CandidType, Principal};
use serde::{Deserialize, Serialize};
use types::{BuildVersion, CanisterId};

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Args {
    pub user_index_canister_id: CanisterId,
    pub cycles_dispenser_canister_id: CanisterId,
    pub deployment_operators: Vec<Principal>,
    // Canisters allowed to deposit confirmed actions (the local_user_index shards that sign + deposit).
    pub authorized_depositors: Vec<CanisterId>,
    // PEM of the platform key that signs deposits; consumers verify against this.
    pub oc_signing_public_key_pem: String,
    pub wasm_version: BuildVersion,
    pub test_mode: bool,
}
