use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use types::AiAppCardContext;

#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    pub context: AiAppCardContext,
    pub content_hash: [u8; 32],
    pub provenance: ByteBuf,
    #[serde(default)]
    pub authority: ByteBuf,
}

#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    Success,
    InvalidProvenance,
    AppUnavailable,
    InvalidRequest(String),
    Error(String),
}
