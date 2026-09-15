use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use types::AiAppCardContext;

#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    pub context: AiAppCardContext,
    pub content_hash: [u8; 32],
    pub confirm_payload_hash: [u8; 32],
    pub grant: ByteBuf,
    #[serde(default)]
    pub confirmation_lease_generation: u64,
    #[serde(default)]
    pub authority: ByteBuf,
}

#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    Success,
    NotFound,
    Expired,
    AppUnavailable,
    InvalidRequest(String),
}
