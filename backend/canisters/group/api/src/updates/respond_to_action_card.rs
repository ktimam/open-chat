use oc_error_codes::OCError;
use serde::{Deserialize, Serialize};
use ts_export::ts_export;
use types::{ActionCardResponse, ActionCardState, MessageId, MessageIndex};

#[ts_export(group, respond_to_action_card)]
#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    pub thread_root_message_index: Option<MessageIndex>,
    pub message_id: MessageId,
    pub response: ActionCardResponse,
}

#[ts_export(group, respond_to_action_card)]
#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    Success(ActionCardState),
    Error(OCError),
}
