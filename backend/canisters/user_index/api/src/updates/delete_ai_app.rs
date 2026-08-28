use candid::CandidType;
use oc_error_codes::OCError;
use serde::{Deserialize, Serialize};
use ts_export::ts_export;

#[ts_export(user_index, delete_ai_app)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Args {
    pub name: String,
}

#[ts_export(user_index, delete_ai_app)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum Response {
    Success,
    NotFound,
    Error(OCError),
}
