use crate::{RuntimeState, read_state};
use canister_api_macros::update;
use serde_bytes::ByteBuf;
use user_index_canister::c2c_get_ai_app_action_inbox_selector::{Response::*, *};

/// Private selector discovery for app-level delivery keys. Public registry coordinates and a PEM
/// are intentionally insufficient: only the exact canister pinned into the published app may
/// obtain the HMAC selector. Per-user selectors are issued through the authenticated link claim.
#[update(candid = true, msgpack = true)]
fn c2c_get_ai_app_action_inbox_selector(args: Args) -> Response {
    read_state(|state| c2c_get_ai_app_action_inbox_selector_impl(args, state))
}

fn c2c_get_ai_app_action_inbox_selector_impl(args: Args, state: &RuntimeState) -> Response {
    if args.action_id.is_empty() || args.action_id.len() > 128 {
        return InvalidRequest("invalid action id".to_string());
    }
    let caller = state.env.caller();
    let Some(app) = state.data.ai_apps.get(args.app_id) else {
        return AppUnavailable;
    };
    if app.manifest.app_canister_id != Some(caller) {
        return NotAuthorized;
    }
    if !app.published || app.updated != args.app_revision {
        return AppUnavailable;
    }
    if app.manifest.per_user_keys {
        return InvalidRequest("per-user selectors are issued through an authenticated app link".to_string());
    }
    let Some(inbox_canister_id) = app.manifest.inbox_canister_id else {
        return AppUnavailable;
    };
    let Some(action) = app.manifest.actions.iter().find(|action| action.name == args.action_id) else {
        return AppUnavailable;
    };
    let public_key = action
        .consumer_public_key
        .as_ref()
        .filter(|key| !key.is_empty())
        .unwrap_or(&app.manifest.consumer_public_key);
    if public_key.is_empty() {
        return AppUnavailable;
    }
    let selector = match state.data.ai_app_scoped_identity_key.consumer_queue_selector(
        state.env.canister_id(),
        app.id,
        caller,
        inbox_canister_id,
        public_key,
    ) {
        Ok(selector) => selector,
        Err(_) => return AppUnavailable,
    };
    Success(SuccessResult {
        inbox_canister_id,
        consumer_queue_selector: ByteBuf::from(selector.to_vec()),
        consumer_queue_selector_version: CONSUMER_QUEUE_SELECTOR_VERSION_V1,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Data;
    use candid::Principal;
    use p256_key_pair::P256KeyPair;
    use rand::SeedableRng;
    use rand::rngs::StdRng;
    use types::{AiActionCardTemplate, AiActionDefinition, AiAppManifest, UserId};
    use utils::env::test::TestEnv;

    fn public_key(seed: u64) -> String {
        P256KeyPair::new(&mut StdRng::seed_from_u64(seed))
            .public_key_pem()
            .to_string()
    }

    fn state(caller: Principal, app_canister: Principal) -> (RuntimeState, u32, u64, Principal, String) {
        let env = TestEnv {
            caller,
            ..Default::default()
        };
        let inbox = Principal::from_slice(&[30]);
        let key = public_key(8);
        let action = AiActionDefinition {
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
            consumer_public_key: Some(key.clone()),
            recipient_scope: None,
            rules: Vec::new(),
            accepts_image: false,
        };
        let manifest = AiAppManifest {
            name: "selector-test".to_string(),
            description: String::new(),
            icon_url: None,
            app_canister_id: Some(app_canister),
            inbox_canister_id: Some(inbox),
            consumer_public_key: String::new(),
            per_user_keys: false,
            actions: vec![action],
            surfaces: Vec::new(),
        };
        let owner: UserId = Principal::from_slice(&[31]).into();
        let mut data = Data::default();
        let app = data.ai_apps.register(owner, manifest, 10, true).unwrap();
        assert!(data.ai_apps.publish(app.id, 10));
        let revision = data.ai_apps.get(app.id).unwrap().updated;
        data.ai_app_scoped_identity_key
            .ensure_initialized(&mut StdRng::seed_from_u64(9))
            .unwrap();
        (RuntimeState::new(Box::new(env), data), app.id, revision, inbox, key)
    }

    #[test]
    fn only_exact_registered_app_canister_receives_the_opaque_selector() {
        let app_canister = Principal::from_slice(&[8]);
        let attacker = Principal::from_slice(&[9]);
        let (attacker_state, app_id, revision, _, _) = state(attacker, app_canister);
        assert!(matches!(
            c2c_get_ai_app_action_inbox_selector_impl(
                Args {
                    app_id,
                    app_revision: revision,
                    action_id: "generic.action".to_string(),
                },
                &attacker_state,
            ),
            NotAuthorized
        ));

        let (app_state, app_id, revision, inbox, key) = state(app_canister, app_canister);
        let expected = app_state
            .data
            .ai_app_scoped_identity_key
            .consumer_queue_selector(app_state.env.canister_id(), app_id, app_canister, inbox, &key)
            .unwrap();
        assert!(matches!(
            c2c_get_ai_app_action_inbox_selector_impl(
                Args {
                    app_id,
                    app_revision: revision,
                    action_id: "generic.action".to_string(),
                },
                &app_state,
            ),
            Success(SuccessResult {
                consumer_queue_selector,
                consumer_queue_selector_version: 1,
                ..
            }) if consumer_queue_selector.as_ref() == expected
        ));
    }
}
