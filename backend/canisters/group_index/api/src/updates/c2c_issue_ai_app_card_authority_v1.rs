use crate::ai_app_card_authority::AiAppCardAuthorityBindingV1;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use types::TimestampMillis;

#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    pub binding: AiAppCardAuthorityBindingV1,
}

#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
    InvalidRoute,
    InvalidRequest(String),
    CapacityExceeded,
    EntropyUnavailable,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    pub token: ByteBuf,
    pub expires_at: TimestampMillis,
}
