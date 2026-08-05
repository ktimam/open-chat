use oc_error_codes::OCError;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use ts_export::ts_export;
use types::{AiAppCardContentV1, AiAppId, Chat, MessageId, MessageIndex, TimestampMillis};

#[ts_export(user_index, create_ai_app_card_provenance)]
#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    pub app_id: AiAppId,
    pub app_revision: TimestampMillis,
    pub action_id: String,
    /// Exact card content the registered app canister must attest. UserIndex binds the authenticated
    /// caller and message coordinates; the destination chat later recomputes the same commitment.
    pub content: AiAppCardContentV1,
    pub chat: Chat,
    pub thread_root_message_index: Option<MessageIndex>,
    pub message_id: MessageId,
}

#[ts_export(user_index, create_ai_app_card_provenance)]
#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
    AppUnavailable,
    InvalidRequest(String),
    Error(OCError),
}

#[ts_export(user_index, create_ai_app_card_provenance)]
#[derive(Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    #[ts(as = "ts_export::TSBytes")]
    pub provenance: ByteBuf,
    pub expires_at: TimestampMillis,
}
