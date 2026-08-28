use candid::CandidType;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
pub use types::{APP_SCOPED_CARD_CONTEXT_VERSION_V1, AppScopedCardContext};
use types::{AiAppCardCapabilityScope, CanisterId, TimestampMillis};

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Args {
    pub token: ByteBuf,
    pub recipient_key_scheme: String,
    pub recipient_public_key: ByteBuf,
}

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
    NotFound,
    Expired,
    NotAuthorized,
    AppUnavailable,
    InvalidRequest(String),
}

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    pub context: AppScopedCardContext,
    pub content_hash: [u8; 32],
    pub app_canister_id: CanisterId,
    pub recipient_key_scheme: String,
    pub recipient_public_key: ByteBuf,
    pub scope: AiAppCardCapabilityScope,
    pub expires_at: TimestampMillis,
}
