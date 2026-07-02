use candid::CandidType;
use serde::{Deserialize, Serialize};
use ts_export::ts_export;
use types::AiAppRegistration;

#[ts_export(user_index, ai_apps)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
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
