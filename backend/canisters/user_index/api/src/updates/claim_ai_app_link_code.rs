use candid::CandidType;
use oc_error_codes::OCError;
use serde::{Deserialize, Serialize};
use ts_export::ts_export;
use types::UserId;

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
pub struct SuccessResult {
    /// The OpenChat user whose code was claimed. Claiming is the only point where the app's own
    /// identity and an OpenChat identity are proven to belong to the same person — a fanned-out
    /// deposit carries `confirmed_by`, but nothing tells the app which of those is ITSELF. Returning
    /// it here lets an app answer that later without another change on this side.
    pub user_id: UserId,
}

#[ts_export(user_index, claim_ai_app_link_code)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
    CodeNotFound,
    CodeExpired,
    InvalidRequest(String),
    Error(OCError),
}
