use crate::guards::caller_is_local_user_index_canister;
use crate::read_state;
use crate::updates::create_ai_app_card_provenance::resolve_current_card_app;
use canister_api_macros::update;
use group_index_canister::ai_app_card_authority::{AiAppCardAuthorityBindingV1, AiAppCardAuthorityOperationV1};
use user_index_canister::c2c_ai_app_confirmed_action_route::{Response::*, *};

#[update(guard = "caller_is_local_user_index_canister", msgpack = true)]
async fn c2c_ai_app_confirmed_action_route(args: Args) -> Response {
    if args.confirmation_lease_generation == 0 {
        return InvalidRequest("invalid confirmation lease generation".to_string());
    }
    let binding = AiAppCardAuthorityBindingV1 {
        local_user_index_canister_id: ic_cdk::api::msg_caller(),
        context: args.context.clone(),
        content_hash: args.content_hash,
        operation: AiAppCardAuthorityOperationV1::DepositConfirmedAction {
            confirm_payload_hash: args.confirm_payload_hash,
            confirmation_lease_generation: args.confirmation_lease_generation,
            created_at: args.created_at,
        },
    };
    let validated = match crate::ai_app_card_authority::validate(binding.clone(), &args.authority).await {
        Ok(binding) if binding == validated_binding(&args, binding.local_user_index_canister_id) => binding,
        _ => return InvalidAuthority,
    };
    read_state(|state| {
        resolve_route(
            &validated,
            &state.data.ai_apps,
            &state.data.ai_app_user_keys,
            &state.data.ai_app_scoped_identity_key,
            state.env.canister_id(),
        )
    })
}

fn validated_binding(args: &Args, local_user_index_canister_id: types::CanisterId) -> AiAppCardAuthorityBindingV1 {
    AiAppCardAuthorityBindingV1 {
        local_user_index_canister_id,
        context: args.context.clone(),
        content_hash: args.content_hash,
        operation: AiAppCardAuthorityOperationV1::DepositConfirmedAction {
            confirm_payload_hash: args.confirm_payload_hash,
            confirmation_lease_generation: args.confirmation_lease_generation,
            created_at: args.created_at,
        },
    }
}

