use candid::CandidType;
use oc_error_codes::OCError;
use serde::{Deserialize, Serialize};
use ts_export::ts_export;
use types::{AiAppManifest, AiAppRegistration};

#[ts_export(user_index, register_ai_app)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Args {
    pub manifest: AiAppManifest,
}

#[ts_export(user_index, register_ai_app)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
#[expect(
    clippy::large_enum_variant,
    reason = "The success response carries the complete app registration; keep the existing API representation"
)]
pub enum Response {
    Success(AiAppRegistration),
    InvalidRequest(String),
    Error(OCError),
}
