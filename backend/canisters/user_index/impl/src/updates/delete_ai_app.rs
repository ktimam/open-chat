use crate::guards::caller_is_openchat_user_or_test_mode;
use crate::{RuntimeState, mutate_state};
use canister_api_macros::update;
use canister_tracing_macros::trace;
use oc_error_codes::OCErrorCode;
use types::UserId;
use user_index_canister::delete_ai_app::{Response::*, *};

// Exposed over candid as well as msgpack so that an external app can remove its manifest with a
// plain candid call from a deploy script.
#[update(guard = "caller_is_openchat_user_or_test_mode", candid = true, msgpack = true)]
#[trace]
fn delete_ai_app(args: Args) -> Response {
    mutate_state(|state| delete_ai_app_impl(args, state))
}

fn delete_ai_app_impl(args: Args, state: &mut RuntimeState) -> Response {
    let caller = state.env.caller();
    // Owner resolution mirrors `register_ai_app`: a registered user's UserId, or an explicitly
    // configured governance deploy identity in local test mode.
    let owner: UserId = if let Some(user) = state.data.users.get_by_principal(&caller) {
        user.user_id
    } else if state.data.test_mode && state.is_caller_governance_principal() {
        caller.into()
    } else {
        return NotFound;
    };

    let Some(app_id) = state.data.ai_apps.owned_app_id(owner, &args.name) else {
        return NotFound;
    };
    match crate::updates::remove_ai_app::remove_app_and_dependents(app_id, state) {
        Ok(true) => Success,
        Ok(false) => NotFound,
        Err(message) => Error(OCErrorCode::Throttled.with_message(message)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Data;
    use crate::model::user::User;
    use p256_key_pair::P256KeyPair;
    use types::AiAppManifest;
    use utils::env::test::TestEnv;

    fn manifest(name: &str) -> AiAppManifest {
        AiAppManifest {
            name: name.to_string(),
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
    fn owner_delete_removes_app_keys_and_pending_link_codes() {
        let env = TestEnv::default();
        let owner: UserId = env.caller.into();
        let now = env.now;
        let mut data = Data::default();
        data.users.add_test_user(User {
            principal: env.caller,
            user_id: owner,
            username: "account-a".to_string(),
            ..Default::default()
        });
        let app = data.ai_apps.register(owner, manifest("ephemeral-app"), now, true).unwrap();
        assert!(data.ai_apps.publish(app.id, now));
        let key = P256KeyPair::new(&mut rand::thread_rng()).public_key_pem().to_string();
        data.ai_app_user_keys.set(owner, app.id, key).unwrap();
        let code = "a".repeat(64);
        data.ai_app_link_codes
            .insert(code.clone(), owner, app.id, now + 1_000, now)
            .unwrap();
        let mut state = RuntimeState::new(Box::new(env), data);

        assert!(matches!(
            delete_ai_app_impl(
                Args {
                    name: "ephemeral-app".to_string()
                },
                &mut state
            ),
            Success
        ));
        assert!(state.data.ai_app_user_keys.keys_for_user(owner).unwrap().is_empty());
        assert!(!state.data.ai_app_link_codes.contains(&code));
    }
}
