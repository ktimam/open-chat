use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use types::{AiAppCardContext, AppScopedCardContext};

#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    pub context: AiAppCardContext,
    pub content_hash: [u8; 32],
    pub recipient_key_scheme: String,
    pub recipient_public_key: ByteBuf,
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
    pub token: ByteBuf,
    pub expires_at: types::TimestampMillis,
    pub context: AppScopedCardContext,
}
