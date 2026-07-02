use oc_error_codes::OCError;
use serde::{Deserialize, Serialize};
use ts_export::ts_export;
use types::AiAppId;

#[ts_export(group, enabled_ai_apps)]
#[derive(Serialize, Deserialize, Debug)]
pub struct Args {}

#[ts_export(group, enabled_ai_apps)]
#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
    Error(OCError),
}

#[ts_export(group, enabled_ai_apps)]
#[derive(Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    pub app_ids: Vec<AiAppId>,
}
