use oc_error_codes::OCError;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use ts_export::ts_export;
use types::{ActionCardResponse, ActionCardState, MessageId, MessageIndex, UserId};

#[ts_export(user, respond_to_action_card)]
#[derive(Serialize, Deserialize, Debug)]
pub struct Args {
    /// The OTHER participant — direct chats are keyed by them on this canister.
    pub user_id: UserId,
    pub thread_root_message_index: Option<MessageIndex>,
    pub message_id: MessageId,
    pub response: ActionCardResponse,
    // App-rendered cards (Phase 2): the confirmer's app may send the user's EDITED payload here; when
    // present (and within bounds) it is deposited in place of the frozen stored `confirm_payload`.
    // Optional + `default` so it stays backward compatible on the msgpack wire. Opaque bytes —
    // OpenChat never interprets them.
    #[serde(default)]
    #[ts(as = "Option::<ts_export::TSBytes>")]
    pub confirm_payload_override: Option<ByteBuf>,
    /// One-time server grant bound to the exact override. Both optional fields must be absent or
    /// present together; direct-chat edited confirmations remain fail-closed.
    #[serde(default)]
    #[ts(as = "Option::<ts_export::TSBytes>")]
    pub confirmation_grant: Option<ByteBuf>,
}

#[ts_export(user, respond_to_action_card)]
#[derive(Serialize, Deserialize, Debug)]
pub enum Response {
    Success(ActionCardState),
    Error(OCError),
}
