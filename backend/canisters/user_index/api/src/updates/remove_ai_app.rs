use candid::CandidType;
use human_readable::ToHumanReadable;
use oc_error_codes::OCError;
use serde::{Deserialize, Serialize};
use ts_export::ts_export;
use types::AiAppId;

#[ts_export(user_index, remove_ai_app)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Args {
    pub app_id: AiAppId,
}

#[ts_export(user_index, remove_ai_app)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum Response {
    Success,
    NotFound,
    Error(OCError),
}

#[derive(Serialize)]
pub struct HumanReadableArgs {
    app_id: AiAppId,
}

impl ToHumanReadable for Args {
    type Target = HumanReadableArgs;

    fn to_human_readable(&self) -> Self::Target {
        HumanReadableArgs { app_id: self.app_id }
    }
}
