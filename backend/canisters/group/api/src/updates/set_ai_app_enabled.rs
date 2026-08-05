use candid::CandidType;
use oc_error_codes::OCError;
use serde::{Deserialize, Serialize};
use ts_export::ts_export;
use types::AiAppId;

#[ts_export(group, set_ai_app_enabled)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Args {
    pub app_id: AiAppId,
    pub enabled: bool,
}

#[ts_export(group, set_ai_app_enabled)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum Response {
    Success,
    NotAuthorized,
    UserNotInGroup,
    Error(OCError),
}
