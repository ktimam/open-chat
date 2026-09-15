use crate::guards::caller_is_local_user_index_canister;
use crate::model::ai_app_card_tokens::{MAX_RECIPIENT_PUBLIC_KEY_BYTES, MIN_RECIPIENT_PUBLIC_KEY_BYTES};
use crate::model::ai_app_private_match_tokens::{CapabilityKind, InsertError, PrivateMatchCapability, TOKEN_BYTES};
use crate::updates::c2c_create_ai_app_card_capability::valid_recipient_key_scheme;
use crate::updates::create_ai_app_card_provenance::{
    canonical_card_chat_key, resolve_current_card_app, validate_direct_card_lui_route,
};
use crate::{RuntimeState, mutate_state, read_state};
use canister_api_macros::update;
use constants::MINUTE_IN_MS;
use rand::Rng;
use user_index_canister::c2c_create_ai_app_private_match_capability::{Response::*, *};

const PRIVATE_MATCH_CAPABILITY_TTL: types::Milliseconds = MINUTE_IN_MS;
const MAX_TOKEN_GENERATION_ATTEMPTS: usize = 10;
const PRIVATE_MATCH_CAPABILITY_ENTROPY_PURPOSE: &[u8] = b"user-index/private-match-capability/v1";

// Successful responses contain a live bearer, so do not trace this method.
#[update(guard = "caller_is_local_user_index_canister", msgpack = true)]
async fn c2c_create_ai_app_private_match_capability(args: Args) -> Response {
    if args.source_binding.iter().all(|byte| *byte == 0) {
        return InvalidSource;
    }
    if !read_state(crate::pr2_entropy::is_ready) {
        return Error("AI-app private-match capability service temporarily unavailable".to_string());
    }
    let caller = ic_cdk::api::msg_caller();
    let Some(admitted_account_lifecycle_epoch) =
        read_state(|state| state.data.users.account_lifecycle_epoch(&args.context.user_id))
    else {
        return AppUnavailable;
    };
    if matches!(args.context.chat, types::Chat::Direct(_)) {
        if let Err(error) = read_state(|state| validate_direct_card_lui_route(&args.context, &args.authority, caller, state)) {
            return InvalidRequest(error);
        }
    } else {
        let binding = group_index_canister::ai_app_card_authority::AiAppCardAuthorityBindingV1 {
            local_user_index_canister_id: caller,
            context: args.context.clone(),
            // Private-match uses its own operation field, never the legacy card content slot.
            content_hash: [0; 32],
            operation:
                group_index_canister::ai_app_card_authority::AiAppCardAuthorityOperationV1::CreatePrivateMatchCapability {
                    source_binding: args.source_binding,
                    recipient_key_scheme: args.recipient_key_scheme.clone(),
                    recipient_public_key_hash: group_index_canister::ai_app_card_authority::opaque_hash_v1(
                        group_index_canister::ai_app_card_authority::OpaqueHashPurposeV1::RecipientPublicKey,
                        &args.recipient_public_key,
                    ),
                },
        };
        if crate::ai_app_card_authority::consume(binding, &args.authority).await.is_err() {
            return InvalidSource;
        }
    }

    mutate_state(|state| {
        if matches!(args.context.chat, types::Chat::Direct(_))
            && let Err(error) = validate_direct_card_lui_route(&args.context, &args.authority, caller, state)
        {
            return InvalidRequest(error);
        }
        create(args, admitted_account_lifecycle_epoch, state)
    })
}

fn create(args: Args, admitted_account_lifecycle_epoch: u64, state: &mut RuntimeState) -> Response {
    if state.data.users.account_lifecycle_epoch(&args.context.user_id) != Some(admitted_account_lifecycle_epoch) {
        return AppUnavailable;
    }
    if matches!(args.context.chat, types::Chat::Direct(_)) && !args.authority.is_empty() {
        return InvalidRequest("direct chat must not carry group route authority".to_string());
    }
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
    let chat_key = match canonical_card_chat_key(args.context.user_id, args.context.chat) {
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
    if !app.manifest.per_user_keys
        || !app
            .manifest
            .surfaces
            .iter()
            .any(|surface| surface.kind == "private_match" && surface.display == types::SurfaceDisplay::Sheet)
    {
        return AppUnavailable;
    }
    let app_canister_id = app.manifest.app_canister_id.unwrap();
    let now = state.env.now();
    let Some(key) = state
        .data
        .ai_app_user_keys
        .keys_for_users(args.context.app_id, &[args.context.user_id])
        .ok()
        .and_then(|keys| keys.into_iter().next())
    else {
        return AppUnavailable;
    };
    let Some(app_user_key_version) = state
        .data
        .ai_app_user_keys
        .binding_version(args.context.user_id, args.context.app_id)
    else {
        return AppUnavailable;
    };
    let Some(inbox_canister_id) = app.manifest.inbox_canister_id else {
        return AppUnavailable;
    };
    let app_user_key_fingerprint = match state.data.ai_app_scoped_identity_key.consumer_queue_selector(
        state.env.canister_id(),
        args.context.app_id,
        app_canister_id,
        inbox_canister_id,
        &key.public_key,
    ) {
        Ok(value) => value,
        Err(_) => return AppUnavailable,
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

    let expires_at = now.saturating_add(PRIVATE_MATCH_CAPABILITY_TTL);
    let mut rng = match crate::pr2_entropy::output_rng(state, PRIVATE_MATCH_CAPABILITY_ENTROPY_PURPOSE) {
        Ok(rng) => rng,
        Err(_) => return Error("AI-app private-match capability service temporarily unavailable".to_string()),
    };
    for _ in 0..MAX_TOKEN_GENERATION_ATTEMPTS {
        let mut raw = [0u8; TOKEN_BYTES];
        rng.fill_bytes(&mut raw);
        let capability = PrivateMatchCapability {
            context: args.context.clone(),
            source_binding: args.source_binding,
            app_canister_id,
            recipient_key_scheme: args.recipient_key_scheme.clone(),
            recipient_public_key: args.recipient_public_key.clone(),
            app_user_key_fingerprint: Some(app_user_key_fingerprint),
            app_user_key_version: Some(app_user_key_version),
            kind: CapabilityKind::PrivateMatch,
            expires_at,
        };
        match state
            .data
            .ai_app_private_match_tokens
            .insert(state.env.canister_id(), &raw, capability, now)
        {
            Ok(()) => {
                return Success(SuccessResult {
                    token: raw.to_vec().into(),
                    expires_at,
                    context: external_context.clone(),
                });
            }
            Err(InsertError::TokenCollision) => continue,
            Err(
                InsertError::WrongKind
                | InsertError::UserLimitReached
                | InsertError::AppLimitReached
                | InsertError::StoreFull
                | InsertError::IssuanceRateLimitReached,
            ) => return Error("too many private-match capability requests".to_string()),
        }
    }
    Error("can't generate AI-app private-match capability".to_string())
}
