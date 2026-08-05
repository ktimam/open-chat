use serde::{Deserialize, Serialize};
use ts_export::ts_export;
use types::{AiAppUserKey, UserId};

#[ts_export(user_index, my_ai_app_keys)]
#[derive(Serialize, Deserialize, Debug)]
pub struct Args {}

#[ts_export(user_index, my_ai_app_keys)]
#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
}

#[ts_export(user_index, my_ai_app_keys)]
#[derive(Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    /// The OpenChat user the caller resolved to, or None when the caller is not a registered user.
    /// Never fabricated — see the impl for why a test_mode fallback here was actively harmful.
    pub user_id: Option<UserId>,
    pub keys: Vec<AiAppUserKey>,
}
