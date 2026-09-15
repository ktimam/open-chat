use candid::CandidType;
use human_readable::ToHumanReadable;
use oc_error_codes::OCError;
use serde::{Deserialize, Serialize};
use ts_export::ts_export;
use types::AiAppId;

#[ts_export(user_index, publish_ai_app)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Args {
    pub app_id: AiAppId,
}

#[ts_export(user_index, publish_ai_app)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum Response {
    Success,
    NotFound,
    NotAuthorised,
    /// The manifest declared no `app_canister_id`, or that canister did not vouch for the app's
    /// name (returned false, trapped, or was unreachable). Publishing is blocked until an app
    /// canister vouches — the anti-squatting gate.
    NotVerified,
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
