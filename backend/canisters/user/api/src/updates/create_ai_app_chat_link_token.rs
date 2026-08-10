use oc_error_codes::OCError;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use ts_export::ts_export;
use types::{AiAppId, TimestampMillis, UserId};

#[ts_export(user, create_ai_app_chat_link_token)]
#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    /// The other participant in the exact direct chat.
    pub user_id: UserId,
    /// Presentation-only label shown for this chat by the OpenChat client. It is bound into the
    /// opaque token and never appears in the external URL.
    #[serde(default)]
    pub chat_name: String,
    pub app_id: AiAppId,
    pub app_revision: TimestampMillis,
}

#[ts_export(user, create_ai_app_chat_link_token)]
#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
    AppUnavailable,
    ChatNotFound,
    NotAuthorized,
    InvalidRequest(String),
    Error(OCError),
}

#[ts_export(user, create_ai_app_chat_link_token)]
#[derive(Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    #[ts(as = "ts_export::TSBytes")]
    pub token: ByteBuf,
    pub expires_at: TimestampMillis,
}
