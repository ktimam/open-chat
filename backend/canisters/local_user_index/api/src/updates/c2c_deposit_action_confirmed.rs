use candid::CandidType;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use types::{AiAppId, CanisterId, Chat, MessageId, MessageIndex, TimestampMillis, UserId};

/// Chat canisters send a bounded membership witness used to authenticate the child/chat context.
/// Put the authenticated confirmer first so the actor is never omitted from that assertion.
pub const MAX_ASSERTED_ACTION_CARD_MEMBERS: usize = 9;

pub fn bounded_action_card_members(confirmed_by: UserId, member_user_ids: impl IntoIterator<Item = UserId>) -> Vec<UserId> {
    let mut bounded = vec![confirmed_by];
    for user_id in member_user_ids {
        if !bounded.contains(&user_id) {
            bounded.push(user_id);
            if bounded.len() == MAX_ASSERTED_ACTION_CARD_MEMBERS {
                break;
            }
        }
    }
    bounded
}

// Generic deposit: a chat canister hands local_user_index an opaque payload plus immutable app/action
// provenance and authoritative member ids. local_user_index resolves the exact published manifest,
// inbox and actual confirmer's registered key before encrypting/signing the v4 envelope. OpenChat never
// interprets the payload.
#[derive(CandidType, Serialize, Deserialize, Debug)]
pub struct Args {
    // Legacy sender-carried routing fields, retained only for wire compatibility. The receiver
    // ignores them and resolves the exact published app revision, inbox and confirmer key itself.
    #[serde(default)]
    pub consumer_public_key_pem: String,
    #[serde(default)]
    pub consumer_public_key_pems: Vec<String>,
    pub plaintext: ByteBuf,
    pub created_at: TimestampMillis,
    // Legacy sender-carried inbox override; ignored for app-bound delivery.
    #[serde(default)]
    pub inbox_canister_id: Option<CanisterId>,
    pub context: ActionDepositContext,
    /// One-use GroupIndex authority for this exact card, confirmer, lease, payload hash and
    /// child-authoritative timestamp. UserIndex consumes it immediately before signing.
    pub authority: ByteBuf,
}

// Where (and by whom) the confirm happened. The sending canister fills this in from its own identity — a
// canister cannot lie about being a different chat because local_user_index only accepts calls from its own
// child canisters, and the context is built here rather than trusted from any user input.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct ActionDepositContext {
    pub chat: Chat,
    pub message_id: MessageId,
    #[serde(default)]
    pub thread_root_message_index: Option<MessageIndex>,
    pub confirmed_by: UserId,
    // Producer identity is part of the signed+encrypted provenance. Legacy cards omit app_id.
    #[serde(default)]
    pub app_id: Option<AiAppId>,
    #[serde(default)]
    pub app_revision: Option<TimestampMillis>,
    // Server-only proof outcome copied from the stored card by the trusted chat canister. Older
    // callers deserialize as false and therefore fail closed for app-bound delivery.
    #[serde(default)]
    pub app_verified: bool,
    #[serde(default)]
    pub content_hash: Option<[u8; 32]>,
    #[serde(default)]
    pub confirmation_lease_generation: u64,
    #[serde(default)]
    pub action_id: String,
    // Authoritative chat membership derived by the calling child canister, never by the message
    // sender. Used to validate the chat context and derive its opaque handle; bounded again here.
    #[serde(default)]
    pub member_user_ids: Vec<UserId>,
}

#[derive(CandidType, Serialize, Deserialize, Debug)]
pub enum Response {
    Success,
    /// A downstream bounded call ended ambiguously after dispatch. The chat must keep its lease
    /// and retry the exact card/payload so ActionInbox idempotency can reconcile it.
    OutcomeUnknown,
    NotConfigured,
    Error(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use candid::Principal;

    #[test]
    fn bounded_members_always_include_a_confirmer_outside_the_iteration_prefix() {
        let members: Vec<UserId> = (1..=12).map(|value| Principal::from_slice(&[value]).into()).collect();
        let confirmed_by = members[11];
        let bounded = bounded_action_card_members(confirmed_by, members.iter().copied());

        assert_eq!(bounded.len(), MAX_ASSERTED_ACTION_CARD_MEMBERS);
        assert_eq!(bounded[0], confirmed_by);
        assert!(bounded.contains(&confirmed_by));
        assert_eq!(bounded.iter().filter(|&&user_id| user_id == confirmed_by).count(), 1);
    }
}
