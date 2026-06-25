use candid::CandidType;
use oc_error_codes::OCError;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use types::TimestampMillis;

// Inbound deposit of confirmed actions, sent c2c (msgpack) by an authorized depositor.
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Args {
    pub deposits: Vec<ActionDeposit>,
}

#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct ActionDeposit {
    // Dedupe key (the depositor queue may retry).
    pub idempotency_id: u64,
    // sha256 of the consumer's registered public key DER.
    pub consumer_key_fingerprint: ByteBuf,
    pub ephemeral_public_key: ByteBuf,
    pub ciphertext: ByteBuf,
    pub oc_signature: ByteBuf,
    pub created_at: TimestampMillis,
}

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum Response {
    Success,
    Error(OCError),
}
