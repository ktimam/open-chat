use oc_error_codes::OCError;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use ts_export::ts_export;
use types::{AiAppId, ChannelId, TimestampMillis};

#[ts_export(community, create_ai_app_chat_link_token)]
#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    pub channel_id: ChannelId,
    pub app_id: AiAppId,
    pub app_revision: TimestampMillis,
}

#[ts_export(community, create_ai_app_chat_link_token)]
#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
    AppUnavailable,
    ChatNotFound,
    NotAuthorized,
    InvalidRequest(String),
    Error(OCError),
}

#[ts_export(community, create_ai_app_chat_link_token)]
#[derive(Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    #[ts(as = "ts_export::TSBytes")]
    pub token: ByteBuf,
    pub expires_at: TimestampMillis,
}
