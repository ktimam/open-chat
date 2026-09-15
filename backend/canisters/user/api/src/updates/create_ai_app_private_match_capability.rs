use oc_error_codes::OCError;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use ts_export::ts_export;
use types::{AiAppId, AppScopedCardContext, MessageId, MessageIndex, TimestampMillis, UserId};

#[ts_export(user, create_ai_app_private_match_capability)]
#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    pub user_id: UserId,
    pub thread_root_message_index: Option<MessageIndex>,
    pub message_id: MessageId,
    pub app_id: AiAppId,
    pub app_revision: TimestampMillis,
    pub action_id: String,
    pub recipient_key_scheme: String,
    #[ts(as = "ts_export::TSBytes")]
    pub recipient_public_key: ByteBuf,
}

#[ts_export(user, create_ai_app_private_match_capability)]
#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
    InvalidSource,
    AppUnavailable,
    InvalidRequest(String),
    Error(OCError),
}

#[ts_export(user, create_ai_app_private_match_capability)]
#[derive(Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    #[ts(as = "ts_export::TSBytes")]
    pub token: ByteBuf,
    pub expires_at: TimestampMillis,
    pub context: AppScopedCardContext,
}
