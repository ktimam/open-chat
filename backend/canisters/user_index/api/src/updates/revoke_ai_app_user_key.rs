use candid::CandidType;
use oc_error_codes::OCError;
use serde::{Deserialize, Serialize};
use ts_export::ts_export;

#[ts_export(user_index, revoke_ai_app_user_key)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Args {
    /// The exact P-256 SPKI PEM currently registered for some (user, app) pair. Knowledge of this
    /// value is the authorization (see the endpoint comment).
    pub public_key: String,
}

#[ts_export(user_index, revoke_ai_app_user_key)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum Response {
    Success,
    KeyNotFound,
    Error(OCError),
}
