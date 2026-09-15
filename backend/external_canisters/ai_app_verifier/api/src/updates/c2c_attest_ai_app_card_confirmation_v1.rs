use candid::{CandidType, Principal};
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use types::AppScopedCardContext;

/// Exact final-confirmation challenge sent to the canister registered for the immutable app
/// revision. The app sees the final opaque bytes and must independently accept every bound field.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct CardConfirmationAttestationBindingV1 {
    pub user_index_canister_id: Principal,
    pub app_canister_id: Principal,
    pub context: AppScopedCardContext,
    pub content_hash: [u8; 32],
    pub confirm_payload: ByteBuf,
    pub app_user_key_version: Option<u64>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct Args {
    pub binding: CardConfirmationAttestationBindingV1,
}

/// UserIndex accepts only `vouched=true` plus an exact echo of its challenge.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct Response {
    pub vouched: bool,
    pub binding: CardConfirmationAttestationBindingV1,
}
