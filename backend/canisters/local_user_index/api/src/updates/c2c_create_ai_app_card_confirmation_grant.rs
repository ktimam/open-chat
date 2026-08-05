use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use types::{AiAppId, Chat, MessageId, MessageIndex, TimestampMillis, UserId};

#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    pub user_id: UserId,
    pub chat: Chat,
    pub thread_root_message_index: Option<MessageIndex>,
    pub message_id: MessageId,
    pub app_id: AiAppId,
    pub app_revision: TimestampMillis,
    pub action_id: String,
    pub content_hash: [u8; 32],
    pub member_user_ids: Vec<UserId>,
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
