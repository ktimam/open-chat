//! Plaintext envelope (v2) for confirmed-action deposits. Before the opaque confirm payload is
//! ECIES-encrypted to the consumer's key it is wrapped in a JSON document carrying WHERE the confirmation
//! happened, so the consumer can attribute the deposit without OpenChat ever interpreting the payload:
//!
//!   { "context": { "chat": "<chat key>", "messageId": "<decimal string>",
//!                  "confirmedBy": "<principal text>", "confirmedAt": <ms number> },
//!     "payload": <the original confirm-payload JSON value> }
//!
//! Consumers that don't care about provenance just read `.payload`. This wrapper (together with the v2
//! signing preimage in `ecies_payload`) IS the generic envelope format; nothing in it is app-specific.

use local_user_index_canister::c2c_deposit_action_confirmed::ActionDepositContext;
use types::{Chat, TimestampMillis};

/// Canonical, generic rendering of a chat identity, stable across the whole platform:
///   "group:<chat canister principal text>"
///   "channel:<community canister principal text>:<channel id decimal>"
/// Consumers treat it as an opaque key; it only needs to be deterministic.
pub fn chat_key(chat: &Chat) -> String {
    match chat {
        // Direct chats: rendered per participant — each side's confirm path (the responder's own
        // user canister) identifies the chat by the OTHER participant, so the two participants see
        // different keys for the same chat. Sufficient for per-user-keys apps, where attribution
        // is via confirmedBy; consumers needing a cross-participant key can canonicalize later.
        Chat::Direct(chat_id) => format!("direct:{chat_id}"),
        Chat::Group(chat_id) => format!("group:{chat_id}"),
        Chat::Channel(community_id, channel_id) => format!("channel:{community_id}:{channel_id}"),
    }
}

/// Wraps the opaque confirm payload in the v2 context envelope. The payload is embedded verbatim as a JSON
/// value when it parses as JSON (the normal case — the confirm payload is authored as JSON); otherwise it is
/// embedded as a JSON string so a malformed payload degrades gracefully instead of failing the deposit.
pub fn wrap_plaintext(context: &ActionDepositContext, confirmed_at: TimestampMillis, payload: &[u8]) -> Vec<u8> {
    let payload_value = serde_json::from_slice::<serde_json::Value>(payload)
        .unwrap_or_else(|_| serde_json::Value::String(String::from_utf8_lossy(payload).into_owned()));

    let wrapper = serde_json::json!({
        "context": {
            "chat": chat_key(&context.chat),
            "messageId": context.message_id.to_string(),
            "confirmedBy": context.confirmed_by.to_string(),
            "confirmedAt": confirmed_at,
        },
        "payload": payload_value,
    });

    wrapper.to_string().into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use candid::Principal;
    use types::{ChannelId, ChatId, CommunityId, MessageId, UserId};

    fn principal(bytes: &[u8]) -> Principal {
        Principal::from_slice(bytes)
    }

    #[test]
    fn chat_key_is_canonical() {
        let group: ChatId = principal(&[1, 2, 3]).into();
        assert_eq!(chat_key(&Chat::Group(group)), format!("group:{group}"));

        let community: CommunityId = principal(&[4, 5, 6]).into();
        let channel: ChannelId = 42u32.into();
        assert_eq!(
            chat_key(&Chat::Channel(community, channel)),
            format!("channel:{community}:42")
        );
    }

    #[test]
    fn wrap_plaintext_produces_v2_envelope() {
        let context = ActionDepositContext {
            chat: Chat::Group(principal(&[1, 2, 3]).into()),
            message_id: MessageId::from(123456789u64),
            confirmed_by: UserId::from(principal(&[7, 8, 9])),
        };

        let payload = br#"{"action_id":"example.action","rows":[{"label":"Amount","value":"$20"}]}"#;
        let wrapped = wrap_plaintext(&context, 1_720_000_000_000, payload);
        let value: serde_json::Value = serde_json::from_slice(&wrapped).unwrap();

        assert_eq!(value["context"]["chat"], chat_key(&context.chat));
        assert_eq!(value["context"]["messageId"], "123456789");
        assert_eq!(value["context"]["confirmedBy"], context.confirmed_by.to_string());
        assert_eq!(value["context"]["confirmedAt"], 1_720_000_000_000u64);
        // The original payload is embedded verbatim as a JSON value.
        assert_eq!(
            value["payload"],
            serde_json::from_slice::<serde_json::Value>(payload).unwrap()
        );
    }

    #[test]
    fn wrap_plaintext_tolerates_non_json_payload() {
        let context = ActionDepositContext {
            chat: Chat::Group(principal(&[1]).into()),
            message_id: MessageId::from(1u64),
            confirmed_by: UserId::from(principal(&[2])),
        };

        let wrapped = wrap_plaintext(&context, 5, b"not json");
        let value: serde_json::Value = serde_json::from_slice(&wrapped).unwrap();
        assert_eq!(value["payload"], "not json");
    }
}
