use serde::{Deserialize, Serialize};
use ts_export::ts_export;
use types::AiActionRegistration;

#[ts_export(user_index, ai_actions)]
#[derive(Serialize, Deserialize, Debug)]
pub struct Args {}

#[ts_export(user_index, ai_actions)]
#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
}

#[ts_export(user_index, ai_actions)]
#[derive(Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    pub actions: Vec<AiActionRegistration>,
}
