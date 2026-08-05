use candid::CandidType;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use types::{AiAppId, CanisterId, TimestampMillis};

pub const CONSUMER_QUEUE_SELECTOR_VERSION_V1: u16 = 1;

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Args {
    pub app_id: AiAppId,
    pub app_revision: TimestampMillis,
    pub action_id: String,
}

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
    NotAuthorized,
    AppUnavailable,
    InvalidRequest(String),
}

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    pub inbox_canister_id: CanisterId,
    /// Opaque HMAC selector for the current effective app/action consumer key.
    pub consumer_queue_selector: ByteBuf,
    pub consumer_queue_selector_version: u16,
}
