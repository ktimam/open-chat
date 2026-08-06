use crate::guards::caller_is_local_user_index_canister;
use crate::model::ai_app_card_tokens::{
    Capability, InsertError, MAX_RECIPIENT_PUBLIC_KEY_BYTES, MIN_RECIPIENT_PUBLIC_KEY_BYTES, TOKEN_BYTES,
};
use crate::updates::create_ai_app_card_provenance::{canonical_non_direct_chat_key, resolve_current_card_app};
use crate::{RuntimeState, mutate_state, read_state};
use canister_api_macros::update;
use constants::MINUTE_IN_MS;
use rand::RngCore;
use serde_bytes::ByteBuf;
use user_index_canister::c2c_create_ai_app_card_capability::{Response::*, *};

const CAPABILITY_TTL: types::Milliseconds = 2 * MINUTE_IN_MS;
const MAX_TOKEN_GENERATION_ATTEMPTS: usize = 10;
const CAPABILITY_ENTROPY_PURPOSE: &[u8] = b"user-index/card-capability/v1";

// Successful responses contain a live bearer, so do not trace this method.
#[update(guard = "caller_is_local_user_index_canister", msgpack = true)]
async fn c2c_create_ai_app_card_capability(args: Args) -> Response {
    if !read_state(crate::pr2_entropy::is_ready) {
        return Error("AI-app card capability service temporarily unavailable".to_string());
    }
    let binding = group_index_canister::ai_app_card_authority::AiAppCardAuthorityBindingV1 {
        local_user_index_canister_id: ic_cdk::api::msg_caller(),
        context: args.context.clone(),
        content_hash: args.content_hash,
        operation: group_index_canister::ai_app_card_authority::AiAppCardAuthorityOperationV1::CreatePrivateContextCapability {
            recipient_key_scheme: args.recipient_key_scheme.clone(),
            recipient_public_key_hash: group_index_canister::ai_app_card_authority::opaque_hash_v1(
                group_index_canister::ai_app_card_authority::OpaqueHashPurposeV1::RecipientPublicKey,
                &args.recipient_public_key,
            ),
        },
    };
    if crate::ai_app_card_authority::consume(binding, &args.authority).await.is_err() {
        return InvalidRequest("invalid or replayed card authority".to_string());
    }
    mutate_state(|state| c2c_create_ai_app_card_capability_impl(args, state))
}

fn c2c_create_ai_app_card_capability_impl(args: Args, state: &mut RuntimeState) -> Response {
    if !valid_recipient_key_scheme(&args.recipient_key_scheme) {
        return InvalidRequest("invalid recipient key scheme".to_string());
    }
    if args.recipient_public_key.len() < MIN_RECIPIENT_PUBLIC_KEY_BYTES
        || args.recipient_public_key.len() > MAX_RECIPIENT_PUBLIC_KEY_BYTES
    {
        return InvalidRequest(format!(
            "recipient public key must contain {MIN_RECIPIENT_PUBLIC_KEY_BYTES}..={MAX_RECIPIENT_PUBLIC_KEY_BYTES} bytes"
        ));
    }
    let chat_key = match canonical_non_direct_chat_key(args.context.chat) {
        Ok(value) => value,
        Err(error) => return InvalidRequest(error),
    };
    if chat_key != args.context.chat_key {
        return InvalidRequest("non-canonical chat key".to_string());
    }
    let Some(app) = resolve_current_card_app(
        &state.data.ai_apps,
        args.context.app_id,
        args.context.app_revision,
        &args.context.action_id,
    ) else {
        return AppUnavailable;
    };
    let app_canister_id = app.manifest.app_canister_id.unwrap();
    let now = state.env.now();
    let (app_user_key_fingerprint, app_user_key_version) = if app.manifest.per_user_keys {
        let Some(key) = state
            .data
            .ai_app_user_keys
            .keys_for_users(args.context.app_id, &[args.context.user_id])
            .ok()
            .and_then(|keys| keys.into_iter().next())
        else {
            return AppUnavailable;
        };
        let Some(version) = state
            .data
            .ai_app_user_keys
            .binding_version(args.context.user_id, args.context.app_id)
        else {
            return AppUnavailable;
        };
        let Some(inbox_canister_id) = app.manifest.inbox_canister_id else {
            return AppUnavailable;
        };
        let fingerprint = match state.data.ai_app_scoped_identity_key.consumer_queue_selector(
            state.env.canister_id(),
            args.context.app_id,
            app_canister_id,
            inbox_canister_id,
            &key.public_key,
        ) {
            Ok(fingerprint) => fingerprint,
            Err(_) => return AppUnavailable,
        };
        (Some(fingerprint), Some(version))
    } else {
        (None, None)
    };
    let external_context = match crate::updates::c2c_redeem_ai_app_card_capability::app_scoped_context(
        &args.context,
        app_canister_id,
        &state.data.ai_app_scoped_identity_key,
        state.env.canister_id(),
    ) {
        Ok(context) => context,
        Err(_) => return AppUnavailable,
    };

    let expires_at = now + CAPABILITY_TTL;
    let mut rng = match crate::pr2_entropy::output_rng(state, CAPABILITY_ENTROPY_PURPOSE) {
        Ok(rng) => rng,
        Err(_) => return Error("AI-app card capability service temporarily unavailable".to_string()),
    };
    for _ in 0..MAX_TOKEN_GENERATION_ATTEMPTS {
        let mut raw = [0u8; TOKEN_BYTES];
        rng.fill_bytes(&mut raw);
        let capability = Capability {
            context: args.context.clone(),
            content_hash: args.content_hash,
            app_canister_id,
            recipient_key_scheme: args.recipient_key_scheme.clone(),
            recipient_public_key: args.recipient_public_key.clone(),
            app_user_key_fingerprint,
            app_user_key_version,
            scope: types::AiAppCardCapabilityScope::PrivateContext,
            expires_at,
        };
        match state
            .data
            .ai_app_card_tokens
            .insert_capability(state.env.canister_id(), &raw, capability, now)
        {
            Ok(()) => {
                return Success(SuccessResult {
                    token: ByteBuf::from(raw.to_vec()),
                    expires_at,
                    context: external_context.clone(),
                });
            }
            Err(InsertError::TokenCollision) => continue,
            Err(
                InsertError::UserLimitReached
                | InsertError::AppLimitReached
                | InsertError::StoreFull
                | InsertError::IssuanceRateLimitReached,
            ) => {
                return Error("too many outstanding AI-app card capabilities".to_string());
            }
        }
    }
    Error("can't generate AI-app card capability".to_string())
}

pub(crate) fn valid_recipient_key_scheme(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=64).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-'))
}
