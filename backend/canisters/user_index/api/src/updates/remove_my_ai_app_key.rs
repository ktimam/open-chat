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
    /// The (user, app) key was removed, or there was none to begin with (idempotent — a disconnect
    /// should always report success).
    Success,
    InvalidRequest(String),
    Error(OCError),
}
