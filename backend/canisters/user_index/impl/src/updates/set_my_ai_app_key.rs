use crate::guards::caller_is_openchat_user_or_test_mode;
use crate::model::ai_app_user_keys::canonicalize_p256_public_key;
use crate::updates::remove_my_ai_app_key::invalidate_pending_ai_app_link_state;
use crate::{RuntimeState, mutate_state};
use canister_api_macros::update;
use user_index_canister::set_my_ai_app_key::{Response::*, *};

#[update(guard = "caller_is_openchat_user_or_test_mode", msgpack = true)]
fn set_my_ai_app_key(args: Args) -> Response {
    mutate_state(|state| set_my_ai_app_key_impl(args, state))
}

fn set_my_ai_app_key_impl(args: Args, state: &mut RuntimeState) -> Response {
    let caller = state.env.caller();
    let Some(user_id) = state.data.users.get_by_principal(&caller).map(|user| user.user_id) else {
        return InvalidRequest("caller is not a registered user".to_string());
    };

    let Some(app) = state.data.ai_apps.get(args.app_id) else {
        return AppNotFound;
    };
    if !app.published || !app.manifest.per_user_keys {
        return InvalidRequest("app must be published and configured for per-user keys".to_string());
    }

    let public_key = match validate_user_public_key(&args.public_key) {
        Ok(public_key) => public_key,
        Err(message) => return InvalidRequest(message),
    };

    match state.data.ai_app_user_keys.set_canonical(user_id, args.app_id, public_key) {
        Ok(()) => {
            invalidate_pending_ai_app_link_state(user_id, args.app_id, state);
            Success
        }
        Err(error) => InvalidRequest(error.message()),
    }
}

// Same rules the app-level `consumer_public_key` is validated against in `register_ai_app`; also
// reused by `claim_ai_app_link_code` (the other write path into the per-user key store).
pub(crate) fn validate_user_public_key(public_key: &str) -> Result<String, String> {
    canonicalize_p256_public_key(public_key).map_err(|message| format!("public_key: {message}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Data;
    use crate::model::user::User;
    use p256_key_pair::P256KeyPair;
    use types::{AiAppManifest, UserId};
    use utils::env::test::TestEnv;

    const MALFORMED_PEM: &str = "-----BEGIN PUBLIC KEY-----\nnot-a-key\n-----END PUBLIC KEY-----\n";
    const ED25519_SPKI_PEM: &str =
        "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n-----END PUBLIC KEY-----\n";

    #[test]
    fn rejects_pem_looking_malformed_and_non_p256_keys() {
        assert!(validate_user_public_key(MALFORMED_PEM).is_err());
        assert!(validate_user_public_key(ED25519_SPKI_PEM).is_err());
    }

    #[test]
    fn valid_user_key_is_canonicalized_to_lf_spki_pem() {
        let key = P256KeyPair::new(&mut rand::thread_rng()).public_key_pem().to_string();
        let canonical = validate_user_public_key(&key.replace('\n', "\r\n")).unwrap();
        assert_eq!(canonical, key);
        assert!(!canonical.contains('\r'));
    }

    fn manifest(name: &str, per_user_keys: bool, consumer_public_key: String) -> AiAppManifest {
        AiAppManifest {
            name: name.to_string(),
            description: String::new(),
            icon_url: None,
            app_canister_id: None,
            inbox_canister_id: None,
            consumer_public_key,
            per_user_keys,
            actions: Vec::new(),
            surfaces: Vec::new(),
        }
    }

    #[test]
    fn only_published_per_user_apps_admit_user_keys() {
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
        let key = P256KeyPair::new(&mut rand::thread_rng()).public_key_pem().to_string();
        let draft = data
            .ai_apps
            .register(owner, manifest("draft", true, String::new()), now, true)
            .unwrap();
        let app_level = data
            .ai_apps
            .register(owner, manifest("app-level", false, key.clone()), now, true)
            .unwrap();
        assert!(data.ai_apps.publish(app_level.id, now));
        let mut state = RuntimeState::new(Box::new(env), data);

        assert!(matches!(
            set_my_ai_app_key_impl(
                Args {
                    app_id: draft.id,
                    public_key: key.clone(),
                },
                &mut state,
            ),
            InvalidRequest(_)
        ));
        assert!(matches!(
            set_my_ai_app_key_impl(
                Args {
                    app_id: app_level.id,
                    public_key: key.clone(),
                },
                &mut state,
            ),
            InvalidRequest(_)
        ));

        assert!(state.data.ai_apps.publish(draft.id, now));
        assert!(matches!(
            set_my_ai_app_key_impl(
                Args {
                    app_id: draft.id,
                    public_key: key,
                },
                &mut state,
            ),
            Success
        ));
    }

    #[test]
    fn test_mode_does_not_set_a_key_for_a_phantom_account() {
        let env = TestEnv::default();
        let owner: types::UserId = candid::Principal::from_slice(&[42]).into();
        let now = env.now;
        let mut data = Data::default();
        let app = data
            .ai_apps
            .register(owner, manifest("linked", true, String::new()), now, true)
            .unwrap();
        assert!(data.ai_apps.publish(app.id, now));
        let key = P256KeyPair::new(&mut rand::thread_rng()).public_key_pem().to_string();
        let mut state = RuntimeState::new(Box::new(env), data);

        assert!(matches!(
            set_my_ai_app_key_impl(
                Args {
                    app_id: app.id,
                    public_key: key,
                },
                &mut state,
            ),
            InvalidRequest(message) if message == "caller is not a registered user"
        ));
        assert!(state.data.ai_app_user_keys.keys_for_user(owner).unwrap().is_empty());
    }

    #[test]
    fn direct_set_invalidates_an_outstanding_link_code_for_the_same_tuple() {
        let env = TestEnv::default();
        let owner: UserId = env.caller.into();
        let now = env.now;
        let this_canister = env.canister_id;
        let mut data = Data::default();
        data.users.add_test_user(User {
            principal: env.caller,
            user_id: owner,
            username: "account-a".to_string(),
            ..Default::default()
        });
        let app = data
            .ai_apps
            .register(owner, manifest("linked", true, String::new()), now, true)
            .unwrap();
        assert!(data.ai_apps.publish(app.id, now));
        let code = "cd".repeat(32);
        data.ai_app_link_codes
            .insert_bound(
                code.clone(),
                this_canister,
                owner,
                app.id,
                app.updated,
                candid::Principal::from_slice(&[8]),
                0,
                now + 1_000,
                now,
            )
            .unwrap();
        let key = P256KeyPair::new(&mut rand::thread_rng()).public_key_pem().to_string();
        let mut state = RuntimeState::new(Box::new(env), data);

        assert!(matches!(
            set_my_ai_app_key_impl(
                Args {
                    app_id: app.id,
                    public_key: key,
                },
                &mut state,
            ),
            Success
        ));
        assert!(!state.data.ai_app_link_codes.contains_bound(&code, this_canister));
        assert_eq!(state.data.ai_app_user_keys.binding_version(owner, app.id), Some(1));
    }
}
