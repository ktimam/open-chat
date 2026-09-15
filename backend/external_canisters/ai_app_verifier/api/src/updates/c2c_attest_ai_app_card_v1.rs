use candid::{CandidType, Principal};
use serde::{Deserialize, Serialize};
use types::{AiAppCardContentV1, AppScopedCardContext};

/// App-visible card content and pseudonymous correlation handles. The UserIndex retains the raw
/// OpenChat authority context and its canonical content hash; neither crosses this verifier seam.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct AppScopedCardContentCommitmentV1 {
    pub context: AppScopedCardContext,
    pub content: AiAppCardContentV1,
}

/// Exact challenge sent by UserIndex to the app canister registered for this immutable app
/// revision. `authority_content_hash` is an opaque equality binding to OpenChat's internal raw
/// authority commitment; the app validates the safe context and content and echoes the whole value.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct CardAttestationBindingV1 {
    pub user_index_canister_id: Principal,
    pub app_canister_id: Principal,
    pub commitment: AppScopedCardContentCommitmentV1,
    pub authority_content_hash: [u8; 32],
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct Args {
    pub binding: CardAttestationBindingV1,
}

/// A successful app response must vouch and echo the exact independently accepted binding. UserIndex
/// rejects false, traps, decode failures, reflection mismatches, stale revisions and changed hashes.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct Response {
    pub vouched: bool,
    pub binding: CardAttestationBindingV1,
}
