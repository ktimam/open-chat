use oc_error_codes::OCError;
use serde::{Deserialize, Serialize};
use ts_export::ts_export;
use types::{AiAppId, TimestampMillis};

#[ts_export(user_index, create_ai_app_link_code)]
#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    pub app_id: AiAppId,
}

#[ts_export(user_index, create_ai_app_link_code)]
#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
    AppNotFound,
    Error(OCError),
}

#[ts_export(user_index, create_ai_app_link_code)]
#[derive(Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    /// 256-bit lowercase-hex token the user copies into the external app; single-use and short-lived.
    pub code: String,
    pub expires_at: TimestampMillis,
}
