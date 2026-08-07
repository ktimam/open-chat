use crate::guards::caller_is_governance_principal;
use crate::mutate_state;
use canister_api_macros::proposal;
use canister_tracing_macros::trace;
use oc_error_codes::OCErrorCode;
use types::AiAppId;
use user_index_canister::remove_ai_app::{Response::*, *};

/// Governance recovery for an abandoned app or a lost owner. Registry removal releases the
/// canonical name and global slot; dependent key/link-code cleanup is handled by their lifecycle.
#[proposal(guard = "caller_is_governance_principal")]
#[trace]
fn remove_ai_app(args: Args) -> Response {
    mutate_state(|state| remove_ai_app_impl(args, state))
}

fn remove_ai_app_impl(args: Args, state: &mut crate::RuntimeState) -> Response {
    match remove_app_and_dependents(args.app_id, state) {
        Ok(true) => Success,
        Ok(false) => NotFound,
        Err(message) => Error(OCErrorCode::Throttled.with_message(message)),
    }
}

pub(crate) fn remove_app_and_dependents(app_id: AiAppId, state: &mut crate::RuntimeState) -> Result<bool, String> {
    if !state.data.ai_apps.contains(app_id) {
        return Ok(false);
    }
    // No await occurs in this coordinator. Deletion fails closed while legacy migration is pending.
    // App ids are monotonic, so after registry removal no writer can recreate this id; the durable
    // cleanup queue can safely remove its keys in fixed-size timer batches.
    state
        .data
        .ai_app_user_keys
        .queue_app_cleanup(app_id)
        .map_err(|error| error.message())?;
    state.data.ai_app_link_codes.remove_app(app_id, state.env.now());
    state.data.ai_app_card_tokens.remove_app(app_id);
    state.data.ai_app_chat_link_tokens.remove_app(app_id);
    let removed = state.data.ai_apps.remove(app_id);
    #[cfg(target_arch = "wasm32")]
    crate::jobs::migrate_ai_app_user_keys::start_job_if_required(state);
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ai_app_card_tokens::{Provenance, ProvenanceStatus, TOKEN_BYTES};
    use crate::model::ai_app_user_keys::MIGRATION_BATCH_SIZE;
    use crate::{Data, RuntimeState};
    use p256_key_pair::P256KeyPair;
    use serde::Serialize;
    use std::collections::HashMap;
    use types::{AiAppCardContext, AiAppManifest, Chat, MessageId, UserId};
    use utils::env::test::TestEnv;

    fn manifest() -> AiAppManifest {
        AiAppManifest {
            name: "governance-cleanup".to_string(),
            description: String::new(),
            icon_url: None,
            app_canister_id: None,
            inbox_canister_id: None,
            consumer_public_key: String::new(),
            per_user_keys: true,
            actions: Vec::new(),
            surfaces: Vec::new(),
        }
    }

    #[test]
    fn governance_remove_removes_app_keys_and_pending_link_codes() {
        let env = TestEnv::default();
        let owner: UserId = env.caller.into();
        let canister_id = env.canister_id;
        let now = env.now;
        let mut data = Data::default();
        let app = data.ai_apps.register(owner, manifest(), now, true).unwrap();
        assert!(data.ai_apps.publish(app.id, now));
        let key = P256KeyPair::new(&mut rand::rng()).public_key_pem().to_string();
        data.ai_app_user_keys.set(owner, app.id, key).unwrap();
        let code = "b".repeat(64);
        data.ai_app_link_codes
            .insert(code.clone(), owner, app.id, now + 1_000, now)
            .unwrap();
        let context = AiAppCardContext {
            user_id: owner,
            chat: Chat::Group(canister_id.into()),
            chat_key: String::new(),
            thread_root_message_index: None,
            message_id: MessageId::from(1u64),
            app_id: app.id,
            app_revision: app.updated,
            action_id: String::new(),
        };
        data.ai_app_card_tokens
            .insert_provenance(
                canister_id,
                &[9; TOKEN_BYTES],
                Provenance {
                    context: context.clone(),
                    content_hash: [1; 32],
                    app_user_key_fingerprint: None,
                    app_user_key_version: None,
                    expires_at: now + 1_000,
                },
                now,
            )
            .unwrap();
        let mut state = RuntimeState::new(Box::new(env), data);

        assert!(matches!(remove_ai_app_impl(Args { app_id: app.id }, &mut state), Success));
        assert!(state.data.ai_app_user_keys.keys_for_user(owner).unwrap().is_empty());
        assert!(!state.data.ai_app_link_codes.contains(&code));
        assert_eq!(
            state
                .data
                .ai_app_card_tokens
                .provenance_status(canister_id, &[9; TOKEN_BYTES], &context, &[1; 32], now),
            ProvenanceStatus::NotFound
        );
    }

    #[test]
    fn deletion_fails_closed_until_legacy_key_migration_is_ready() {
        #[derive(Serialize)]
        struct Legacy {
            keys: HashMap<(UserId, types::AiAppId), String>,
        }

        let env = TestEnv::default();
        let owner: UserId = env.caller.into();
        let now = env.now;
        let mut data = Data::default();
        let app = data.ai_apps.register(owner, manifest(), now, true).unwrap();
        assert!(data.ai_apps.publish(app.id, now));
        let legacy = (0..(MIGRATION_BATCH_SIZE + 1))
            .map(|seed| {
                (
                    (
                        UserId::from(candid::Principal::self_authenticating(&(seed as u32).to_le_bytes())),
                        app.id,
                    ),
                    format!("-----BEGIN PUBLIC KEY-----\ninvalid-{seed}\n-----END PUBLIC KEY-----\n"),
                )
            })
            .collect();
        data.ai_app_user_keys = msgpack::deserialize_then_unwrap(&msgpack::serialize_to_vec(&Legacy { keys: legacy }).unwrap());
        let code = "c".repeat(64);
        data.ai_app_link_codes
            .insert(code.clone(), owner, app.id, now + 1_000, now)
            .unwrap();
        let mut state = RuntimeState::new(Box::new(env), data);

        assert!(matches!(remove_ai_app_impl(Args { app_id: app.id }, &mut state), Error(_)));
        assert!(state.data.ai_apps.contains(app.id));
        assert!(state.data.ai_app_link_codes.contains(&code));

        assert_eq!(
            state
                .data
                .ai_app_user_keys
                .migrate_batch(MIGRATION_BATCH_SIZE, |app_id| app_id == app.id),
            1
        );
        assert_eq!(
            state
                .data
                .ai_app_user_keys
                .migrate_batch(MIGRATION_BATCH_SIZE, |app_id| app_id == app.id),
            0
        );

        assert!(matches!(remove_ai_app_impl(Args { app_id: app.id }, &mut state), Success));
        assert!(!state.data.ai_apps.contains(app.id));
        assert!(!state.data.ai_app_link_codes.contains(&code));
    }
}
