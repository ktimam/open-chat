//! Plaintext envelope (v4) for confirmed-action deposits. Before the opaque confirm payload is
//! ECIES-encrypted to the consumer's key it is wrapped in a JSON document carrying app-scoped
//! pseudonyms, so the consumer can associate the deposit without receiving global OpenChat identity:
//!
//!   { "context": { "contextVersion": 1, "appSubject": "<base64url HMAC>",
//!                  "chatHandle": "<base64url HMAC>", "messageHandle": "<base64url HMAC>",
//!                  "confirmedAt": <ms number> },
//!     "envelopeVersion": 4, "payloadEncoding": "base64url",
//!     "payload": "<lossless base64url bytes>",
//!     "acknowledgementSecret": "<base64url 32-byte random secret>" }
//!
//! Consumers that do not acknowledge can ignore `acknowledgementSecret` and continue reading
//! `.payload`. The generic envelope remains app-agnostic.

use ct_codecs::{Base64UrlSafeNoPadding, Encoder};
use types::{Chat, TimestampMillis, UserId};
use user_index_canister::c2c_redeem_ai_app_card_capability::{APP_SCOPED_CARD_CONTEXT_VERSION_V1, AppScopedCardContext};

/// Canonical, generic rendering of a chat identity, stable across the whole platform:
///   "direct:<lower user principal>:<higher user principal>"
///   "group:<chat canister principal text>"
///   "channel:<community canister principal text>:<channel id decimal>"
///
/// Direct Chat values are perspective-relative (Direct(other_user)), so the authoritative
/// two-member set is required to identify the same logical conversation from either user canister.
/// Consumers treat the result as an opaque key.
pub fn chat_key(chat: &Chat, member_user_ids: &[UserId]) -> Result<String, String> {
    match chat {
        Chat::Direct(chat_id) => {
            let mut members = member_user_ids.to_vec();
            members.sort_unstable();
            members.dedup();
            if members.len() != 2 {
                return Err("direct chat identity requires exactly two distinct authoritative members".to_string());
            }
            let perspective_user: UserId = (*chat_id).into();
            if !members.contains(&perspective_user) {
                return Err("direct chat perspective is not in the authoritative member pair".to_string());
            }
            Ok(format!("direct:{}:{}", members[0], members[1]))
        }
        Chat::Group(chat_id) => Ok(format!("group:{chat_id}")),
        Chat::Channel(community_id, channel_id) => Ok(format!("channel:{community_id}:{channel_id}")),
    }
}

