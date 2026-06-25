use candid::Principal;
use canister_state_macros::canister_state;
use model::inbox::Inbox;
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::{BTreeMap, HashSet};
use types::{BuildVersion, CanisterId, Cycles, TimestampMillis, Timestamped};
use utils::env::Environment;

mod guards;
mod jobs;
mod lifecycle;
mod memory;
mod model;
mod queries;
mod updates;

thread_local! {
    static WASM_VERSION: RefCell<Timestamped<BuildVersion>> = RefCell::default();
}

canister_state!(RuntimeState);

struct RuntimeState {
    pub env: Box<dyn Environment>,
    pub data: Data,
}

impl RuntimeState {
    pub fn new(env: Box<dyn Environment>, data: Data) -> RuntimeState {
        RuntimeState { env, data }
    }

    pub fn is_caller_authorized_depositor(&self) -> bool {
        self.data.authorized_depositors.contains(&self.env.caller())
    }

    pub fn metrics(&self) -> Metrics {
        Metrics {
            heap_memory_used: utils::memory::heap(),
            stable_memory_used: utils::memory::stable(),
            now: self.env.now(),
            cycles_balance: self.env.cycles_balance(),
            liquid_cycles_balance: self.env.liquid_cycles_balance(),
            wasm_version: WASM_VERSION.with_borrow(|v| **v),
            git_commit_id: utils::git::git_commit_id().to_string(),
            stable_memory_sizes: memory::memory_sizes(),
            authorized_depositors: self.data.authorized_depositors.iter().copied().collect(),
            canister_ids: CanisterIds {
                user_index: self.data.user_index_canister_id,
                cycles_dispenser: self.data.cycles_dispenser_canister_id,
            },
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Data {
    pub user_index_canister_id: CanisterId,
    pub cycles_dispenser_canister_id: CanisterId,
    pub deployment_operators: Vec<Principal>,
    pub authorized_depositors: HashSet<Principal>,
    pub oc_signing_public_key_pem: String,
    pub rng_seed: [u8; 32],
    pub inbox: Inbox,
    pub test_mode: bool,
}

impl Data {
    pub fn new(
        user_index_canister_id: CanisterId,
        cycles_dispenser_canister_id: CanisterId,
        deployment_operators: Vec<Principal>,
        authorized_depositors: Vec<CanisterId>,
        oc_signing_public_key_pem: String,
        test_mode: bool,
    ) -> Data {
        Data {
            user_index_canister_id,
            cycles_dispenser_canister_id,
            deployment_operators,
            authorized_depositors: authorized_depositors.into_iter().collect(),
            oc_signing_public_key_pem,
            rng_seed: [0; 32],
            inbox: Inbox::default(),
            test_mode,
        }
    }
}

#[derive(Serialize, Debug)]
pub struct Metrics {
    pub now: TimestampMillis,
    pub heap_memory_used: u64,
    pub stable_memory_used: u64,
    pub cycles_balance: Cycles,
    pub liquid_cycles_balance: Cycles,
    pub wasm_version: BuildVersion,
    pub git_commit_id: String,
    pub stable_memory_sizes: BTreeMap<u8, u64>,
    pub authorized_depositors: Vec<Principal>,
    pub canister_ids: CanisterIds,
}

#[derive(Serialize, Debug)]
pub struct CanisterIds {
    pub user_index: CanisterId,
    pub cycles_dispenser: CanisterId,
}
