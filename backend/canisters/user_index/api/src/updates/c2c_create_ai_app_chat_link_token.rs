use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use types::{AiAppId, Chat, TimestampMillis, UserId};

#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    pub user_id: UserId,
    pub chat: Chat,
    pub app_id: AiAppId,
    pub app_revision: TimestampMillis,
    #[serde(default)]
    pub authority: ByteBuf,
}

#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
    AppUnavailable,
    NotAuthorized,
    InvalidRequest(String),
    Error(String),
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    /// Exactly 32 bytes. URL hosts encode this as canonical base64url without padding.
    pub token: ByteBuf,
    pub expires_at: TimestampMillis,
}