/// Wraps the opaque confirm payload losslessly in the v4 context envelope. The payload is always
/// base64url-encoded bytes, so malformed UTF-8 and non-JSON inputs round-trip exactly. Only
/// UserIndex-derived app-scoped HMAC handles are disclosed; raw principals and chat/message
/// coordinates remain inside OpenChat's authority boundary.
pub fn wrap_plaintext(
    context: &AppScopedCardContext,
    content_hash: &[u8; 32],
    confirmation_lease_generation: u64,
    confirmed_at: TimestampMillis,
    payload: &[u8],
    acknowledgement_secret: &str,
) -> Result<Vec<u8>, String> {
    if context.context_version != APP_SCOPED_CARD_CONTEXT_VERSION_V1 {
        return Err("unsupported app-scoped card context version".to_string());
    }
    for (name, handle) in [
        ("app_subject", context.app_subject.as_ref()),
        ("chat_handle", context.chat_handle.as_ref()),
        ("message_handle", context.message_handle.as_ref()),
    ] {
        if handle.len() != ecies_payload::ACTION_CARD_CONTEXT_HASH_BYTES {
            return Err(format!(
                "{name} must contain exactly {} bytes",
                ecies_payload::ACTION_CARD_CONTEXT_HASH_BYTES
            ));
        }
    }
    if confirmation_lease_generation == 0 {
        return Err("invalid confirmation lease generation".to_string());
    }
    let payload_value = Base64UrlSafeNoPadding::encode_to_string(payload).map_err(|error| error.to_string())?;
    let app_subject =
        Base64UrlSafeNoPadding::encode_to_string(context.app_subject.as_ref()).map_err(|error| error.to_string())?;
    let chat_handle =
        Base64UrlSafeNoPadding::encode_to_string(context.chat_handle.as_ref()).map_err(|error| error.to_string())?;
    let message_handle =
        Base64UrlSafeNoPadding::encode_to_string(context.message_handle.as_ref()).map_err(|error| error.to_string())?;

    let wrapper = serde_json::json!({
        "envelopeVersion": 4,
        "payloadEncoding": "base64url",
        "context": {
            "contextVersion": context.context_version,
            "appSubject": app_subject,
            "chatHandle": chat_handle,
            "messageHandle": message_handle,
            "confirmedAt": confirmed_at,
            "appId": context.app_id,
            "appRevision": context.app_revision,
            "actionId": context.action_id,
            "contentHash": hex::encode(content_hash),
            "confirmationLeaseGeneration": confirmation_lease_generation,
        },
        "payload": payload_value,
        "acknowledgementSecret": acknowledgement_secret,
    });

    Ok(wrapper.to_string().into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use candid::Principal;
    use serde_bytes::ByteBuf;
    use types::{ChannelId, ChatId, CommunityId, UserId};

    fn principal(bytes: &[u8]) -> Principal {
        Principal::from_slice(bytes)
    }

    fn scoped_context() -> AppScopedCardContext {
        AppScopedCardContext {
            context_version: APP_SCOPED_CARD_CONTEXT_VERSION_V1,
            app_subject: ByteBuf::from(vec![1; 32]),
            chat_handle: ByteBuf::from(vec![2; 32]),
            message_handle: ByteBuf::from(vec![3; 32]),
            app_id: 17,
            app_revision: 23,
            action_id: "sample.action".to_string(),
        }
    }

    #[test]
    fn chat_key_is_canonical() {
        let group: ChatId = principal(&[1, 2, 3]).into();
        assert_eq!(chat_key(&Chat::Group(group), &[]).unwrap(), format!("group:{group}"));

        let community: CommunityId = principal(&[4, 5, 6]).into();
        let channel: ChannelId = 42u32.into();
        assert_eq!(
            chat_key(&Chat::Channel(community, channel), &[]).unwrap(),
            format!("channel:{community}:42")
        );
    }

    #[test]
    fn direct_chat_key_is_the_same_from_both_participant_perspectives() {
        let alice = UserId::from(principal(&[1, 1, 1]));
        let bob = UserId::from(principal(&[2, 2, 2]));

        let alice_view = chat_key(&Chat::Direct(bob.into()), &[alice, bob]).unwrap();
        let bob_view = chat_key(&Chat::Direct(alice.into()), &[bob, alice]).unwrap();

        assert_eq!(alice_view, bob_view);
        assert!(alice_view.starts_with("direct:"));
    }

    #[test]
    fn direct_chat_key_rejects_ambiguous_or_unrelated_members() {
        let alice = UserId::from(principal(&[1, 1, 1]));
        let bob = UserId::from(principal(&[2, 2, 2]));
        let mallory = UserId::from(principal(&[3, 3, 3]));

        assert!(chat_key(&Chat::Direct(bob.into()), &[alice]).is_err());
        assert!(chat_key(&Chat::Direct(bob.into()), &[alice, alice]).is_err());
        assert!(chat_key(&Chat::Direct(bob.into()), &[alice, bob, mallory]).is_err());
        assert!(chat_key(&Chat::Direct(mallory.into()), &[alice, bob]).is_err());
    }

    #[test]
    fn wrap_plaintext_produces_lossless_app_scoped_v4_envelope() {
        let context = scoped_context();

        let payload = br#"{"action_id":"example.action","rows":[{"label":"Amount","value":"$20"}]}"#;
        let wrapped = wrap_plaintext(&context, &[6; 32], 3, 1_720_000_000_000, payload, "ack-secret").unwrap();
        let value: serde_json::Value = serde_json::from_slice(&wrapped).unwrap();

        assert_eq!(
            value["context"]["appSubject"],
            Base64UrlSafeNoPadding::encode_to_string([1; 32]).unwrap()
        );
        assert_eq!(
            value["context"]["chatHandle"],
            Base64UrlSafeNoPadding::encode_to_string([2; 32]).unwrap()
        );
        assert_eq!(
            value["context"]["messageHandle"],
            Base64UrlSafeNoPadding::encode_to_string([3; 32]).unwrap()
        );
        assert_eq!(value["context"]["contextVersion"], 1);
        assert_eq!(value["context"]["confirmedAt"], 1_720_000_000_000u64);
        assert_eq!(value["context"]["appId"], 17);
        assert_eq!(value["context"]["appRevision"], 23);
        assert_eq!(value["context"]["actionId"], "sample.action");
        assert_eq!(value["context"]["contentHash"], hex::encode([6; 32]));
        assert_eq!(value["context"]["confirmationLeaseGeneration"], 3);
        assert_eq!(value["acknowledgementSecret"], "ack-secret");
        assert_eq!(value["envelopeVersion"], 4);
        assert_eq!(value["payloadEncoding"], "base64url");
        assert_eq!(value["payload"], Base64UrlSafeNoPadding::encode_to_string(payload).unwrap());
        for forbidden in ["chat", "messageId", "threadRootMessageIndex", "confirmedBy", "userId"] {
            assert!(
                value["context"].get(forbidden).is_none(),
                "raw context field {forbidden} leaked"
            );
        }
    }

    #[test]
    fn malformed_utf8_and_non_json_payloads_remain_byte_exact() {
        let context = scoped_context();

        for payload in [b"not json".as_slice(), &[0xff, 0xfe, 0x00, 0x80]] {
            let wrapped = wrap_plaintext(&context, &[6; 32], 3, 5, payload, "ack-secret").unwrap();
            let value: serde_json::Value = serde_json::from_slice(&wrapped).unwrap();
            assert_eq!(value["envelopeVersion"], 4);
            assert_eq!(value["payloadEncoding"], "base64url");
            assert_eq!(value["payload"], Base64UrlSafeNoPadding::encode_to_string(payload).unwrap());
        }
    }

    #[test]
    fn malformed_or_legacy_context_fails_closed() {
        let mut context = scoped_context();
        context.app_subject = ByteBuf::from(vec![1; 31]);
        assert!(wrap_plaintext(&context, &[6; 32], 3, 5, b"payload", "ack-secret").is_err());

        let mut context = scoped_context();
        context.context_version = 0;
        assert!(wrap_plaintext(&context, &[6; 32], 3, 5, b"payload", "ack-secret").is_err());
        assert!(wrap_plaintext(&scoped_context(), &[6; 32], 0, 5, b"payload", "ack-secret").is_err());
    }
}
