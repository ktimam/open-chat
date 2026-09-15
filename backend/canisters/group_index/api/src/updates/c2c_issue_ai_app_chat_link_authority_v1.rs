use crate::ai_app_chat_link_authority::AiAppChatLinkAuthorityBindingV1;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use types::TimestampMillis;

#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    pub binding: AiAppChatLinkAuthorityBindingV1,
}

#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
    InvalidRoute,
    InvalidRequest(String),
    CapacityExceeded,
    EntropyUnavailable,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    pub token: ByteBuf,
    pub expires_at: TimestampMillis,
}
