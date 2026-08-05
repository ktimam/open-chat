use candid::CandidType;
use oc_error_codes::OCError;
use serde::{Deserialize, Serialize};
use ts_export::ts_export;
use types::{AiAppId, TimestampMillis};

#[ts_export(user_index, revoke_ai_app_user_key)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Args {
    /// Exact tuple returned by the app-authenticated link claim.
    #[serde(with = "serde_bytes")]
    pub app_subject: Vec<u8>,
    pub app_id: AiAppId,
    pub key_version: u64,
    /// The exact P-256 SPKI PEM currently registered for this tuple.
    pub public_key: String,
    /// Raw 64-byte P-256 ECDSA signature (r||s, as WebCrypto emits) over the canonical revoke
    /// challenge — proof the caller holds the private key for `public_key`. See the endpoint comment.
    #[serde(with = "serde_bytes")]
    pub signature: Vec<u8>,
    /// Client clock (ms) at signing time; bound into the challenge to give a replay window.
    pub timestamp: TimestampMillis,
}

#[ts_export(user_index, revoke_ai_app_user_key)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum Response {
    Success,
    KeyNotFound,
    Error(OCError),
}
