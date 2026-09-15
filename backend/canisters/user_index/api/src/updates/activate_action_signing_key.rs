use candid::CandidType;
use human_readable::ToHumanReadable;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use ts_export::ts_export;

#[ts_export(user_index, activate_action_signing_key)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Args {
    #[ts(as = "ts_export::TSBytes")]
    pub key_id: ByteBuf,
}

#[ts_export(user_index, activate_action_signing_key)]
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum Response {
    Success,
    InvalidKeyId,
    NotStaged,
}

#[derive(Serialize)]
pub struct HumanReadableArgs {
    key_id: String,
}

impl ToHumanReadable for Args {
    type Target = HumanReadableArgs;

    fn to_human_readable(&self) -> Self::Target {
        HumanReadableArgs {
            key_id: hex::encode(&self.key_id),
        }
    }
}
