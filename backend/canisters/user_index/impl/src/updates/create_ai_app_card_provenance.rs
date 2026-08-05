use crate::guards::caller_is_openchat_user;
use crate::model::ai_app_call_throttle::AiAppCallThrottle;
use crate::model::ai_app_card_tokens::{InsertError, Provenance, TOKEN_BYTES};
use crate::model::ai_app_registry::AiAppRegistry;
use crate::{RuntimeState, mutate_state};
use ai_app_verifier_canister::c2c_attest_ai_app_card_v1::{self, AppScopedCardContentCommitmentV1, CardAttestationBindingV1};
use candid::Principal;
use canister_api_macros::update;
use constants::MINUTE_IN_MS;
use oc_error_codes::OCErrorCode;
use rand::RngCore;
use serde_bytes::ByteBuf;
use types::{
    AiAppCardContentCommitmentV1, AiAppCardContext, AiAppId, AiAppRegistration, Chat, Milliseconds, TimestampMillis,
    ai_app_card_content_commitment_hash_v1, validate_ai_app_card_content_v1,
};
use user_index_canister::create_ai_app_card_provenance::{Response::*, *};

const PROVENANCE_TTL: Milliseconds = 10 * MINUTE_IN_MS;
const MAX_TOKEN_GENERATION_ATTEMPTS: usize = 10;
const PROVENANCE_ENTROPY_PURPOSE: &[u8] = b"user-index/card-provenance/v1";

// Successful responses contain a live bearer, so do not trace this method.
#[update(guard = "caller_is_openchat_user", msgpack = true)]
async fn create_ai_app_card_provenance(args: Args) -> Response {
    // Admission happens immediately after authenticated caller resolution and before parsing,
    // hashing, registry scans, or any third-party await. Malformed requests consume quota too.
    let app_id = args.app_id;
    let (admitted_caller, admitted_at) = match mutate_state(|state| {
        let caller = state.env.caller();
        if state.data.users.get_by_principal(&caller).is_none() {
            return Err(Error(OCErrorCode::InitiatorNotFound.into()));
        }
        if !crate::pr2_entropy::is_ready(state) {
            return Err(Error(
                OCErrorCode::C2CError.with_message("AI-app card provenance service temporarily unavailable"),
            ));
        }
        let now = state.env.now();
        admit_card_attestation_call(&mut state.data.ai_app_call_throttle, caller, app_id, now)?;
        Ok((caller, now))
    }) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let prepared = match mutate_state(|state| prepare_ai_app_card_provenance(args, state)) {
        Ok(value) => value,
        Err(response) => {
            mutate_state(|state| {
                state
                    .data
                    .ai_app_call_throttle
                    .finish_card_attestation(admitted_caller, app_id, admitted_at)
            });
            return response;
        }
    };
    let response = ai_app_verifier_canister_c2c_client::c2c_attest_ai_app_card_v1(
        prepared.binding.app_canister_id,
        &c2c_attest_ai_app_card_v1::Args {
            binding: prepared.binding.clone(),
        },
    )
    .await;
    mutate_state(|state| {
        state
            .data
            .ai_app_call_throttle
            .finish_card_attestation(admitted_caller, app_id, admitted_at)
    });
    let response = match response {
        Ok(response) => response,
        // Third-party rejects may contain user/app-controlled text. Do not copy it into an OCError,
        // trace, or client-visible payload.
        Err(_) => return Error(OCErrorCode::C2CError.with_message("AI-app card attestation unavailable")),
    };
    if !response_attests_card(&prepared.binding, &response) {
        return AppUnavailable;
    }
    mutate_state(|state| mint_ai_app_card_provenance(prepared, state))
}

#[derive(Clone)]
struct PreparedCardProvenance {
    caller: Principal,
    context: AiAppCardContext,
    content_hash: [u8; 32],
    binding: CardAttestationBindingV1,
}

