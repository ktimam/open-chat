use crate::guards::caller_is_local_user_index_canister;
use crate::model::ai_app_card_tokens::{ConfirmationGrant, InsertError, TOKEN_BYTES};
use crate::updates::create_ai_app_card_provenance::{canonical_non_direct_chat_key, resolve_current_card_app};
use crate::{RuntimeState, mutate_state};
use ai_app_verifier_canister::c2c_attest_ai_app_card_confirmation_v1::{self, CardConfirmationAttestationBindingV1};
use canister_api_macros::update;
use constants::MINUTE_IN_MS;
use rand::Rng;
use serde_bytes::ByteBuf;
use types::{AiAppCardContext, AiAppRegistration, Milliseconds, ai_app_card_confirm_payload_hash_v1};
use user_index_canister::c2c_create_ai_app_card_confirmation_grant::{Response::*, *};

const CONFIRMATION_GRANT_TTL: Milliseconds = 2 * MINUTE_IN_MS;
const MAX_TOKEN_GENERATION_ATTEMPTS: usize = 10;
const CONFIRMATION_GRANT_ENTROPY_PURPOSE: &[u8] = b"user-index/card-confirmation-grant/v1";

#[update(guard = "caller_is_local_user_index_canister", msgpack = true)]
async fn c2c_create_ai_app_card_confirmation_grant(args: Args) -> Response {
    if !mutate_state(crate::pr2_entropy::is_ready) {
        return Error("confirmation grant service temporarily unavailable".to_string());
    }
    let authority_binding = group_index_canister::ai_app_card_authority::AiAppCardAuthorityBindingV1 {
        local_user_index_canister_id: ic_cdk::api::msg_caller(),
        context: args.context.clone(),
        content_hash: args.content_hash,
        operation: group_index_canister::ai_app_card_authority::AiAppCardAuthorityOperationV1::CreateConfirmationGrant {
            confirm_payload_hash: match ai_app_card_confirm_payload_hash_v1(&args.confirm_payload) {
                Ok(hash) => hash,
                Err(error) => return InvalidRequest(error),
            },
        },
    };
    let authority_token = args.authority.clone();
    if crate::ai_app_card_authority::validate(authority_binding.clone(), &authority_token)
        .await
        .is_err()
    {
        return InvalidRequest("invalid or stale card authority".to_string());
    }
    let quota_principal = candid::Principal::from(args.context.user_id);
    let app_id = args.context.app_id;
    let (prepared, admitted_at) = match mutate_state(|state| {
        let now = state.env.now();
        state
            .data
            .ai_app_call_throttle
            .admit_card_attestation(quota_principal, app_id, now)
            .map_err(|retry_after_ms| Error(format!("confirmation attestation throttled; retry after {retry_after_ms}ms")))?;
        match prepare(args, state) {
            Ok(prepared) => Ok((prepared, now)),
            Err(response) => {
                state
                    .data
                    .ai_app_call_throttle
                    .finish_card_attestation(quota_principal, app_id, now);
                Err(response)
            }
        }
    }) {
        Ok(value) => value,
        Err(response) => return response,
    };

    let response = ai_app_verifier_canister_c2c_client::c2c_attest_ai_app_card_confirmation_v1(
        prepared.binding.app_canister_id,
        &c2c_attest_ai_app_card_confirmation_v1::Args {
            binding: prepared.binding.clone(),
        },
    )
    .await;
    if !mutate_state(crate::pr2_entropy::is_ready) {
        mutate_state(|state| {
            state
                .data
                .ai_app_call_throttle
                .finish_card_attestation(quota_principal, app_id, admitted_at)
        });
        return Error("confirmation grant service temporarily unavailable".to_string());
    }
    let authority_result = crate::ai_app_card_authority::consume(authority_binding, &authority_token).await;
    mutate_state(|state| {
        state
            .data
            .ai_app_call_throttle
            .finish_card_attestation(quota_principal, app_id, admitted_at)
    });
    if authority_result.is_err() {
        return InvalidRequest("card authority changed during confirmation attestation".to_string());
    }
    let response = match response {
        Ok(response) => response,
        Err(_) => return Error("confirmation attestation unavailable".to_string()),
    };
    if !response.vouched || response.binding != prepared.binding {
        return AppUnavailable;
    }
    mutate_state(|state| mint(prepared, state))
}

#[derive(Clone)]
struct PreparedGrant {
    authority_context: AiAppCardContext,
    binding: CardConfirmationAttestationBindingV1,
    app_user_key_fingerprint: Option<[u8; 32]>,
}

