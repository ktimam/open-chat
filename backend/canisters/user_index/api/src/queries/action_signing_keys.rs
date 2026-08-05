use candid::CandidType;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use ts_export::ts_export;
use types::{Empty, TimestampMillis};

pub type Args = Empty;

#[ts_export(user_index, action_signing_keys)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
    NotInitialised,
}

#[ts_export(user_index, action_signing_keys)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    pub signature_version: u16,
    pub purpose: String,
    pub keys: Vec<ActionSigningPublicKey>,
}

#[ts_export(user_index, action_signing_keys)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct ActionSigningPublicKey {
    #[ts(as = "ts_export::TSBytes")]
    pub key_id: ByteBuf,
    pub public_key_pem: String,
    pub status: ActionSigningKeyStatus,
    pub created_at: TimestampMillis,
    pub verify_until: Option<TimestampMillis>,
}

#[ts_export(user_index, action_signing_keys)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum ActionSigningKeyStatus {
    Staged,
    Active,
    VerifyOnly,
}
