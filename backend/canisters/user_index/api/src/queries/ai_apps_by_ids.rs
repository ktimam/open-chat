use candid::CandidType;
use serde::{Deserialize, Serialize};
use ts_export::ts_export;
use types::{AiAppId, AiAppRegistration, TimestampMillis};

#[ts_export(user_index, ai_apps_by_ids)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Args {
    pub lookups: Vec<AiAppLookup>,
}

#[ts_export(user_index, ai_apps_by_ids)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct AiAppLookup {
    pub app_id: AiAppId,
    pub revision: Option<TimestampMillis>,
}

#[ts_export(user_index, ai_apps_by_ids)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
    TooManyApps(u8),
    ResponseTooLarge(u32),
}

#[ts_export(user_index, ai_apps_by_ids)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    pub apps: Vec<AiAppRegistration>,
}
