use candid::CandidType;
use serde::{Deserialize, Serialize};
use ts_export::ts_export;
use types::AiAppRegistration;

#[ts_export(user_index, my_ai_apps)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Args {
    pub page_index: u32,
    pub page_size: u8,
}

#[ts_export(user_index, my_ai_apps)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
    InvalidPageSize(u8),
    ResponseTooLarge(u32),
    UserNotFound,
}

#[ts_export(user_index, my_ai_apps)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    pub apps: Vec<AiAppRegistration>,
    pub total: u32,
}
