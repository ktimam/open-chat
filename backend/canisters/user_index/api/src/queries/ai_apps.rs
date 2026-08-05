use candid::CandidType;
use serde::{Deserialize, Serialize};
use ts_export::ts_export;
use types::AiAppRegistration;

#[ts_export(user_index, ai_apps)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
/// Deprecated wire-compatibility request. The response is only the first bounded visible page;
/// use `ai_apps_by_ids`, `explore_ai_apps`, or `my_ai_apps` for explicit scope and pagination.
pub struct Args {}

#[ts_export(user_index, ai_apps)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
}

#[ts_export(user_index, ai_apps)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    pub apps: Vec<AiAppRegistration>,
}
