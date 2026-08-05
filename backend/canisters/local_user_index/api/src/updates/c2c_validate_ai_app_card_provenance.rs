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
    /// Server-computed canonical hash of the exact raw card content and message coordinates.
    pub content_hash: [u8; 32],
    pub member_user_ids: Vec<UserId>,
    pub provenance: ByteBuf,
    #[serde(default)]
    pub authority: ByteBuf,
}

#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    Success,
    InvalidProvenance,
    AppUnavailable,
    InvalidRequest(String),
    Error(String),
}
