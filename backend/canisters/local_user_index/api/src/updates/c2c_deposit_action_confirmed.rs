use candid::CandidType;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use types::{Chat, MessageId, TimestampMillis, UserId};

// Generic deposit: a chat canister (on an ActionCard confirm) hands an OPAQUE plaintext payload plus the
// recipient consumer's P-256 public key. local_user_index wraps the payload in the plaintext context
// envelope (v2), encrypts it to that key, signs it with the platform key, and forwards it to the
// action_inbox canister. OpenChat never interprets the payload.
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Args {
    pub consumer_public_key_pem: String,
    pub plaintext: ByteBuf,
    pub created_at: TimestampMillis,
    pub context: ActionDepositContext,
}

// Where (and by whom) the confirm happened. The sending canister fills this in from its own identity — a
// canister cannot lie about being a different chat because local_user_index only accepts calls from its own
// child canisters, and the context is built here rather than trusted from any user input.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct ActionDepositContext {
    pub chat: Chat,
    pub message_id: MessageId,
    pub confirmed_by: UserId,
}

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum Response {
    Success,
    NotConfigured,
    Error(String),
}
