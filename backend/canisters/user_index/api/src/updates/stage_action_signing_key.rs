use candid::CandidType;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use ts_export::ts_export;
use types::Empty;

pub type Args = Empty;

#[ts_export(user_index, stage_action_signing_key)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
    Error(String),
}

#[ts_export(user_index, stage_action_signing_key)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    #[ts(as = "ts_export::TSBytes")]
    pub key_id: ByteBuf,
}
