use oc_error_codes::OCError;
use serde::{Deserialize, Serialize};
use ts_export::ts_export;
use types::{AiActionDefinition, AiActionRegistration};

#[ts_export(user_index, register_ai_action)]
#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    pub definition: AiActionDefinition,
}

#[ts_export(user_index, register_ai_action)]
#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    Success(AiActionRegistration),
    InvalidRequest(String),
    Error(OCError),
}
