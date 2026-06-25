use candid::CandidType;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use types::TimestampMillis;

// Generic deposit: a chat canister (on an ActionCard confirm) hands an OPAQUE plaintext payload plus the
// recipient consumer's P-256 public key. local_user_index encrypts the payload to that key, signs it with the
// platform key, and forwards it to the action_inbox canister. OpenChat never interprets the payload.
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Args {
    pub consumer_public_key_pem: String,
    pub plaintext: ByteBuf,
    pub created_at: TimestampMillis,
}

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum Response {
    Success,
    NotConfigured,
    Error(String),
}
