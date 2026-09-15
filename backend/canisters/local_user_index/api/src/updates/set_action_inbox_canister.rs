use candid::CandidType;
use serde::{Deserialize, Serialize};
use types::CanisterId;

// Configures which action_inbox canister deposits are forwarded to. Set once at/after deployment.
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Args {
    pub canister_id: CanisterId,
}

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum Response {
    Success,
}
