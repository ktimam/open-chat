use candid::CandidType;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use types::{CanisterId, Chat, MessageId, TimestampMillis, UserId};

// Generic deposit: a chat canister (on an ActionCard confirm) hands an OPAQUE plaintext payload plus the
// recipient consumers' P-256 public keys. local_user_index wraps the payload in the plaintext context
// envelope (v2), encrypts it separately to EACH key (fan-out: one envelope per recipient, so every
// chat member with a registered app key receives the confirmed action), signs each with the platform
// key, and forwards the batch to the action_inbox canister. OpenChat never interprets the payload.
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Args {
    // Legacy single-recipient field, kept for wire compat with pre-fan-out callers. Merged (and
    // deduped) with `consumer_public_key_pems`; may be empty when the plural field is used.
    #[serde(default)]
    pub consumer_public_key_pem: String,
    // Fan-out recipients. The effective recipient set is the dedup of [pem, ...pems]; the call is
    // rejected as Error when that set is empty.
    #[serde(default)]
    pub consumer_public_key_pems: Vec<String>,
    pub plaintext: ByteBuf,
    pub created_at: TimestampMillis,
    // Per-app inbox override (from the app manifest, carried on the card). None -> the globally
    // configured action_inbox. #[serde(default)] for wire compat with pre-field callers.
    #[serde(default)]
    pub inbox_canister_id: Option<CanisterId>,
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
