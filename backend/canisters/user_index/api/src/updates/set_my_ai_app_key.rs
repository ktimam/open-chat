use oc_error_codes::OCError;
use serde::{Deserialize, Serialize};
use ts_export::ts_export;
use types::AiAppId;

#[ts_export(user_index, set_my_ai_app_key)]
#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    pub app_id: AiAppId,
    /// P-256 SPKI PEM public key confirmed actions for this (user, app) pair are encrypted to.
    pub public_key: String,
}

#[ts_export(user_index, set_my_ai_app_key)]
#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    Success,
    AppNotFound,
    InvalidRequest(String),
    Error(OCError),
}
