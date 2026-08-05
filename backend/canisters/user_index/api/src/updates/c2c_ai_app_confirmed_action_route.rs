use crate::c2c_redeem_ai_app_card_capability::AppScopedCardContext;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use types::{AiAppCardContext, AiAppMemberKey, CanisterId, TimestampMillis};

#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    pub context: AiAppCardContext,
    pub content_hash: [u8; 32],
    pub confirm_payload_hash: [u8; 32],
    pub confirmation_lease_generation: u64,
    pub created_at: TimestampMillis,
    pub authority: ByteBuf,
}

#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
    InvalidAuthority,
    AppUnavailable,
    InvalidRequest(String),
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    pub inbox_canister_id: CanisterId,
    /// Opaque UIX HMAC selector matching the returned effective recipient key.
    pub consumer_queue_selector: ByteBuf,
    pub consumer_queue_selector_version: u16,
    pub per_user_keys: bool,
    pub consumer_public_key: Option<String>,
    pub confirmer_key: Option<AiAppMemberKey>,
    /// The only card identity exposed inside the app-decryptable action envelope.
    pub external_context: AppScopedCardContext,
}