fn prepare_ai_app_card_provenance(args: Args, state: &mut RuntimeState) -> Result<PreparedCardProvenance, Response> {
    let caller = state.env.caller();
    let user_id = if let Some(user) = state.data.users.get_by_principal(&caller) {
        user.user_id
    } else {
        return Err(Error(OCErrorCode::InitiatorNotFound.into()));
    };

    // AI-app enablement currently exists only on groups/channels. Direct cards must remain ordinary
    // local UI and cannot obtain app-private capabilities until direct enablement is designed.
    if matches!(args.chat, Chat::Direct(_)) {
        return Err(AppUnavailable);
    }
    let chat_key = match canonical_non_direct_chat_key(args.chat) {
        Ok(value) => value,
        Err(error) => return Err(InvalidRequest(error)),
    };
    if args.action_id != args.content.action_id {
        return Err(InvalidRequest(
            "action_id does not match the attested card content".to_string(),
        ));
    }
    if let Err(error) = validate_ai_app_card_content_v1(&args.content, state.env.now()) {
        return Err(InvalidRequest(error));
    }
    let Some(app) = resolve_current_card_app(&state.data.ai_apps, args.app_id, args.app_revision, &args.action_id) else {
        return Err(AppUnavailable);
    };
    let app_canister_id = app.manifest.app_canister_id.unwrap();
    let context = AiAppCardContext {
        user_id,
        chat: args.chat,
        chat_key,
        thread_root_message_index: args.thread_root_message_index,
        message_id: args.message_id,
        app_id: args.app_id,
        app_revision: args.app_revision,
        action_id: args.action_id,
    };
    let commitment = AiAppCardContentCommitmentV1 {
        user_id,
        chat: context.chat,
        thread_root_message_index: context.thread_root_message_index,
        message_id: context.message_id,
        app_id: context.app_id,
        app_revision: context.app_revision,
        content: args.content,
    };
    let content_hash = ai_app_card_content_commitment_hash_v1(&commitment).map_err(InvalidRequest)?;
    let external_context = crate::updates::c2c_redeem_ai_app_card_capability::app_scoped_context(
        &context,
        app_canister_id,
        &state.data.ai_app_scoped_identity_key,
        state.env.canister_id(),
    )
    .map_err(|_| AppUnavailable)?;
    Ok(PreparedCardProvenance {
        caller,
        context,
        content_hash,
        binding: CardAttestationBindingV1 {
            user_index_canister_id: state.env.canister_id(),
            app_canister_id,
            commitment: AppScopedCardContentCommitmentV1 {
                context: external_context,
                content: commitment.content,
            },
            authority_content_hash: content_hash,
        },
    })
}

fn admit_card_attestation_call(
    throttle: &mut AiAppCallThrottle,
    caller: Principal,
    app_id: AiAppId,
    now: TimestampMillis,
) -> Result<(), Response> {
    throttle
        .admit_card_attestation(caller, app_id, now)
        .map_err(|retry_after_ms| {
            Error(OCErrorCode::Throttled.with_message(format!(
                "too many AI-app card attestation attempts; retry after {retry_after_ms}ms"
            )))
        })
}

fn response_attests_card(expected: &CardAttestationBindingV1, response: &c2c_attest_ai_app_card_v1::Response) -> bool {
    response.vouched && response.binding == *expected
}

fn mint_ai_app_card_provenance(prepared: PreparedCardProvenance, state: &mut RuntimeState) -> Response {
    // A canister message's caller is immutable, but authorization can change while the verifier
    // call is suspended. Re-check the exact admitted caller and its user binding before minting.
    if state.env.caller() != prepared.caller
        || state
            .data
            .users
            .get_by_principal(&prepared.caller)
            .is_none_or(|user| user.user_id != prepared.context.user_id)
    {
        return Error(OCErrorCode::InitiatorNotFound.into());
    }
    let current = resolve_current_card_app(
        &state.data.ai_apps,
        prepared.context.app_id,
        prepared.context.app_revision,
        &prepared.context.action_id,
    );
    if !current.is_some_and(|app| app.manifest.app_canister_id == Some(prepared.binding.app_canister_id)) {
        return AppUnavailable;
    }
    let now = state.env.now();
    let expires_at = now + PROVENANCE_TTL;
    let mut rng = match crate::pr2_entropy::output_rng(state, PROVENANCE_ENTROPY_PURPOSE) {
        Ok(rng) => rng,
        Err(_) => {
            return Error(OCErrorCode::C2CError.with_message("AI-app card provenance service temporarily unavailable"));
        }
    };
    for _ in 0..MAX_TOKEN_GENERATION_ATTEMPTS {
        let mut raw = [0u8; TOKEN_BYTES];
        rng.fill_bytes(&mut raw);
        match state.data.ai_app_card_tokens.insert_provenance(
            state.env.canister_id(),
            &raw,
            Provenance {
                context: prepared.context.clone(),
                content_hash: prepared.content_hash,
                expires_at,
            },
            now,
        ) {
            Ok(()) => {
                return Success(SuccessResult {
                    provenance: ByteBuf::from(raw.to_vec()),
                    expires_at,
                });
            }
            Err(InsertError::TokenCollision) => continue,
            Err(
                InsertError::UserLimitReached
                | InsertError::AppLimitReached
                | InsertError::StoreFull
                | InsertError::IssuanceRateLimitReached,
            ) => {
                return Error(OCErrorCode::Throttled.with_message("too many outstanding AI-app card provenances"));
            }
        }
    }
    Error(OCErrorCode::Impossible.with_message("can't generate AI-app card provenance"))
}

