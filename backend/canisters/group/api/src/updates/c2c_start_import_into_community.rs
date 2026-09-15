use oc_error_codes::OCError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use types::{AiAppId, CommunityId, UserId};

#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    pub user_id: UserId,
    pub community_id: CommunityId,
}

#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
    Error(OCError),
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct SuccessResult {
    pub total_bytes: u64,
    // AI apps enabled on the source group, carried over so the imported channel
    // keeps them. `#[serde(default)]` so a group canister that predates this
    // field still deserializes (falls back to an empty set = today's behaviour).
    #[serde(default)]
    pub enabled_ai_apps: BTreeSet<AiAppId>,
}
