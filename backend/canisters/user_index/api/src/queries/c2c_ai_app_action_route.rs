use serde::{Deserialize, Serialize};
use types::{AiAppId, CanisterId, TimestampMillis};

/// Exact, bounded route lookup used by a LocalUserIndex while delivering a confirmed app card.
/// This endpoint deliberately returns only the fields needed for encryption and delivery; callers
/// must not fetch or scan the public app directory on the confirmation path.
#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    pub app_id: AiAppId,
    pub app_revision: TimestampMillis,
    pub action_id: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
    AppUnavailable,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    pub inbox_canister_id: CanisterId,
    pub per_user_keys: bool,
    /// The exact action override or manifest key. Absent when `per_user_keys` is true.
    pub consumer_public_key: Option<String>,
}
