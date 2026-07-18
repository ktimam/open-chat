use serde::{Deserialize, Serialize};
use ts_export::ts_export;
use types::{AiAppId, AiAppMemberKey, UserId};

// Fan-out key lookup: the registered per-user delivery keys of the REQUESTED users for one app.
// Returns public-key material only (the same PEMs those users registered for delivery), so a chat
// client proposing an action card can address the eventual confirm to EVERY chat member with a key —
// not just the proposer. Users with no registered key for the app are simply absent from the result.
#[ts_export(user_index, ai_app_user_keys)]
#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    pub app_id: AiAppId,
    pub user_ids: Vec<UserId>,
}

#[ts_export(user_index, ai_app_user_keys)]
#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
}

#[ts_export(user_index, ai_app_user_keys)]
#[derive(Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    pub keys: Vec<AiAppMemberKey>,
}
