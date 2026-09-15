use crate::model::ai_app_card_tokens::{MAX_RECIPIENT_PUBLIC_KEY_BYTES, MIN_RECIPIENT_PUBLIC_KEY_BYTES};
use crate::model::ai_app_private_match_tokens::{LookupResult, PrivateMatchCapability, TOKEN_BYTES};
use crate::mutate_state;
use crate::updates::c2c_create_ai_app_card_capability::valid_recipient_key_scheme;
use crate::updates::c2c_redeem_ai_app_card_capability::{
    app_scoped_context, app_user_key_binding_matches, capability_user_exists,
};
use crate::updates::create_ai_app_card_provenance::resolve_current_card_app;
use canister_api_macros::update;
use user_index_canister::c2c_redeem_ai_app_private_match_capability::{Response::*, *};

// The registered app canister calls this endpoint directly. A valid bearer is looked up before
// consulting the invalid-attempt bucket, so random anonymous misses forwarded by one shared app
// caller cannot lock out an exact capability. Every app/key/revision/user check still precedes the
// consume-last step.
#[update(candid = true, msgpack = true)]
fn c2c_redeem_ai_app_private_match_capability(args: Args) -> Response {
    mutate_state(|state| {
        if !crate::pr2_entropy::is_ready(state) {
            return InvalidRequest("private-match capability service temporarily unavailable".to_string());
        }
        let caller = state.env.caller();
        let now = state.env.now();
        if args.token.len() != TOKEN_BYTES {
            return reject_failed_redemption(
                &mut state.data,
                caller,
                now,
                InvalidRequest(format!("token must contain exactly {TOKEN_BYTES} bytes")),
            );
        }
        if !valid_recipient_key_scheme(&args.recipient_key_scheme) {
            return reject_failed_redemption(
                &mut state.data,
                caller,
                now,
                InvalidRequest("invalid recipient key scheme".to_string()),
            );
        }
        if args.recipient_public_key.len() < MIN_RECIPIENT_PUBLIC_KEY_BYTES
            || args.recipient_public_key.len() > MAX_RECIPIENT_PUBLIC_KEY_BYTES
        {
            return reject_failed_redemption(
                &mut state.data,
                caller,
                now,
                InvalidRequest(format!(
                    "recipient public key must contain {MIN_RECIPIENT_PUBLIC_KEY_BYTES}..={MAX_RECIPIENT_PUBLIC_KEY_BYTES} bytes"
                )),
            );
        }

        let capability = match lookup_capability(&mut state.data, state.env.canister_id(), &args.token, caller, now) {
            Ok(value) => value,
            Err(response) => return response,
        };
        if !capability_user_exists(&state.data, capability.context.user_id) {
            return AppUnavailable;
        }
        if caller != capability.app_canister_id {
            return reject_failed_redemption(&mut state.data, caller, now, NotAuthorized);
        }
        if args.recipient_key_scheme != capability.recipient_key_scheme
            || args.recipient_public_key != capability.recipient_public_key
        {
            return reject_failed_redemption(
                &mut state.data,
                caller,
                now,
                InvalidRequest("recipient key does not match the capability".to_string()),
            );
        }

        let Some(app) = resolve_current_card_app(
            &state.data.ai_apps,
            capability.context.app_id,
            capability.context.app_revision,
            &capability.context.action_id,
        ) else {
            return AppUnavailable;
        };
        if app.manifest.app_canister_id != Some(capability.app_canister_id)
            || !app.manifest.per_user_keys
            || !app
                .manifest
                .surfaces
                .iter()
                .any(|surface| surface.kind == "private_match" && surface.display == types::SurfaceDisplay::Sheet)
        {
            return AppUnavailable;
        }
        let (current_user_key, current_user_key_version) = if app.manifest.per_user_keys {
            let key = state
                .data
                .ai_app_user_keys
                .keys_for_users(capability.context.app_id, &[capability.context.user_id])
                .ok()
                .and_then(|keys| keys.into_iter().next())
                .map(|key| key.public_key);
            let version = state
                .data
                .ai_app_user_keys
                .binding_version(capability.context.user_id, capability.context.app_id);
            (key, version)
        } else {
            (None, None)
        };
        if !app_user_key_binding_matches(
            app.manifest.per_user_keys,
            capability.app_user_key_fingerprint,
            capability.app_user_key_version,
            current_user_key.as_deref().and_then(|key| {
                state
                    .data
                    .ai_app_scoped_identity_key
                    .consumer_queue_selector(
                        state.env.canister_id(),
                        capability.context.app_id,
                        capability.app_canister_id,
                        app.manifest.inbox_canister_id?,
                        key,
                    )
                    .ok()
            }),
            current_user_key_version,
        ) {
            return AppUnavailable;
        }
        let external_context = match app_scoped_context(
            &capability.context,
            capability.app_canister_id,
            &state.data.ai_app_scoped_identity_key,
            state.env.canister_id(),
        ) {
            Ok(context) => context,
            Err(_) => return AppUnavailable,
        };
        if !state
            .data
            .ai_app_private_match_tokens
            .consume(state.env.canister_id(), &args.token)
        {
            return NotFound;
        }
        Success(SuccessResult {
            context: external_context,
            source_binding: capability.source_binding,
            app_canister_id: capability.app_canister_id,
            recipient_key_scheme: capability.recipient_key_scheme,
            recipient_public_key: capability.recipient_public_key,
            expires_at: capability.expires_at,
        })
    })
}

