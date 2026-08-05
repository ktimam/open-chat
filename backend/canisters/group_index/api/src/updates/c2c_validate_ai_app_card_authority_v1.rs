use crate::ai_app_card_authority::AiAppCardAuthorityBindingV1;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;

#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    pub binding: AiAppCardAuthorityBindingV1,
    pub token: ByteBuf,
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
pub enum Response {
    Success(SuccessResult),
    NotFound,
    Expired,
    InvalidBinding,
    RouteChanged,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct SuccessResult {
    pub binding: AiAppCardAuthorityBindingV1,
}
