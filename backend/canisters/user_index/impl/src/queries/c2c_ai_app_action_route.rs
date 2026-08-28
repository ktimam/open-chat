use crate::guards::caller_is_local_user_index_canister;
use crate::model::ai_app_registry::AiAppRegistry;
use crate::read_state;
use canister_api_macros::query;
use user_index_canister::c2c_ai_app_action_route::{Response::*, *};

// The caller is a registered LocalUserIndex and the response is constant-sized with respect to the
// directory. Registry lookup is by exact id (HashMap), followed by at most the manifest's bounded
// action count; no app-directory list is cloned or serialized.
#[query(guard = "caller_is_local_user_index_canister", msgpack = true)]
fn c2c_ai_app_action_route(args: Args) -> Response {
    read_state(|state| c2c_ai_app_action_route_impl(args, &state.data.ai_apps))
}

fn c2c_ai_app_action_route_impl(args: Args, apps: &AiAppRegistry) -> Response {
    let Some(app) = apps.get(args.app_id) else {
        return AppUnavailable;
    };
    if !app.published || app.updated != args.app_revision {
        return AppUnavailable;
    }
    let Some(action) = app.manifest.actions.iter().find(|action| action.name == args.action_id) else {
        return AppUnavailable;
    };
    let Some(inbox_canister_id) = app.manifest.inbox_canister_id else {
        return AppUnavailable;
    };
    let consumer_public_key = if app.manifest.per_user_keys {
        None
    } else {
        action
            .consumer_public_key
            .as_ref()
            .filter(|key| !key.is_empty())
            .or_else(|| (!app.manifest.consumer_public_key.is_empty()).then_some(&app.manifest.consumer_public_key))
            .cloned()
    };
    if !app.manifest.per_user_keys && consumer_public_key.is_none() {
        return AppUnavailable;
    }
    Success(SuccessResult {
        inbox_canister_id,
        per_user_keys: app.manifest.per_user_keys,
        consumer_public_key,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ai_app_registry::{AiAppRegistry, MAX_AI_APPS};
    use candid::Principal;
    use types::{AiActionCardTemplate, AiActionDefinition, AiAppManifest, UserId};

    fn manifest(name: String) -> AiAppManifest {
        AiAppManifest {
            name,
            description: "bounded lookup fixture".to_string(),
            icon_url: None,
            app_canister_id: Some(Principal::from_slice(&[8]).into()),
            inbox_canister_id: Some(Principal::from_slice(&[9]).into()),
            consumer_public_key: "MANIFEST_KEY".to_string(),
            per_user_keys: false,
            actions: vec![AiActionDefinition {
                name: "sample.action".to_string(),
                description: "sample".to_string(),
                prompt_template: "sample".to_string(),
                response_schema: "{}".to_string(),
                card: AiActionCardTemplate {
                    title: "Sample".to_string(),
                    confirm_label: "Confirm".to_string(),
                    cancel_label: "Cancel".to_string(),
                    rows: Vec::new(),
                    disclosure: None,
                },
                endpoint: "https://app.example/action".to_string(),
                consumer_public_key: Some("ACTION_KEY".to_string()),
                recipient_scope: None,
                rules: Vec::new(),
                accepts_image: false,
            }],
            surfaces: Vec::new(),
        }
    }

    fn owner(index: usize) -> UserId {
        Principal::from_slice(&(index as u64).to_be_bytes()).into()
    }

    #[test]
    fn exact_route_fails_closed_for_unpublished_stale_unknown_action_or_missing_inbox() {
        let mut apps = AiAppRegistry::default();
        let draft = apps.register(owner(1), manifest("sample-app".to_string()), 1, false).unwrap();
        let args = Args {
            app_id: draft.id,
            app_revision: draft.updated,
            action_id: "sample.action".to_string(),
        };
        assert!(matches!(c2c_ai_app_action_route_impl(args, &apps), AppUnavailable));

        assert!(apps.publish(draft.id, 2));
        let published = apps.get(draft.id).unwrap().clone();
        assert!(matches!(
            c2c_ai_app_action_route_impl(
                Args {
                    app_id: draft.id,
                    app_revision: published.updated,
                    action_id: "sample.action".to_string(),
                },
                &apps,
            ),
            Success(_)
        ));
        assert!(matches!(
            c2c_ai_app_action_route_impl(
                Args {
                    app_id: draft.id,
                    app_revision: published.updated.saturating_add(1),
                    action_id: "sample.action".to_string(),
                },
                &apps,
            ),
            AppUnavailable
        ));
        assert!(matches!(
            c2c_ai_app_action_route_impl(
                Args {
                    app_id: draft.id,
                    app_revision: published.updated,
                    action_id: "unknown".to_string(),
                },
                &apps,
            ),
            AppUnavailable
        ));

        let mut without_inbox = manifest("no-inbox".to_string());
        without_inbox.inbox_canister_id = None;
        let draft = apps.register(owner(2), without_inbox, 3, false).unwrap();
        assert!(apps.publish(draft.id, 4));
        let published = apps.get(draft.id).unwrap();
        assert!(matches!(
            c2c_ai_app_action_route_impl(
                Args {
                    app_id: draft.id,
                    app_revision: published.updated,
                    action_id: "sample.action".to_string(),
                },
                &apps,
            ),
            AppUnavailable
        ));
    }

    #[test]
    fn near_capacity_registry_still_returns_one_bounded_route() {
        let mut apps = AiAppRegistry::default();
        let mut target = None;
        for index in 1..=MAX_AI_APPS {
            let registration = apps
                .register(owner(index), manifest(format!("app-{index}")), index as u64, false)
                .unwrap();
            assert!(apps.publish(registration.id, index as u64 + 1));
            target = Some(apps.get(registration.id).unwrap().clone());
        }
        let target = target.unwrap();
        let response = c2c_ai_app_action_route_impl(
            Args {
                app_id: target.id,
                app_revision: target.updated,
                action_id: "sample.action".to_string(),
            },
            &apps,
        );
        let encoded = msgpack::serialize_to_vec(&response).unwrap();
        assert!(matches!(response, Success(_)));
        assert!(encoded.len() < 512, "exact route response grew to {} bytes", encoded.len());
    }
}
