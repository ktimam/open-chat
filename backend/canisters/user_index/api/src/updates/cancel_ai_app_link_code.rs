use oc_error_codes::OCError;
use serde::{Deserialize, Serialize};
use ts_export::ts_export;

#[ts_export(user_index, cancel_ai_app_link_code)]
#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    /// The exact one-time bearer returned by `create_ai_app_link_code`.
    pub code: String,
}

#[ts_export(user_index, cancel_ai_app_link_code)]
#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    /// The token no longer exists for this caller. Missing, claimed, foreign, and stale tokens are
    /// intentionally idempotent no-ops and never disconnect an installed app key.
    Success,
    InvalidRequest(String),
    Error(OCError),
}
