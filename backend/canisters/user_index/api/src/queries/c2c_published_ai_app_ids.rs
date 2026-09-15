use serde::{Deserialize, Serialize};
use types::AiAppId;

/// One enable operation validates the current bounded chat allow-list plus its candidate.
pub const MAX_APP_IDS: usize = 33;

#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    pub app_ids: Vec<AiAppId>,
}

#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
    TooManyApps(u8),
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    /// Sorted, unique ids that still name published directory entries.
    pub app_ids: Vec<AiAppId>,
}