fn resolve_route(
    binding: &AiAppCardAuthorityBindingV1,
    registry: &crate::model::ai_app_registry::AiAppRegistry,
    user_keys: &crate::model::ai_app_user_keys::AiAppUserKeys,
    scoped_identity_key: &crate::model::ai_app_scoped_identity::AiAppScopedIdentityKey,
    user_index_canister_id: types::CanisterId,
) -> Response {
    let context = &binding.context;
    let Some(app) = resolve_current_card_app(registry, context.app_id, context.app_revision, &context.action_id) else {
        return AppUnavailable;
    };
    let inbox_canister_id = app.manifest.inbox_canister_id.unwrap();
    let app_canister_id = app.manifest.app_canister_id.unwrap();
    let external_context = match crate::updates::c2c_redeem_ai_app_card_capability::app_scoped_context(
        context,
        app_canister_id,
        scoped_identity_key,
        user_index_canister_id,
    ) {
        Ok(context) => context,
        Err(_) => return AppUnavailable,
    };
    if app.manifest.per_user_keys {
        let confirmer_key = user_keys
            .keys_for_users(context.app_id, &[context.user_id])
            .ok()
            .and_then(|mut keys| keys.pop());
        if confirmer_key.as_ref().is_none_or(|key| key.user_id != context.user_id) {
            return AppUnavailable;
        }
        let selector = match scoped_identity_key.consumer_queue_selector(
            user_index_canister_id,
            context.app_id,
            app_canister_id,
            inbox_canister_id,
            &confirmer_key.as_ref().unwrap().public_key,
        ) {
            Ok(selector) => selector,
            Err(_) => return AppUnavailable,
        };
        Success(SuccessResult {
            inbox_canister_id,
            consumer_queue_selector: serde_bytes::ByteBuf::from(selector.to_vec()),
            consumer_queue_selector_version: 1,
            per_user_keys: true,
            consumer_public_key: None,
            confirmer_key,
            external_context,
        })
    } else {
        let action = app
            .manifest
            .actions
            .iter()
            .find(|action| action.name == context.action_id)
            .expect("resolved card app contains its action");
        let consumer_public_key = action
            .consumer_public_key
            .as_ref()
            .filter(|key| !key.is_empty())
            .or_else(|| (!app.manifest.consumer_public_key.is_empty()).then_some(&app.manifest.consumer_public_key))
            .cloned();
        if consumer_public_key.is_none() {
            return AppUnavailable;
        }
        let selector = match scoped_identity_key.consumer_queue_selector(
            user_index_canister_id,
            context.app_id,
            app_canister_id,
            inbox_canister_id,
            consumer_public_key.as_deref().unwrap(),
        ) {
            Ok(selector) => selector,
            Err(_) => return AppUnavailable,
        };
        Success(SuccessResult {
            inbox_canister_id,
            consumer_queue_selector: serde_bytes::ByteBuf::from(selector.to_vec()),
            consumer_queue_selector_version: 1,
            per_user_keys: false,
            consumer_public_key,
            confirmer_key: None,
            external_context,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ai_app_registry::AiAppRegistry;
    use crate::model::ai_app_scoped_identity::AiAppScopedIdentityKey;
    use crate::model::ai_app_user_keys::AiAppUserKeys;
    use candid::Principal;
    use p256_key_pair::P256KeyPair;
    use rand::SeedableRng;
    use rand::rngs::StdRng;
    use serde_bytes::ByteBuf;
    use types::{
        AiActionCardTemplate, AiActionDefinition, AiAppManifest, AiAppSurface, Chat, MessageId, SurfaceDisplay, UserId,
    };

    fn user(value: u8) -> UserId {
        Principal::from_slice(&[value]).into()
    }

    fn valid_key(seed: u64) -> String {
        P256KeyPair::new(&mut StdRng::seed_from_u64(seed))
            .public_key_pem()
            .to_string()
    }

    fn scoped_identity_key() -> AiAppScopedIdentityKey {
        let mut key = AiAppScopedIdentityKey::default();
        key.ensure_initialized(&mut StdRng::seed_from_u64(58)).unwrap();
        key
    }

    fn resolve_for_test(
        binding: &AiAppCardAuthorityBindingV1,
        registry: &AiAppRegistry,
        user_keys: &AiAppUserKeys,
    ) -> Response {
        resolve_route(
            binding,
            registry,
            user_keys,
            &scoped_identity_key(),
            Principal::from_slice(&[5]),
        )
    }

    fn manifest(per_user_keys: bool, app_key: &str, action_key: Option<&str>) -> AiAppManifest {
        AiAppManifest {
            name: "generic-card-app".to_string(),
            description: String::new(),
            icon_url: None,
            app_canister_id: Some(Principal::from_slice(&[8])),
            inbox_canister_id: Some(Principal::from_slice(&[9])),
            consumer_public_key: app_key.to_string(),
            per_user_keys,
            actions: vec![AiActionDefinition {
                name: "generic.action".to_string(),
                description: String::new(),
                prompt_template: String::new(),
                response_schema: "{}".to_string(),
                card: AiActionCardTemplate {
                    title: String::new(),
                    confirm_label: String::new(),
                    cancel_label: String::new(),
                    rows: Vec::new(),
                    disclosure: None,
                },
                endpoint: String::new(),
                consumer_public_key: action_key.map(str::to_string),
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

    fn published_app(registry: &mut AiAppRegistry, manifest: AiAppManifest) -> (u32, u64) {
        let app = registry.register(user(1), manifest, 10, false).unwrap();
        assert!(registry.publish(app.id, 11));
        (app.id, registry.get(app.id).unwrap().updated)
    }

    fn binding(user_id: UserId, app_id: u32, app_revision: u64) -> AiAppCardAuthorityBindingV1 {
        let group = Principal::from_slice(&[7]);
        AiAppCardAuthorityBindingV1 {
            local_user_index_canister_id: Principal::from_slice(&[6]),
            context: types::AiAppCardContext {
                user_id,
                chat: Chat::Group(group.into()),
                chat_key: format!("group:{group}"),
                thread_root_message_index: None,
                message_id: MessageId::from(1u64),
                app_id,
                app_revision,
                action_id: "generic.action".to_string(),
            },
            content_hash: [3; 32],
            operation: AiAppCardAuthorityOperationV1::DepositConfirmedAction {
                confirm_payload_hash: [4; 32],
                confirmation_lease_generation: 5,
                created_at: 6,
            },
        }
    }

    #[test]
    fn app_level_route_uses_the_exact_current_action_key() {
        let mut registry = AiAppRegistry::default();
        let action_key = valid_key(10);
        let (app_id, revision) = published_app(&mut registry, manifest(false, "", Some(&action_key)));
        let response = resolve_for_test(&binding(user(2), app_id, revision), &registry, &AiAppUserKeys::default());
        match response {
            Success(result) => {
                assert!(!result.per_user_keys);
                assert_eq!(result.consumer_public_key.as_deref(), Some(action_key.as_str()));
                assert_eq!(result.consumer_queue_selector.len(), 32);
                assert_eq!(result.consumer_queue_selector_version, 1);
                assert!(result.confirmer_key.is_none());
                assert_eq!(result.external_context.context_version, 1);
                assert_eq!(result.external_context.app_id, app_id);
                assert_eq!(result.external_context.app_revision, revision);
                assert_eq!(result.external_context.action_id, "generic.action");
                assert_eq!(result.external_context.app_subject.len(), 32);
                assert_eq!(result.external_context.chat_handle.len(), 32);
                assert_eq!(result.external_context.message_handle.len(), 32);
            }
            _ => panic!("a complete current app-level route should resolve"),
        }

        assert!(matches!(
            resolve_for_test(
                &binding(user(2), app_id, revision.saturating_add(1)),
                &registry,
                &AiAppUserKeys::default()
            ),
            AppUnavailable
        ));
    }

    #[test]
    fn per_user_route_returns_only_the_exact_confirmers_key() {
        let mut registry = AiAppRegistry::default();
        let (app_id, revision) = published_app(&mut registry, manifest(true, "", None));
        let confirmer = user(2);
        let other = user(3);
        let confirmer_public_key = valid_key(1);
        let other_public_key = valid_key(2);
        let mut user_keys = AiAppUserKeys::default();
        user_keys.set(confirmer, app_id, confirmer_public_key.clone()).unwrap();
        user_keys.set(other, app_id, other_public_key).unwrap();

        match resolve_for_test(&binding(confirmer, app_id, revision), &registry, &user_keys) {
            Success(result) => {
                assert!(result.per_user_keys);
                assert!(result.consumer_public_key.is_none());
                let key = result.confirmer_key.expect("the confirmer has an exact app key");
                assert_eq!(key.user_id, confirmer);
                assert_eq!(key.public_key, confirmer_public_key);
                assert_eq!(result.consumer_queue_selector.len(), 32);
                assert_eq!(result.consumer_queue_selector_version, 1);
                assert_eq!(result.external_context.app_subject.len(), 32);
            }
            _ => panic!("the exact confirmer key should resolve"),
        }

        assert!(matches!(
            resolve_for_test(&binding(user(4), app_id, revision), &registry, &user_keys),
            AppUnavailable
        ));
    }

    #[test]
    fn deposit_binding_commits_every_route_authority_field() {
        let original = Args {
            context: binding(user(2), 11, 12).context,
            content_hash: [3; 32],
            confirm_payload_hash: [4; 32],
            confirmation_lease_generation: 5,
            created_at: 6,
            authority: ByteBuf::from(vec![7; 32]),
        };
        let owner = Principal::from_slice(&[6]);
        let expected = validated_binding(&original, owner);

        let mut changed = original;
        changed.content_hash[0] ^= 1;
        assert_ne!(validated_binding(&changed, owner), expected);
        changed.content_hash[0] ^= 1;
        changed.confirm_payload_hash[0] ^= 1;
        assert_ne!(validated_binding(&changed, owner), expected);
        changed.confirm_payload_hash[0] ^= 1;
        changed.confirmation_lease_generation += 1;
        assert_ne!(validated_binding(&changed, owner), expected);
        changed.confirmation_lease_generation -= 1;
        changed.created_at += 1;
        assert_ne!(validated_binding(&changed, owner), expected);
        changed.created_at -= 1;
        changed.context.action_id.push_str(".forged");
        assert_ne!(validated_binding(&changed, owner), expected);
    }
}
