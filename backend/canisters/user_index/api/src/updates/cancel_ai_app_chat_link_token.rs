use oc_error_codes::OCError;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use ts_export::ts_export;

#[ts_export(user_index, cancel_ai_app_chat_link_token)]
#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    #[ts(as = "ts_export::TSBytes")]
    pub token: ByteBuf,
}

#[ts_export(user_index, cancel_ai_app_chat_link_token)]
#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    /// Missing, consumed, expired, and foreign tokens are idempotent no-ops.
    Success,
    InvalidRequest(String),
    Error(OCError),
}
