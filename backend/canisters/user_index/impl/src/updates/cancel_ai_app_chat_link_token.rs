use crate::guards::caller_is_openchat_user_or_test_mode;
use crate::model::ai_app_chat_link_tokens::TOKEN_BYTES;
use crate::{RuntimeState, mutate_state};
use canister_api_macros::update;
use oc_error_codes::OCErrorCode;
use user_index_canister::cancel_ai_app_chat_link_token::{Response::*, *};

// This exact-bearer endpoint must never be traced.
#[update(guard = "caller_is_openchat_user_or_test_mode", msgpack = true)]
fn cancel_ai_app_chat_link_token(args: Args) -> Response {
    mutate_state(|state| cancel_impl(args, state))
}

fn cancel_impl(args: Args, state: &mut RuntimeState) -> Response {
    if args.token.len() != TOKEN_BYTES {
        return InvalidRequest(format!("token must contain exactly {TOKEN_BYTES} bytes"));
    }
    let Some(user_id) = state
        .data
        .users
        .get_by_principal(&state.env.caller())
        .map(|user| user.user_id)
    else {
        return Error(OCErrorCode::InitiatorNotFound.into());
    };
    state
        .data
        .ai_app_chat_link_tokens
        .cancel(state.env.canister_id(), &args.token, user_id, state.env.now());
    Success
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Data;
    use crate::model::ai_app_chat_link_tokens::{AiAppChatLinkToken, LookupResult};
    use crate::model::user::User;
    use candid::Principal;
    use serde_bytes::ByteBuf;
    use types::{Chat, UserId};
    use utils::env::test::TestEnv;

    const RAW: [u8; TOKEN_BYTES] = [0xA5; TOKEN_BYTES];

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

    fn state(caller: Principal, owner: Principal) -> RuntimeState {
        let mut env = TestEnv::default();
        env.caller = caller;
        let mut data = Data::default();
        let _ = add_user(&mut data, caller, "caller");
        let owner_id = if caller == owner { caller.into() } else { add_user(&mut data, owner, "owner") };
        data.ai_app_chat_link_tokens
            .insert(
                env.canister_id,
                &RAW,
                AiAppChatLinkToken {
                    user_id: owner_id,
                    chat: Chat::Group(Principal::from_slice(&[20]).into()),
                    chat_name: "Household".to_string(),
                    app_id: 7,
                    app_revision: 8,
                    app_canister_id: Principal::from_slice(&[9]),
                    issuer_local_user_index_canister_id: Principal::from_slice(&[10]),
                    app_user_key_fingerprint: [1; 32],
                    app_user_key_version: 2,
                    app_subject: [3; 32],
                    chat_handle: [4; 32],
                    expires_at: env.now + 1_000,
                },
                env.now,
            )
            .unwrap();
        RuntimeState::new(Box::new(env), data)
    }

    #[test]
    fn exact_owner_cancels_while_foreign_and_malformed_requests_fail_closed() {
        let owner = Principal::from_slice(&[7]);
        let attacker = Principal::from_slice(&[8]);
        let mut foreign = state(attacker, owner);
        assert!(matches!(
            cancel_impl(
                Args {
                    token: ByteBuf::from(RAW.to_vec()),
                },
                &mut foreign,
            ),
            Success
        ));
        assert!(matches!(
            foreign
                .data
                .ai_app_chat_link_tokens
                .lookup(foreign.env.canister_id(), &RAW, foreign.env.now(),),
            LookupResult::Valid(_)
        ));

        let mut owned = state(owner, owner);
        assert!(matches!(
            cancel_impl(
                Args {
                    token: ByteBuf::from(RAW.to_vec()),
                },
                &mut owned,
            ),
            Success
        ));
        assert!(matches!(
            owned
                .data
                .ai_app_chat_link_tokens
                .lookup(owned.env.canister_id(), &RAW, owned.env.now()),
            LookupResult::NotFound
        ));
        assert!(matches!(
            cancel_impl(
                Args {
                    token: ByteBuf::from(vec![0; TOKEN_BYTES - 1]),
                },
                &mut owned,
            ),
            InvalidRequest(_)
        ));
    }
}
