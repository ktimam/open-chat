use candid::CandidType;
use oc_error_codes::OCError;
use serde::{Deserialize, Serialize};
use ts_export::ts_export;

#[ts_export(user_index, claim_ai_app_link_code)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Args {
    /// The 6-digit link code the user copied from OpenChat.
    pub code: String,
    /// P-256 SPKI PEM public key to register for the code's (user, app) pair.
    pub public_key: String,
}

#[ts_export(user_index, claim_ai_app_link_code)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum Response {
    Success,
    CodeNotFound,
    CodeExpired,
    InvalidRequest(String),
    Error(OCError),
}