#[expect(
    clippy::result_large_err,
    reason = "Preserve the existing public response variants returned by this internal redemption boundary"
)]
fn lookup_capability(
    data: &mut crate::Data,
    canister_id: types::CanisterId,
    token: &[u8],
    caller: candid::Principal,
    now: types::TimestampMillis,
) -> Result<PrivateMatchCapability, Response> {
    match data.ai_app_private_match_tokens.lookup(canister_id, token, now) {
        LookupResult::Valid(value) => Ok(*value),
        LookupResult::Expired => Err(Expired),
        LookupResult::WrongKind | LookupResult::NotFound => Err(reject_failed_redemption(data, caller, now, NotFound)),
    }
}

fn reject_failed_redemption(
    data: &mut crate::Data,
    caller: candid::Principal,
    now: types::TimestampMillis,
    response: Response,
) -> Response {
    if let Err(retry_after_ms) = data.ai_app_private_match_tokens.record_invalid_redeem(caller, now) {
        return InvalidRequest(format!(
            "too many failed private-match redemption attempts; retry in {retry_after_ms}ms"
        ));
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Data;
    use crate::model::ai_app_private_match_tokens::CapabilityKind;
    use candid::Principal;
    use serde_bytes::ByteBuf;
    use types::{AiAppCardContext, Chat, MessageId, UserId};

    fn user(value: u8) -> UserId {
        Principal::from_slice(&[value]).into()
    }

    fn capability(caller: Principal) -> PrivateMatchCapability {
        PrivateMatchCapability {
            context: AiAppCardContext {
                user_id: user(1),
                chat: Chat::Direct(Principal::from_slice(&[2]).into()),
                chat_key: "direct:test".to_string(),
                thread_root_message_index: None,
                message_id: MessageId::from(7u64),
                app_id: 11,
                app_revision: 13,
                action_id: "generic.action".to_string(),
            },
            source_binding: [7; 32],
            app_canister_id: caller,
            recipient_key_scheme: "opaque-v1".to_string(),
            recipient_public_key: ByteBuf::from(vec![5; 48]),
            app_user_key_fingerprint: None,
            app_user_key_version: None,
            kind: CapabilityKind::PrivateMatch,
            expires_at: 100,
        }
    }

    #[test]
    fn invalid_spam_and_wrong_credentials_do_not_burn_or_block_an_exact_bearer() {
        let caller = Principal::from_slice(&[41]);
        let canister_id = Principal::from_slice(&[42]);
        let token = [0xA5; TOKEN_BYTES];
        let mut data = Data::default();
        let expected = capability(caller);
        data.ai_app_private_match_tokens
            .insert(canister_id, &token, expected.clone(), 1)
            .unwrap();

        for index in 0..10 {
            assert!(matches!(
                lookup_capability(&mut data, canister_id, &[index as u8; TOKEN_BYTES], caller, 2,),
                Err(NotFound)
            ));
        }
        assert!(matches!(
            lookup_capability(&mut data, canister_id, &[0x5A; TOKEN_BYTES], caller, 3),
            Err(InvalidRequest(message)) if message.starts_with("too many failed private-match redemption attempts")
        ));

        let found = lookup_capability(&mut data, canister_id, &token, caller, 3)
            .expect("a real exact bearer bypasses only the invalid-miss bucket");
        assert_eq!(found, expected);
        assert_ne!(found.recipient_public_key.as_ref(), &[9; 48]);
        assert!(matches!(
            reject_failed_redemption(
                &mut data,
                caller,
                3,
                InvalidRequest("recipient key does not match the capability".to_string()),
            ),
            InvalidRequest(message) if message.starts_with("too many failed private-match redemption attempts")
        ));
        assert!(matches!(
            lookup_capability(&mut data, canister_id, &token, caller, 3),
            Ok(value) if value == expected
        ));
        assert!(data.ai_app_private_match_tokens.consume(canister_id, &token));
        assert!(matches!(
            lookup_capability(&mut data, canister_id, &token, caller, 3),
            Err(InvalidRequest(message)) if message.starts_with("too many failed private-match redemption attempts")
        ));
    }
}
