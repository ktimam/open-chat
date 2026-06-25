use candid::CandidType;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use types::TimestampMillis;

// A consumer pulls the confirmed actions addressed to it (keyed by the sha256 fingerprint of its registered
// public key). Everything is opaque ciphertext + a platform signature; this canister never sees plaintext.
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Args {
    pub consumer_key_fingerprint: ByteBuf,
    pub since_id: u64,
    pub max_results: u32,
}

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
}

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    pub actions: Vec<StoredAction>,
}

#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct StoredAction {
    pub id: u64,
    pub ephemeral_public_key: ByteBuf,
    pub ciphertext: ByteBuf,
    pub oc_signature: ByteBuf,
    pub created_at: TimestampMillis,
}
