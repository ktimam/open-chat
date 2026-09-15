use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use types::{AiAppCardContext, TimestampMillis};

#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    pub context: AiAppCardContext,
    pub content_hash: [u8; 32],
    pub confirm_payload: ByteBuf,
    #[serde(default)]
    pub authority: ByteBuf,
}

#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
    InvalidProvenance,
    AppUnavailable,
    InvalidRequest(String),
    Error(String),
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    pub grant: ByteBuf,
    pub expires_at: TimestampMillis,
}
