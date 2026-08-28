use crate::ai_app_chat_link_authority::AiAppChatLinkAuthorityBindingV1;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;

#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    pub binding: AiAppChatLinkAuthorityBindingV1,
    pub token: ByteBuf,
}

#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
    NotFound,
    Expired,
    BindingMismatch,
    InvalidRoute,
    InvalidRequest(String),
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    pub binding: AiAppChatLinkAuthorityBindingV1,
}
