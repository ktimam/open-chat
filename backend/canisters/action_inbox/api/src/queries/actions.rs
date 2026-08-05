use candid::CandidType;
use oc_error_codes::OCError;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use types::{AiAppId, TimestampMillis};

/// Canonical MessagePack budget for the complete successful replicated-update response. Pagination
/// stops before adding an action that would make the response exceed this value.
pub const MAX_QUERY_RESPONSE_ENCODED_BYTES: usize = 512 * 1024;

// A consumer pulls the confirmed actions addressed to it, keyed by the v2 fingerprint scoped to the
// exact UserIndex/app/inbox and its registered P-256 key. Everything is opaque ciphertext plus a
// platform signature; this canister never sees plaintext.
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Args {
    pub consumer_key_fingerprint: ByteBuf,
    pub since_id: u64,
    pub max_results: u32,
}

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
    Error(OCError),
}

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    pub actions: Vec<StoredAction>,
}

#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct StoredAction {
    pub id: u64,
    pub app_id: AiAppId,
    pub app_revision: TimestampMillis,
    pub action_id: String,
    pub consumer_key_fingerprint: ByteBuf,
    pub idempotency_key: ByteBuf,
    pub payload_hash: ByteBuf,
    pub card_context_hash: ByteBuf,
    #[serde(default)]
    pub acknowledgement_secret_hash: ByteBuf,
    pub ephemeral_public_key: ByteBuf,
    pub ciphertext: ByteBuf,
    pub signature_version: u16,
    pub signing_key_id: ByteBuf,
    pub oc_signature: ByteBuf,
    pub created_at: TimestampMillis,
}
