use crate::c2c_redeem_ai_app_card_capability::AppScopedCardContext;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use types::{AiAppCardContext, AiAppMemberKey, CanisterId, TimestampMillis, UserId};

#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    pub context: AiAppCardContext,
    pub content_hash: [u8; 32],
    pub confirm_payload_hash: [u8; 32],
    pub confirmation_lease_generation: u64,
    pub created_at: TimestampMillis,
    pub authority: ByteBuf,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct RecipientRoute {
    pub user_id: UserId,
    pub public_key: String,
    pub consumer_queue_selector: ByteBuf,
    pub consumer_queue_selector_version: u16,
    pub app_subject: ByteBuf,
    pub subject_version: u16,
    pub app_user_key_version: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct RecipientAuthorizationGrant {
    pub scope_commitment: ByteBuf,
    /// Fresh route-time authorization clock. It is relay metadata only and must never enter the
    /// card, delivery-attempt, outbox-slot, or ActionInbox idempotency identities.
    pub authorization_created_at: TimestampMillis,
    pub expires_at: TimestampMillis,
}

#[derive(Serialize, Deserialize, Debug)]
#[expect(
    clippy::large_enum_variant,
    reason = "The success response carries the complete verified recipient route; keep the existing API representation"
)]
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
    /// Empty for legacy/default confirmer-only routes. App-authorized actions carry one exact
    /// independently encryptable route per selected account/chat member.
    #[serde(default)]
    pub recipients: Vec<RecipientRoute>,
    #[serde(default)]
    pub recipient_authorization: Option<RecipientAuthorizationGrant>,
    /// The only card identity exposed inside the app-decryptable action envelope.
    pub external_context: AppScopedCardContext,
}
