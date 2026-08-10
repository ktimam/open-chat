use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use types::{AiAppId, Chat, TimestampMillis, UserId};

#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    pub user_id: UserId,
    pub chat: Chat,
    pub chat_name: String,
    pub app_id: AiAppId,
    pub app_revision: TimestampMillis,
    pub member_user_ids: Vec<UserId>,
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
    pub token: ByteBuf,
    pub expires_at: TimestampMillis,
}
