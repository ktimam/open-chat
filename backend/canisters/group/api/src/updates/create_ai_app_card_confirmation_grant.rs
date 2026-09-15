use oc_error_codes::OCError;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use ts_export::ts_export;
use types::{MessageId, MessageIndex, TimestampMillis};

#[ts_export(group, create_ai_app_card_confirmation_grant)]
#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    pub thread_root_message_index: Option<MessageIndex>,
    pub message_id: MessageId,
    #[ts(as = "ts_export::TSBytes")]
    pub confirm_payload: ByteBuf,
}

#[ts_export(group, create_ai_app_card_confirmation_grant)]
#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
    InvalidProvenance,
    AppUnavailable,
    InvalidRequest(String),
    Error(OCError),
}

#[ts_export(group, create_ai_app_card_confirmation_grant)]
#[derive(Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    #[ts(as = "ts_export::TSBytes")]
    pub grant: ByteBuf,
    pub expires_at: TimestampMillis,
}