fn prepare(args: Args, state: &RuntimeState) -> Result<PreparedGrant, Response> {
    if args.confirm_payload.is_empty() || args.confirm_payload.len() > types::MAX_AI_APP_CONFIRM_PAYLOAD_BYTES {
        return Err(InvalidRequest(format!(
            "confirmation payload must contain 1..={} bytes",
            types::MAX_AI_APP_CONFIRM_PAYLOAD_BYTES
        )));
    }
    let canonical_chat_key = canonical_non_direct_chat_key(args.context.chat).map_err(InvalidRequest)?;
    if canonical_chat_key != args.context.chat_key {
        return Err(InvalidRequest("non-canonical chat key".to_string()));
    }
    if state.data.users.get_by_user_id(&args.context.user_id).is_none() {
        return Err(InvalidProvenance);
    }
    let Some(app) = resolve_current_card_app(
        &state.data.ai_apps,
        args.context.app_id,
        args.context.app_revision,
        &args.context.action_id,
    ) else {
        return Err(AppUnavailable);
    };
    let (app_user_key_fingerprint, app_user_key_version) = current_user_key_binding(state, app, &args.context)?;
    let app_canister_id = app.manifest.app_canister_id.unwrap();
    let external_context = crate::updates::c2c_redeem_ai_app_card_capability::app_scoped_context(
        &args.context,
        app_canister_id,
        &state.data.ai_app_scoped_identity_key,
        state.env.canister_id(),
    )
    .map_err(|_| AppUnavailable)?;
    Ok(PreparedGrant {
        authority_context: args.context,
        binding: CardConfirmationAttestationBindingV1 {
            user_index_canister_id: state.env.canister_id(),
            app_canister_id,
            context: external_context,
            content_hash: args.content_hash,
            confirm_payload: args.confirm_payload,
            app_user_key_version,
        },
        app_user_key_fingerprint,
    })
}

fn mint(prepared: PreparedGrant, state: &mut RuntimeState) -> Response {
    let context = &prepared.authority_context;
    let Some(app) = resolve_current_card_app(&state.data.ai_apps, context.app_id, context.app_revision, &context.action_id)
    else {
        return AppUnavailable;
    };
    if app.manifest.app_canister_id != Some(prepared.binding.app_canister_id)
        || state.data.users.get_by_user_id(&context.user_id).is_none()
    {
        return AppUnavailable;
    }
    let Ok(current_external_context) = crate::updates::c2c_redeem_ai_app_card_capability::app_scoped_context(
        context,
        prepared.binding.app_canister_id,
        &state.data.ai_app_scoped_identity_key,
        state.env.canister_id(),
    ) else {
        return AppUnavailable;
    };
    if current_external_context != prepared.binding.context {
        return AppUnavailable;
    }
    let Ok((current_fingerprint, current_version)) = current_user_key_binding(state, app, context) else {
        return AppUnavailable;
    };
    if current_fingerprint != prepared.app_user_key_fingerprint || current_version != prepared.binding.app_user_key_version {
        return AppUnavailable;
    }
    let payload_hash = match ai_app_card_confirm_payload_hash_v1(&prepared.binding.confirm_payload) {
        Ok(hash) => hash,
        Err(error) => return InvalidRequest(error),
    };
    let now = state.env.now();
    let expires_at = now + CONFIRMATION_GRANT_TTL;
    let mut rng = match crate::pr2_entropy::output_rng(state, CONFIRMATION_GRANT_ENTROPY_PURPOSE) {
        Ok(rng) => rng,
        Err(_) => return Error("confirmation grant service temporarily unavailable".to_string()),
    };
    for _ in 0..MAX_TOKEN_GENERATION_ATTEMPTS {
        let mut raw = [0u8; TOKEN_BYTES];
        rng.fill_bytes(&mut raw);
        let grant = ConfirmationGrant {
            context: prepared.authority_context.clone(),
            content_hash: prepared.binding.content_hash,
            confirm_payload_hash: payload_hash,
            app_canister_id: prepared.binding.app_canister_id,
            app_user_key_fingerprint: prepared.app_user_key_fingerprint,
            app_user_key_version: prepared.binding.app_user_key_version,
            expires_at,
        };
        match state
            .data
            .ai_app_card_tokens
            .insert_confirmation_grant(state.env.canister_id(), &raw, grant, now)
        {
            Ok(()) => {
                return Success(SuccessResult {
                    grant: ByteBuf::from(raw.to_vec()),
                    expires_at,
                });
            }
            Err(InsertError::TokenCollision) => continue,
            Err(_) => return Error("too many outstanding confirmation grants".to_string()),
        }
    }
    Error("could not generate confirmation grant".to_string())
}

pub(crate) fn current_user_key_binding(
    state: &RuntimeState,
    app: &AiAppRegistration,
    context: &AiAppCardContext,
) -> Result<(Option<[u8; 32]>, Option<u64>), Response> {
    if !app.manifest.per_user_keys {
        return Ok((None, None));
    }
    let key = state
        .data
        .ai_app_user_keys
        .keys_for_users(context.app_id, &[context.user_id])
        .ok()
        .and_then(|keys| keys.into_iter().next())
        .ok_or(AppUnavailable)?;
    let version = state
        .data
        .ai_app_user_keys
        .binding_version(context.user_id, context.app_id)
        .ok_or(AppUnavailable)?;
    let inbox_canister_id = app.manifest.inbox_canister_id.ok_or(AppUnavailable)?;
    let app_canister_id = app.manifest.app_canister_id.ok_or(AppUnavailable)?;
    let fingerprint = state
        .data
        .ai_app_scoped_identity_key
        .consumer_queue_selector(
            state.env.canister_id(),
            context.app_id,
            app_canister_id,
            inbox_canister_id,
            &key.public_key,
        )
        .map_err(|_| AppUnavailable)?;
    Ok((Some(fingerprint), Some(version)))
}
