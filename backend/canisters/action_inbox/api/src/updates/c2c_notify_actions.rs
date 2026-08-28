use candid::CandidType;
use oc_error_codes::OCError;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use types::{AiAppId, TimestampMillis};

/// Canonical MessagePack budget for the complete app-bound deposit request, including field names,
/// vector framing, and every envelope. All relay hops enforce the same limit before an outbound call.
pub const MAX_DEPOSIT_BATCH_ENCODED_BYTES: usize = 1024 * 1024;
pub const ACTION_IDENTITY_BYTES: usize = 32;
pub const ACTION_PAYLOAD_HASH_BYTES: usize = 32;
pub const ACTION_CARD_CONTEXT_HASH_BYTES: usize = 32;
pub const ACTION_SIGNING_KEY_ID_BYTES: usize = 32;

// Inbound deposit of confirmed actions, sent c2c (msgpack) by an authorized depositor.
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Args {
    // UserIndex derives this namespace from its currently published registry entry. This canister
    // is configured for exactly one app, making every global storage quota app-isolated.
    pub app_id: AiAppId,
    pub deposits: Vec<ActionDeposit>,
}

#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct ActionDeposit {
    /// Full collision-resistant card identity and primary durable tombstone key.
    pub idempotency_key: ByteBuf,
    /// Exact final confirm-payload digest.
    pub payload_hash: ByteBuf,
    /// Privacy-preserving commitment to the consumed authoritative chat/card confirmation context.
    pub card_context_hash: ByteBuf,
    pub app_revision: TimestampMillis,
    pub action_id: String,
    // Opaque 32-byte UserIndex HMAC selector for the exact app/inbox/key binding. The legacy field
    // name is retained on the wire; this value is not a public-key digest and cannot be derived
    // from the PEM or public registry coordinates.
    pub consumer_key_fingerprint: ByteBuf,
    // Domain-separated hash of the random acknowledgement secret embedded only in this recipient's
    // encrypted plaintext. The inbox never receives or stores the raw secret.
    #[serde(default)]
    pub acknowledgement_secret_hash: ByteBuf,
    pub ephemeral_public_key: ByteBuf,
    pub ciphertext: ByteBuf,
    pub signature_version: u16,
    pub signing_key_id: ByteBuf,
    pub oc_signature: ByteBuf,
    pub created_at: TimestampMillis,
}

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum Response {
    Success,
    Error(OCError),
}
