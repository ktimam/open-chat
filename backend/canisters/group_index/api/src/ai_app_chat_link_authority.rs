use serde::{Deserialize, Serialize};
use types::{AiAppId, CanisterId, Chat, TimestampMillis, UserId};

pub const AI_APP_CHAT_LINK_AUTHORITY_TOKEN_BYTES: usize = 32;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct AiAppChatLinkAuthorityBindingV1 {
    pub local_user_index_canister_id: CanisterId,
    pub user_id: UserId,
    pub chat: Chat,
    pub app_id: AiAppId,
    pub app_revision: TimestampMillis,
}
