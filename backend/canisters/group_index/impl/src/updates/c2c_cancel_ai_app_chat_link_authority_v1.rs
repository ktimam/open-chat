use crate::guards::caller_is_group_or_community_canister;
use crate::mutate_state;
use crate::updates::c2c_issue_ai_app_chat_link_authority_v1::validate_binding_shape;
use canister_api_macros::update;
use group_index_canister::ai_app_chat_link_authority::AI_APP_CHAT_LINK_AUTHORITY_TOKEN_BYTES;
use group_index_canister::c2c_cancel_ai_app_chat_link_authority_v1::{Response::*, *};
use types::Chat;

// This exact-bearer endpoint must never be traced.
#[update(guard = "caller_is_group_or_community_canister", msgpack = true)]
fn c2c_cancel_ai_app_chat_link_authority_v1(args: Args) -> Response {
    mutate_state(|state| cancel(args, state))
}

fn cancel(args: Args, state: &mut crate::RuntimeState) -> Response {
    if args.token.len() != AI_APP_CHAT_LINK_AUTHORITY_TOKEN_BYTES {
        return InvalidRequest(format!(
            "authority token must contain exactly {AI_APP_CHAT_LINK_AUTHORITY_TOKEN_BYTES} bytes"
        ));
    }
    if let Err(error) = validate_binding_shape(&args.binding) {
        return InvalidRequest(error);
    }
    let caller = state.env.caller();
    if !caller_matches_chat(caller, args.binding.chat) {
        return InvalidRoute;
    }
    // Cancellation is ownership-hiding and idempotent. The store removes only an exact
    // token/binding match; NotFound/Expired/BindingMismatch are deliberately indistinguishable.
    state
        .data
        .ai_app_chat_link_authority
        .consume(state.env.canister_id(), &args.token, &args.binding, state.env.now());
    Success
}

fn caller_matches_chat(caller: candid::Principal, chat: Chat) -> bool {
    match chat {
        Chat::Group(group_id) => candid::Principal::from(group_id) == caller,
        Chat::Channel(community_id, _) => candid::Principal::from(community_id) == caller,
        Chat::Direct(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use candid::Principal;
    use group_index_canister::ai_app_chat_link_authority::AiAppChatLinkAuthorityBindingV1;
    use serde_bytes::ByteBuf;
    use types::UserId;
    use utils::env::test::TestEnv;

    fn binding(group: Principal) -> AiAppChatLinkAuthorityBindingV1 {
        AiAppChatLinkAuthorityBindingV1 {
            local_user_index_canister_id: Principal::from_slice(&[2]),
            user_id: UserId::from(Principal::from_slice(&[3])),
            chat: Chat::Group(group.into()),
            app_id: 7,
            app_revision: 8,
        }
    }

    #[test]
    fn only_the_exact_authoritative_child_can_cancel() {
        let group = Principal::from_slice(&[1]);
        let community = Principal::from_slice(&[2]);
        assert!(caller_matches_chat(group, Chat::Group(group.into())));
        assert!(!caller_matches_chat(community, Chat::Group(group.into())));
        assert!(caller_matches_chat(community, Chat::Channel(community.into(), 1u32.into())));
        assert!(!caller_matches_chat(group, Chat::Channel(community.into(), 1u32.into())));
    }

    #[test]
    fn exact_cancel_removes_store_state_without_requiring_the_old_lui_route() {
        let group = Principal::from_slice(&[1]);
        let exact = binding(group);
        let raw = [4; AI_APP_CHAT_LINK_AUTHORITY_TOKEN_BYTES];
        let env = TestEnv {
            caller: group,
            now: 2,
            ..TestEnv::default()
        };
        let mut data = crate::Data::default();
        data.ai_app_chat_link_authority
            .insert(env.canister_id, &raw, exact.clone(), 100, 1)
            .unwrap();
        let mut state = crate::RuntimeState::new(Box::new(env), data);

        let mut wrong = exact.clone();
        wrong.app_revision += 1;
        assert!(matches!(
            cancel(
                Args {
                    binding: wrong,
                    token: ByteBuf::from(raw.to_vec()),
                },
                &mut state,
            ),
            Success
        ));
        assert_eq!(state.data.ai_app_chat_link_authority.len(), 1);

        assert!(matches!(
            cancel(
                Args {
                    binding: exact.clone(),
                    token: ByteBuf::from(raw.to_vec()),
                },
                &mut state,
            ),
            Success
        ));
        assert_eq!(state.data.ai_app_chat_link_authority.len(), 0);
        assert!(matches!(
            cancel(
                Args {
                    binding: exact,
                    token: ByteBuf::from(raw.to_vec()),
                },
                &mut state,
            ),
            Success
        ));
    }
}
