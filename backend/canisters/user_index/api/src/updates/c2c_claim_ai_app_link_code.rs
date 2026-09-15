use candid::CandidType;
use oc_error_codes::OCError;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use types::{AiAppId, CanisterId, TimestampMillis};

pub const APP_SUBJECT_VERSION_V1: u16 = 1;
pub const CONSUMER_QUEUE_SELECTOR_VERSION_V1: u16 = 1;

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Args {
    /// The 256-bit lowercase-hex code shown to the OpenChat user.
    pub code: String,
    /// P-256 SPKI PEM key the exact registered app canister binds for this user.
    pub public_key: String,
}

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    /// Stable only within this exact UserIndex/app/app-canister scope. The registered app receives
    /// no global OpenChat user id and cannot join this value with another app's subject.
    pub app_subject: ByteBuf,
    pub subject_version: u16,
    pub app_id: AiAppId,
    pub app_revision: TimestampMillis,
    pub app_canister_id: CanisterId,
    /// Opaque HMAC queue selector for this exact UserIndex/app/inbox/key binding. It is disclosed
    /// only to the authenticated app canister and cannot be recomputed from the public PEM.
    pub consumer_queue_selector: ByteBuf,
    pub consumer_queue_selector_version: u16,
    /// Monotonic epoch for this exact (user, app) key binding. Revoke proofs must bind it.
    pub key_version: u64,
}

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
    CodeNotFound,
    CodeExpired,
    NotAuthorized,
    InvalidRequest(String),
    Error(OCError),
}
