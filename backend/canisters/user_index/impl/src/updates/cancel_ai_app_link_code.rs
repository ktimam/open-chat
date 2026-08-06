use crate::guards::caller_is_openchat_user_or_test_mode;
use crate::model::ai_app_link_codes::is_valid_claim_token;
use crate::{RuntimeState, mutate_state};
use canister_api_macros::update;
use oc_error_codes::OCErrorCode;
use user_index_canister::cancel_ai_app_link_code::{Response::*, *};

// This bearer-token endpoint must never be argument or result traced.
#[update(guard = "caller_is_openchat_user_or_test_mode", msgpack = true)]
fn cancel_ai_app_link_code(args: Args) -> Response {
    mutate_state(|state| cancel_ai_app_link_code_impl(args, state))
}

fn cancel_ai_app_link_code_impl(args: Args, state: &mut RuntimeState) -> Response {
    let caller = state.env.caller();
    let Some(user_id) = state.data.users.get_by_principal(&caller).map(|user| user.user_id) else {
        return Error(OCErrorCode::InitiatorNotFound.into());
    };
    if !is_valid_claim_token(&args.code) {
        return InvalidRequest("link code must be 64 lowercase hexadecimal characters".to_string());
    }

    // Missing, claimed, replaced, and foreign tokens share the idempotent response so this does
    // not become an ownership oracle. Installed keys are deliberately outside this endpoint.
    state
        .data
        .ai_app_link_codes
        .cancel_bound(&args.code, state.env.canister_id(), user_id, state.env.now());
    Success
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Data;
    use crate::model::user::User;
    use candid::Principal;
    use p256_key_pair::P256KeyPair;
    use rand::SeedableRng;
    use rand::rngs::StdRng;
    use types::UserId;
    use utils::env::test::TestEnv;

    const CODE: &str = "abababababababababababababababababababababababababababababababab";
    const NEW_CODE: &str = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";

    fn add_user(data: &mut Data, principal: Principal, username: &str) -> UserId {
        let user_id = principal.into();
        data.users.add_test_user(User {
            principal,
            user_id,
            username: username.to_string(),
            ..Default::default()
        });
        user_id
    }

    fn valid_key() -> String {
        P256KeyPair::new(&mut StdRng::seed_from_u64(91)).public_key_pem().to_string()
    }

    #[test]
    fn test_mode_does_not_cancel_for_a_phantom_account() {
        let env = TestEnv::default();
        let mut state = RuntimeState::new(Box::new(env), Data::default());

        assert!(matches!(
            cancel_ai_app_link_code_impl(Args { code: CODE.to_string() }, &mut state),
            Error(error) if error.matches_code(OCErrorCode::InitiatorNotFound)
        ));
    }

    #[test]
    fn cancelling_a_reconnect_token_never_removes_the_installed_key() {
        let env = TestEnv::default();
        let this_canister_id = env.canister_id;
        let now = env.now;
        let mut data = Data::default();
        let user_id = add_user(&mut data, env.caller, "linked-user");
        data.ai_app_user_keys.set(user_id, 7, valid_key()).unwrap();
        data.ai_app_link_codes
            .insert_bound(
                CODE.to_string(),
                this_canister_id,
                user_id,
                7,
                now,
                Principal::from_slice(&[8]),
                data.ai_app_user_keys.binding_epoch(user_id, 7),
                now + 1_000,
                now,
            )
            .unwrap();
        let mut state = RuntimeState::new(Box::new(env), data);

        assert!(matches!(
            cancel_ai_app_link_code_impl(Args { code: CODE.to_string() }, &mut state),
            Success
        ));
        assert!(!state.data.ai_app_link_codes.contains_bound(CODE, this_canister_id));
        let keys = state.data.ai_app_user_keys.keys_for_user(user_id).unwrap();
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].app_id, 7);
    }

    #[test]
    fn a_foreign_user_cannot_cancel_the_token() {
        let env = TestEnv::default();
        let this_canister_id = env.canister_id;
        let now = env.now;
        let mut data = Data::default();
        let _caller = add_user(&mut data, env.caller, "caller");
        let owner = add_user(&mut data, Principal::from_slice(&[22]), "owner");
        data.ai_app_link_codes
            .insert_bound(
                CODE.to_string(),
                this_canister_id,
                owner,
                7,
                now,
                Principal::from_slice(&[8]),
                0,
                now + 1_000,
                now,
            )
            .unwrap();
        let mut state = RuntimeState::new(Box::new(env), data);

        assert!(matches!(
            cancel_ai_app_link_code_impl(Args { code: CODE.to_string() }, &mut state),
            Success
        ));
        assert!(state.data.ai_app_link_codes.contains_bound(CODE, this_canister_id));
    }

    #[test]
    fn a_stale_modal_cannot_cancel_a_newer_token() {
        let env = TestEnv::default();
        let this_canister_id = env.canister_id;
        let now = env.now;
        let mut data = Data::default();
        let user_id = add_user(&mut data, env.caller, "owner");
        for code in [CODE, NEW_CODE] {
            data.ai_app_link_codes
                .insert_bound(
                    code.to_string(),
                    this_canister_id,
                    user_id,
                    7,
                    now,
                    Principal::from_slice(&[8]),
                    0,
                    now + 1_000,
                    now,
                )
                .unwrap();
        }
        let mut state = RuntimeState::new(Box::new(env), data);

        assert!(matches!(
            cancel_ai_app_link_code_impl(Args { code: CODE.to_string() }, &mut state),
            Success
        ));
        assert!(state.data.ai_app_link_codes.contains_bound(NEW_CODE, this_canister_id));
    }
}