pub(crate) fn canonical_non_direct_chat_key(chat: Chat) -> Result<String, String> {
    match chat {
        Chat::Direct(_) => Err("AI-app card capabilities are unavailable in direct chats".to_string()),
        Chat::Group(chat_id) => Ok(format!("group:{chat_id}")),
        Chat::Channel(community_id, channel_id) => Ok(format!("channel:{community_id}:{channel_id}")),
    }
}

pub(crate) fn resolve_current_card_app<'a>(
    registry: &'a AiAppRegistry,
    app_id: AiAppId,
    app_revision: TimestampMillis,
    action_id: &str,
) -> Option<&'a AiAppRegistration> {
    let app = registry.get(app_id)?;
    let action = app.manifest.actions.iter().find(|action| action.name == action_id)?;
    let app_level_route_is_complete = app.manifest.per_user_keys
        || action.consumer_public_key.as_ref().is_some_and(|key| !key.is_empty())
        || !app.manifest.consumer_public_key.is_empty();
    if !app.published
        || app.updated != app_revision
        || app.manifest.app_canister_id.is_none()
        || app.manifest.inbox_canister_id.is_none()
        || !app_level_route_is_complete
        || !app.manifest.surfaces.iter().any(|surface| surface.kind == "card")
    {
        return None;
    }
    Some(app)
}

#[cfg(test)]
mod tests {
    use super::*;
    use candid::Principal;
    use types::{AiActionDefinition, AiAppManifest, AiAppSurface, MessageId, SurfaceDisplay, UserId};

    fn manifest() -> AiAppManifest {
        AiAppManifest {
            name: "generic-app".to_string(),
            description: String::new(),
            icon_url: None,
            app_canister_id: Some(Principal::from_slice(&[8])),
            inbox_canister_id: Some(Principal::from_slice(&[9])),
            consumer_public_key: "delivery-key".to_string(),
            per_user_keys: false,
            actions: vec![AiActionDefinition {
                name: "generic.action".to_string(),
                description: String::new(),
                prompt_template: String::new(),
                response_schema: "{}".to_string(),
                card: types::AiActionCardTemplate {
                    title: String::new(),
                    confirm_label: String::new(),
                    cancel_label: String::new(),
                    rows: Vec::new(),
                    disclosure: None,
                },
                endpoint: String::new(),
                consumer_public_key: None,
                rules: Vec::new(),
                accepts_image: false,
            }],
            surfaces: vec![AiAppSurface {
                kind: "card".to_string(),
                url: "https://app.example/card".to_string(),
                display: SurfaceDisplay::Sheet,
            }],
        }
    }

    #[test]
    fn card_app_resolution_requires_exact_published_revision_action_canister_and_surface() {
        let mut registry = AiAppRegistry::default();
        let owner: UserId = Principal::from_slice(&[1]).into();
        let app = registry.register(owner, manifest(), 10, false).unwrap();
        assert!(resolve_current_card_app(&registry, app.id, app.updated, "generic.action").is_none());
        assert!(registry.publish(app.id, 11));
        let current = registry.get(app.id).unwrap().updated;
        assert!(resolve_current_card_app(&registry, app.id, current, "generic.action").is_some());
        assert!(resolve_current_card_app(&registry, app.id, current + 1, "generic.action").is_none());
        assert!(resolve_current_card_app(&registry, app.id, current, "spoofed.action").is_none());
    }

    #[test]
    fn direct_chat_is_fail_closed_until_direct_app_enablement_exists() {
        let other = Principal::from_slice(&[2]).into();
        assert!(canonical_non_direct_chat_key(Chat::Direct(other)).is_err());
    }

    #[test]
    fn unregistered_caller_is_rejected_even_in_test_mode() {
        let mut env = utils::env::test::TestEnv::default();
        env.caller = Principal::from_slice(&[99]);
        let mut data = crate::Data::default();
        data.test_mode = true;
        let mut state = RuntimeState::new(Box::new(env), data);
        let group = Principal::from_slice(&[7]).into();
        let response = prepare_ai_app_card_provenance(
            Args {
                app_id: 1,
                app_revision: 1,
                action_id: "generic.action".to_string(),
                content: types::AiAppCardContentV1 {
                    title: "Review".to_string(),
                    rows: vec![types::ActionCardRow {
                        label: "Value".to_string(),
                        value: "42".to_string(),
                    }],
                    confirm_label: "Confirm".to_string(),
                    cancel_label: "Cancel".to_string(),
                    action_id: "generic.action".to_string(),
                    disclosure: None,
                    expires_at: None,
                    confirm_payload: Some(ByteBuf::from(b"payload".to_vec())),
                },
                chat: Chat::Group(group),
                thread_root_message_index: None,
                message_id: MessageId::from(1u64),
            },
            &mut state,
        );
        assert!(matches!(response, Err(Error(error)) if error.matches_code(OCErrorCode::InitiatorNotFound)));
    }
}
