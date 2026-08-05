use crate::guards::caller_is_openchat_user_or_test_mode;
use crate::{RuntimeState, mutate_state};
use canister_api_macros::update;
use user_index_canister::remove_my_ai_app_key::{Response::*, *};

// A user removing their OWN per-app delivery key — the OpenChat side of a one-sided "disconnect".
// After this, confirmed actions from this user are no longer encrypted+delivered to the app (the
// app's registration is untouched; other users are unaffected). msgpack-only, mirroring
// set_my_ai_app_key. No key material is supplied — removal needs none, so the E2E invariant holds.
#[update(guard = "caller_is_openchat_user_or_test_mode", msgpack = true)]
fn remove_my_ai_app_key(args: Args) -> Response {
    mutate_state(|state| remove_my_ai_app_key_impl(args, state))
}

fn remove_my_ai_app_key_impl(args: Args, state: &mut RuntimeState) -> Response {
    let caller = state.env.caller();
    let Some(user_id) = state.data.users.get_by_principal(&caller).map(|user| user.user_id) else {
        return InvalidRequest("caller is not a registered user".to_string());
    };
    // An absent-key removal advances a consent epoch so a delayed claim cannot revive access.
    // Bound those durable tombstones to real registry rows; otherwise one caller can allocate an
    // unbounded (user, arbitrary-u32) binding_versions map without ever registering an app.
    if state.data.ai_apps.get(args.app_id).is_none() {
        return InvalidRequest("AI app is not registered".to_string());
    }

    // Idempotent at the API level: removing an absent key is still a successful consent
    // cancellation. The model advances the tuple epoch even in that case.
    match state.data.ai_app_user_keys.remove(user_id, args.app_id) {
        Ok(_) => {
            invalidate_pending_ai_app_link_state(user_id, args.app_id, state);
            Success
        }
        Err(error) => InvalidRequest(error.message()),
    }
}

/// Invalidates every still-pending authority derived from the exact user/app consent tuple. This is
/// also used by direct set, successful app claim, and app-initiated revoke.
pub(crate) fn invalidate_pending_ai_app_link_state(user_id: types::UserId, app_id: types::AiAppId, state: &mut RuntimeState) {
    crate::pr2_entropy::ensure_current_bearer_epoch(state);
    let now = state.env.now();
    state.data.ai_app_link_codes.remove_user_app(user_id, app_id, now);
    state
        .data
        .ai_app_card_tokens
        .remove_capabilities_for_user_app(user_id, app_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Data;
    use crate::model::user::User;
    use types::{AiAppManifest, UserId};
    use utils::env::test::TestEnv;

    #[test]
    fn test_mode_does_not_remove_a_key_for_a_phantom_account() {
        let env = TestEnv::default();
        let mut state = RuntimeState::new(Box::new(env), Data::default());

        assert!(matches!(
            remove_my_ai_app_key_impl(Args { app_id: 7 }, &mut state),
            InvalidRequest(message) if message == "caller is not a registered user"
        ));
    }

    #[test]
    fn disconnect_before_claim_cancels_the_exact_code_and_advances_consent_epoch() {
        let env = TestEnv::default();
        let user_id: UserId = env.caller.into();
        let this_canister = env.canister_id;
        let now = env.now;
        let code = "ef".repeat(32);
        let mut data = Data::default();
        data.users.add_test_user(User {
            principal: env.caller,
            user_id,
            username: "account-a".to_string(),
            ..Default::default()
        });
        let app = data
            .ai_apps
            .register(
                user_id,
                AiAppManifest {
                    name: "linked-app".to_string(),
                    description: String::new(),
                    icon_url: None,
                    app_canister_id: Some(candid::Principal::from_slice(&[8])),
                    inbox_canister_id: None,
                    consumer_public_key: String::new(),
                    per_user_keys: true,
                    actions: Vec::new(),
                    surfaces: Vec::new(),
                },
                now,
                true,
            )
            .unwrap();
        assert!(data.ai_apps.publish(app.id, now));
        let app_id = app.id;
        data.ai_app_link_codes
            .insert_bound(
                code.clone(),
                this_canister,
                user_id,
                app_id,
                now,
                candid::Principal::from_slice(&[8]),
                0,
                now + 1_000,
                now,
            )
            .unwrap();
        let mut state = RuntimeState::new(Box::new(env), data);

        assert!(matches!(remove_my_ai_app_key_impl(Args { app_id }, &mut state), Success));
        assert!(!state.data.ai_app_link_codes.contains_bound(&code, this_canister));
        assert_eq!(state.data.ai_app_user_keys.binding_epoch(user_id, app_id), 1);
    }

    #[test]
    fn arbitrary_unknown_app_ids_cannot_allocate_consent_epochs() {
        let env = TestEnv::default();
        let user_id: UserId = env.caller.into();
        let mut data = Data::default();
        data.users.add_test_user(User {
            principal: env.caller,
            user_id,
            username: "account-a".to_string(),
            ..Default::default()
        });
        let mut state = RuntimeState::new(Box::new(env), data);

        for app_id in 1..=100 {
            assert!(matches!(
                remove_my_ai_app_key_impl(Args { app_id }, &mut state),
                InvalidRequest(message) if message == "AI app is not registered"
            ));
            assert_eq!(state.data.ai_app_user_keys.binding_epoch(user_id, app_id), 0);
        }
    }
}
