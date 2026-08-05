use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use types::{AiAppCardContext, AiAppId, TimestampMillis, UserId};

/// One encrypted deposit and authoritative key binding per recipient key.
pub const MAX_RECIPIENT_KEY_BINDINGS: usize = 8;
/// A binding may represent users sharing one key, but cannot exceed the bounded chat-member
/// assertion supplied by the authoritative child canister.
pub const MAX_USERS_PER_RECIPIENT_KEY_BINDING: usize = 9;
/// Aggregate defense-in-depth bound across all key bindings.
pub const MAX_BOUND_RECIPIENT_USERS: usize = 64;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RecipientKeyBinding {
    /// Empty for an app-level key; one or more authoritative members when a canonical per-user key
    /// is shared. UserIndex re-resolves every tuple immediately before inbox dispatch.
    pub user_ids: Vec<UserId>,
    pub key_fingerprint: ByteBuf,
}

/// LUI encrypts the app-defined plaintext but does not sign it. UserIndex signs only after it has
/// revalidated the exact app revision, action, recipient binding, authority assertion, and inbox.
#[derive(Serialize, Deserialize, Debug)]
pub struct UnsignedActionDeposit {
    pub idempotency_key: ByteBuf,
    pub payload_hash: ByteBuf,
    pub consumer_key_fingerprint: ByteBuf,
    pub acknowledgement_secret_hash: ByteBuf,
    pub ephemeral_public_key: ByteBuf,
    pub ciphertext: ByteBuf,
    pub created_at: TimestampMillis,
}

/// A LocalUserIndex has already encrypted each recipient's envelope but has not signed it. It supplies immutable
/// app provenance, never an authoritative destination. UserIndex revalidates the exact published
/// revision and derives its administratively bound inbox before using relay authority.
#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    /// Exact private context vouched by the child and GroupIndex authority. Redundant routing fields
    /// below remain explicit defense-in-depth commitments and must match this context exactly.
    pub authority_context: AiAppCardContext,
    pub content_hash: [u8; 32],
    pub confirmation_lease_generation: u64,
    pub authority: ByteBuf,
    pub confirmed_by: UserId,
    pub app_id: AiAppId,
    pub app_revision: TimestampMillis,
    pub action_id: String,
    pub recipient_key_bindings: Vec<RecipientKeyBinding>,
    pub deposits: Vec<UnsignedActionDeposit>,
}

#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    Success,
    /// A bounded downstream call timed out or was rejected after dispatch. The inbox may have
    /// committed, so callers must retain their durable lease and reconcile by exact retry.
    OutcomeUnknown,
    Error(String),
}
