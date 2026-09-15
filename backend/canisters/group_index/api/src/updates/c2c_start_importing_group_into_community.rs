use oc_error_codes::OCError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use types::{AiAppId, ChatId, UserId};

#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    pub user_id: UserId,
    pub group_id: ChatId,
}

#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
    GroupNotFound,
    AlreadyImportingToAnotherCommunity,
    UserNotInGroup,
    NotAuthorized,
    UserSuspended,
    UserLapsed,
    ChatFrozen,
    InternalError(String),
    Error(OCError),
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct SuccessResult {
    pub total_bytes: u64,
    // Enabled AI apps forwarded from the source group so the imported channel
    // inherits them. `#[serde(default)]` for rollout compat (see group api).
    #[serde(default)]
    pub enabled_ai_apps: BTreeSet<AiAppId>,
}
