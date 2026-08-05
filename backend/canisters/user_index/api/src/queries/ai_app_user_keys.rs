use serde::{Deserialize, Serialize};
use types::{AiAppId, AiAppMemberKey, UserId};

// Guarded C2C fan-out lookup for local_user_index: registered delivery keys of the requested users
// for one app. The caller supplies ids derived by a chat canister from authoritative membership;
// this endpoint is intentionally absent from the public/browser API. Users without a key are absent.
#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    pub app_id: AiAppId,
    pub user_ids: Vec<UserId>,
}

#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    pub keys: Vec<AiAppMemberKey>,
}
