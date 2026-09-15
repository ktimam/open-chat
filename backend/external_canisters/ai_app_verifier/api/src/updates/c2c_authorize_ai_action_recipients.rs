use candid::CandidType;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use types::{AppScopedCardContext, TimestampMillis};

/// A recipient authorization is deliberately short-lived and deterministic from the fresh
/// UserIndex authorization timestamp so route and deposit callbacks can return the same grant.
pub const RECIPIENT_AUTHORIZATION_TTL_MILLIS: TimestampMillis = 5 * 60 * 1_000;
pub const MAX_AUTHORIZED_RECIPIENTS: usize = 8;
pub const APP_SUBJECT_VERSION_V1: u16 = 1;
pub const CONSUMER_QUEUE_SELECTOR_VERSION_V1: u16 = 1;
pub const SCOPE_COMMITMENT_BYTES: usize = 32;

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Args {
    pub context: AppScopedCardContext,
    pub content_hash: [u8; 32],
    pub confirm_payload_hash: [u8; 32],
    pub confirmation_lease_generation: u64,
    /// Immutable child-authoritative confirmation time. It remains part of the app's scope
    /// decision but is deliberately not used as the short-lived authorization clock.
    pub created_at: TimestampMillis,
    /// Fresh trusted UserIndex time captured for this authorization attempt. The app includes both
    /// timestamps in its opaque scope commitment and derives `expires_at` from this value.
    pub authorization_created_at: TimestampMillis,
}

/// Every value is an app-held binding previously returned by OpenChat's authenticated link flow.
/// UserIndex treats it only as a claim: it reverse-resolves the public key through its bounded
/// index and recomputes every opaque subject, selector and binding epoch before accepting it.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct AuthorizedRecipient {
    pub app_subject: ByteBuf,
    pub subject_version: u16,
    pub consumer_queue_selector: ByteBuf,
    pub consumer_queue_selector_version: u16,
    pub consumer_public_key: String,
    pub app_user_key_version: u64,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct SuccessResult {
    /// Strictly ordered by `app_subject`, unique, bounded, and including the confirmer.
    pub recipients: Vec<AuthorizedRecipient>,
    /// Opaque app commitment to the exact account/scope decision. OpenChat checks its size and
    /// exact equality across the route and pre-deposit callbacks; it never interprets the bytes.
    pub scope_commitment: ByteBuf,
    pub expires_at: TimestampMillis,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub enum Response {
    Success(SuccessResult),
    NotAuthorized,
    Stale,
    InvalidRequest(String),
}
