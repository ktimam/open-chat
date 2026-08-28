use oc_error_codes::OCError;
use serde::{Deserialize, Serialize};
use ts_export::ts_export;
use types::{AiAppId, ChannelId};

#[ts_export(community, enabled_ai_apps)]
#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    pub channel_id: ChannelId,
}

#[ts_export(community, enabled_ai_apps)]
#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    Success(SuccessResult),
    Error(OCError),
}

#[ts_export(community, enabled_ai_apps)]
#[derive(Serialize, Deserialize, Debug)]
pub struct SuccessResult {
    pub app_ids: Vec<AiAppId>,
}
