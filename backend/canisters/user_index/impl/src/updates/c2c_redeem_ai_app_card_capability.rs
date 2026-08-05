use crate::model::ai_app_call_throttle::AiAppCallKind;
use crate::model::ai_app_card_tokens::{
    LookupCapabilityResult, MAX_RECIPIENT_PUBLIC_KEY_BYTES, MIN_RECIPIENT_PUBLIC_KEY_BYTES, TOKEN_BYTES,
};
use crate::mutate_state;
use crate::updates::c2c_create_ai_app_card_capability::valid_recipient_key_scheme;
use crate::updates::create_ai_app_card_provenance::resolve_current_card_app;
use canister_api_macros::update;
use user_index_canister::c2c_redeem_ai_app_card_capability::{Response::*, *};

// Public Candid is required because the generic external app canister calls this directly. Dynamic
// authorization happens before consumption: a wrong app caller never burns the user's capability.
#[update(candid = true, msgpack = true)]
fn c2c_redeem_ai_app_card_capability(args: Args) -> Response {
    mutate_state(|state| {
        if !crate::pr2_entropy::is_ready(state) {
            return InvalidRequest("card capability service temporarily unavailable".to_string());
        }
        let caller = state.env.caller();
        let now = state.env.now();
        if let Err(retry_after_ms) = state.data.ai_app_call_throttle.check(AiAppCallKind::CardRedeem, caller, now) {
            return InvalidRequest(format!("too many failed redemption attempts; retry in {retry_after_ms}ms"));
        }
        if args.token.len() != TOKEN_BYTES {
            state
                .data
                .ai_app_call_throttle
                .record_failure(AiAppCallKind::CardRedeem, caller, now);
            return InvalidRequest(format!("token must contain exactly {TOKEN_BYTES} bytes"));
        }
        if !valid_recipient_key_scheme(&args.recipient_key_scheme) {
            state
                .data
                .ai_app_call_throttle
                .record_failure(AiAppCallKind::CardRedeem, caller, now);
            return InvalidRequest("invalid recipient key scheme".to_string());
        }
        if args.recipient_public_key.len() < MIN_RECIPIENT_PUBLIC_KEY_BYTES
            || args.recipient_public_key.len() > MAX_RECIPIENT_PUBLIC_KEY_BYTES
        {
            state
                .data
                .ai_app_call_throttle
                .record_failure(AiAppCallKind::CardRedeem, caller, now);
            return InvalidRequest(format!(
                "recipient public key must contain {MIN_RECIPIENT_PUBLIC_KEY_BYTES}..={MAX_RECIPIENT_PUBLIC_KEY_BYTES} bytes"
            ));
        }
        let capability = match state
            .data
            .ai_app_card_tokens
            .lookup_capability(state.env.canister_id(), &args.token, now)
        {
            LookupCapabilityResult::Valid(value) => value,
            LookupCapabilityResult::Expired => return Expired,
            LookupCapabilityResult::NotFound => {
                state
                    .data
                    .ai_app_call_throttle
                    .record_failure(AiAppCallKind::CardRedeem, caller, now);
                return NotFound;
            }
        };
        if caller != capability.app_canister_id {
            state
                .data
                .ai_app_call_throttle
                .record_failure(AiAppCallKind::CardRedeem, caller, now);
            return NotAuthorized;
        }
        if args.recipient_key_scheme != capability.recipient_key_scheme
            || args.recipient_public_key != capability.recipient_public_key
        {
            state
                .data
                .ai_app_call_throttle
                .record_failure(AiAppCallKind::CardRedeem, caller, now);
            return InvalidRequest("recipient key does not match the capability".to_string());
        }
        let Some(app) = resolve_current_card_app(
            &state.data.ai_apps,
            capability.context.app_id,
            capability.context.app_revision,
            &capability.context.action_id,
        ) else {
            return AppUnavailable;
        };
        if app.manifest.app_canister_id != Some(capability.app_canister_id) {
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
            .ai_app_card_tokens
            .consume_capability(state.env.canister_id(), &args.token)
        {
            return NotFound;
        }
        Success(SuccessResult {
            context: external_context,
            content_hash: capability.content_hash,
            app_canister_id: capability.app_canister_id,
            recipient_key_scheme: capability.recipient_key_scheme,
            recipient_public_key: capability.recipient_public_key,
            scope: capability.scope,
            expires_at: capability.expires_at,
        })
    })
}

pub(crate) fn app_user_key_binding_matches(
    per_user_keys: bool,
    expected_fingerprint: Option<[u8; 32]>,
    expected_version: Option<u64>,
    current_fingerprint: Option<[u8; 32]>,
    current_version: Option<u64>,
) -> bool {
    match (
        per_user_keys,
        expected_fingerprint,
        expected_version,
        current_fingerprint,
        current_version,
    ) {
        (false, None, None, None, None) => true,
        (true, Some(expected_fingerprint), Some(expected_version), Some(current_fingerprint), Some(current_version)) => {
            current_fingerprint == expected_fingerprint && current_version == expected_version
        }
        // Legacy capabilities had no fingerprint or epoch. They must fail closed for a per-user
        // app; either binding on an app-level capability is likewise an invalid mode mismatch.
        _ => false,
    }
}

pub(crate) fn app_scoped_context(
    context: &types::AiAppCardContext,
    app_canister_id: types::CanisterId,
    key: &crate::model::ai_app_scoped_identity::AiAppScopedIdentityKey,
    user_index_canister_id: types::CanisterId,
) -> Result<AppScopedCardContext, String> {
    Ok(AppScopedCardContext {
        context_version: user_index_canister::c2c_redeem_ai_app_card_capability::APP_SCOPED_CARD_CONTEXT_VERSION_V1,
        app_subject: serde_bytes::ByteBuf::from(
            key.app_subject(user_index_canister_id, context.app_id, app_canister_id, context.user_id)?
                .to_vec(),
        ),
        chat_handle: serde_bytes::ByteBuf::from(
            key.chat_handle(user_index_canister_id, context.app_id, app_canister_id, context.chat)?
                .to_vec(),
        ),
        message_handle: serde_bytes::ByteBuf::from(
            key.message_handle(
                user_index_canister_id,
                context.app_id,
                app_canister_id,
                context.chat,
                context.thread_root_message_index,
                context.message_id,
            )?
            .to_vec(),
        ),
        app_id: context.app_id,
        app_revision: context.app_revision,
        action_id: context.action_id.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_mode_and_exact_fingerprint_are_both_required() {
        let fingerprint = [7; 32];
        assert!(app_user_key_binding_matches(
            true,
            Some(fingerprint),
            Some(7),
            Some(fingerprint),
            Some(7)
        ));
        assert!(!app_user_key_binding_matches(
            true,
            Some(fingerprint),
            Some(7),
            Some([8; 32]),
            Some(7)
        ));
        assert!(!app_user_key_binding_matches(true, Some(fingerprint), Some(7), None, Some(7)));
        assert!(!app_user_key_binding_matches(
            true,
            Some(fingerprint),
            None,
            Some(fingerprint),
            Some(7)
        ));
        assert!(!app_user_key_binding_matches(true, None, Some(7), Some(fingerprint), Some(7)));
        assert!(app_user_key_binding_matches(false, None, None, None, None));
        assert!(!app_user_key_binding_matches(false, Some(fingerprint), Some(7), None, None));
    }

    #[test]
    fn readding_the_same_key_does_not_revive_a_pre_revocation_capability() {
        let fingerprint = [7; 32];

        assert!(!app_user_key_binding_matches(
            true,
            Some(fingerprint),
            Some(7),
            Some(fingerprint),
            Some(8)
        ));
    }
}
