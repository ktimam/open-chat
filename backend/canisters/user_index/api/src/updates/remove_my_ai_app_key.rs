use oc_error_codes::OCError;
use serde::{Deserialize, Serialize};
use ts_export::ts_export;
use types::AiAppId;

#[ts_export(user_index, remove_my_ai_app_key)]
#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    pub app_id: AiAppId,
}

#[ts_export(user_index, remove_my_ai_app_key)]
#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    /// The exact (user, app) consent was cancelled. This removes a present key and also invalidates
    /// pending link codes/private-card capabilities before a key has been claimed.
    Success,
    InvalidRequest(String),
    Error(OCError),
}
