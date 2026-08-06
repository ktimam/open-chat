use crate::guards::caller_is_group_or_community_canister;
use crate::model::ai_app_card_authority::{CardRouteKey, InsertError};
use crate::{RuntimeState, mutate_state};
use canister_api_macros::update;
use constants::MINUTE_IN_MS;
use group_index_canister::ai_app_card_authority::{
    AI_APP_CARD_AUTHORITY_TOKEN_BYTES, AiAppCardAuthorityBindingV1, AiAppCardAuthorityOperationV1,
};
use group_index_canister::c2c_issue_ai_app_card_authority_v1::{Response::*, *};
use rand::Rng;
use serde_bytes::ByteBuf;
use types::{CanisterId, Chat, Milliseconds};

const AUTHORITY_TTL: Milliseconds = 2 * MINUTE_IN_MS;
const MAX_TOKEN_GENERATION_ATTEMPTS: usize = 10;
const AUTHORITY_ENTROPY_PURPOSE: &[u8] = b"group-index/card-authority/v1";

// A successful response contains a live bearer token, so this method must never be traced.
#[update(guard = "caller_is_group_or_community_canister", msgpack = true)]
fn c2c_issue_ai_app_card_authority_v1(args: Args) -> Response {
    mutate_state(|state| issue(args, state))
}

fn issue(args: Args, state: &mut RuntimeState) -> Response {
    if let Err(error) = validate_binding_shape(&args.binding) {
        return InvalidRequest(error);
    }
    let caller = state.env.caller();
    let (route, owner) = match resolve_route(&args.binding, Some(caller), state) {
        Some(value) => value,
        None => return InvalidRoute,
    };
    let mut rng = match crate::pr2_entropy::output_rng(state, AUTHORITY_ENTROPY_PURPOSE) {
        Ok(rng) => rng,
        Err(_) => return EntropyUnavailable,
    };
    let now = state.env.now();
    let expires_at = now.saturating_add(AUTHORITY_TTL);
    for _ in 0..MAX_TOKEN_GENERATION_ATTEMPTS {
        let mut raw = [0u8; AI_APP_CARD_AUTHORITY_TOKEN_BYTES];
        rng.fill_bytes(&mut raw);
        match state
            .data
            .ai_app_card_authority
            .insert(&raw, args.binding.clone(), route, owner, expires_at, now)
        {
            Ok(()) => {
                return Success(SuccessResult {
                    token: ByteBuf::from(raw.to_vec()),
                    expires_at,
                });
            }
            Err(InsertError::TokenCollision) => continue,
            Err(InsertError::GlobalCapacity | InsertError::ChildCapacity | InsertError::RouteCapacity) => {
                return CapacityExceeded;
            }
        }
    }
    CapacityExceeded
}

pub(crate) fn resolve_route(
    binding: &AiAppCardAuthorityBindingV1,
    expected_child: Option<candid::Principal>,
    state: &RuntimeState,
) -> Option<(CardRouteKey, CanisterId)> {
    let (route, child, canonical_key, owner) = match binding.context.chat {
        Chat::Group(chat_id) => (
            CardRouteKey::Group(chat_id),
            candid::Principal::from(chat_id),
            format!("group:{chat_id}"),
            state.data.local_index_map.get_index_canister_for_group(&chat_id),
        ),
        Chat::Channel(community_id, channel_id) => (
            CardRouteKey::Community(community_id),
            candid::Principal::from(community_id),
            format!("channel:{community_id}:{channel_id}"),
            state.data.local_index_map.get_index_canister_for_community(&community_id),
        ),
        Chat::Direct(_) => return None,
    };
    if expected_child.is_some_and(|expected| expected != child)
        || binding.context.chat_key != canonical_key
        || owner != Some(binding.local_user_index_canister_id)
    {
        return None;
    }
    Some((route, owner.unwrap()))
}

fn validate_binding_shape(binding: &AiAppCardAuthorityBindingV1) -> Result<(), String> {
    if binding.context.action_id.is_empty() || binding.context.action_id.len() > 128 {
        return Err("invalid action id".to_string());
    }
    if binding.context.chat_key.len() > 256 {
        return Err("invalid chat key".to_string());
    }
    match &binding.operation {
        AiAppCardAuthorityOperationV1::CreatePrivateContextCapability {
            recipient_key_scheme, ..
        } if recipient_key_scheme.is_empty() || recipient_key_scheme.len() > 64 => {
            Err("invalid recipient key scheme".to_string())
        }
        AiAppCardAuthorityOperationV1::ConsumeConfirmationGrant {
            confirmation_lease_generation,
            ..
        }
        | AiAppCardAuthorityOperationV1::DepositConfirmedAction {
            confirmation_lease_generation,
            ..
        } if *confirmation_lease_generation == 0 => Err("invalid confirmation lease generation".to_string()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use candid::Principal;
    use group_index_canister::ai_app_card_authority::AiAppCardAuthorityOperationV1;
    use types::{AiAppCardContext, MessageId};

    fn binding(group: Principal, owner: Principal, user: Principal) -> AiAppCardAuthorityBindingV1 {
        AiAppCardAuthorityBindingV1 {
            local_user_index_canister_id: owner,
            context: AiAppCardContext {
                user_id: user.into(),
                chat: Chat::Group(group.into()),
                chat_key: format!("group:{group}"),
                thread_root_message_index: None,
                message_id: MessageId::from(1u64),
                app_id: 1,
                app_revision: 2,
                action_id: "generic.action".to_string(),
            },
            content_hash: [3; 32],
            operation: AiAppCardAuthorityOperationV1::ValidateProvenance {
                provenance_hash: [4; 32],
            },
        }
    }

    #[test]
    fn only_the_exact_child_and_owning_lui_route_resolve() {
        let owner = Principal::from_slice(&[1]);
        let other_lui = Principal::from_slice(&[2]);
        let group = Principal::from_slice(&[7]);
        let cross_shard_user = Principal::from_slice(&[99]);
        let mut data = crate::Data::default();
        data.local_index_map.add_index(owner);
        data.local_index_map.add_index(other_lui);
        data.local_index_map.add_group(owner, group.into());
        let state = RuntimeState::new(Box::new(utils::env::test::TestEnv::default()), data);
        let exact = binding(group, owner, cross_shard_user);
        assert_eq!(
            resolve_route(&exact, Some(group), &state).map(|(_, owner)| owner),
            Some(owner)
        );
        assert!(resolve_route(&exact, Some(Principal::from_slice(&[8])), &state).is_none());
        let wrong_shard = binding(group, other_lui, cross_shard_user);
        assert!(resolve_route(&wrong_shard, Some(group), &state).is_none());
    }

    #[test]
    fn forged_chat_kind_and_noncanonical_channel_fail_closed() {
        let owner = Principal::from_slice(&[1]);
        let community = Principal::from_slice(&[7]);
        let mut data = crate::Data::default();
        data.local_index_map.add_index(owner);
        data.local_index_map.add_community(owner, community.into());
        let state = RuntimeState::new(Box::new(utils::env::test::TestEnv::default()), data);
        let mut value = binding(community, owner, Principal::from_slice(&[9]));
        value.context.chat = Chat::Channel(community.into(), 3u32.into());
        value.context.chat_key = "channel:forged".to_string();
        assert!(resolve_route(&value, Some(community), &state).is_none());
        value.context.chat_key = format!("channel:{community}:{}", types::ChannelId::from(3u32));
        assert!(resolve_route(&value, Some(community), &state).is_some());
        assert!(resolve_route(&value, Some(Principal::from_slice(&[8])), &state).is_none());
    }

    fn reseed_current_lifecycle(state: &mut RuntimeState, raw_rand: [u8; 32]) {
        let now = state.env.now();
        let types::Pr2EntropyReseedAdmission::Started(ticket) = state.data.pr2_entropy.begin_reseed(now) else {
            panic!("entropy reseed must start")
        };
        let canister_id = state.env.canister_id();
        let commitment_mode = types::Pr2EntropyCommitmentMode::from_test_mode(state.data.test_mode);
        assert!(
            state
                .data
                .pr2_entropy
                .finish_reseed(ticket, canister_id, commitment_mode, &raw_rand, now)
        );
    }

    #[test]
    fn restored_snapshot_invalidates_old_authority_and_requires_fresh_entropy() {
        let owner = Principal::from_slice(&[1]);
        let group = Principal::from_slice(&[7]);
        let user = Principal::from_slice(&[9]);
        let state = || {
            let mut data = crate::Data::default();
            data.local_index_map.add_index(owner);
            data.local_index_map.add_group(owner, group.into());
            let mut env = utils::env::test::TestEnv::default();
            env.caller = group;
            RuntimeState::new(Box::new(env), data)
        };
        let mut first_state = state();
        let first_binding = binding(group, owner, user);
        let mut second_binding = first_binding.clone();
        second_binding.context.message_id = MessageId::from(2u64);

        crate::pr2_entropy::advance_lifecycle(&mut first_state, 12).unwrap();
        reseed_current_lifecycle(&mut first_state, [12; 32]);
        let Success(first) = issue(
            Args {
                binding: first_binding.clone(),
            },
            &mut first_state,
        ) else {
            panic!("first authority issuance must succeed")
        };
        let snapshot =
            msgpack::serialize_to_vec(&(&first_state.data.pr2_entropy, &first_state.data.ai_app_card_authority)).unwrap();

        assert_eq!(
            first_state.data.ai_app_card_authority.consume(
                first.token.as_ref(),
                &first_binding,
                Some(owner),
                first_state.env.now()
            ),
            crate::model::ai_app_card_authority::CheckResult::Valid
        );

        let (restored_entropy, restored_authorities): (
            types::Pr2EntropyGate,
            crate::model::ai_app_card_authority::AiAppCardAuthorityStore,
        ) = msgpack::deserialize(&snapshot[..]).unwrap();
        let mut restored_state = state();
        restored_state.data.pr2_entropy = restored_entropy;
        restored_state.data.ai_app_card_authority = restored_authorities;
        crate::pr2_entropy::advance_lifecycle(&mut restored_state, 13).unwrap();

        assert!(matches!(
            issue(
                Args {
                    binding: second_binding.clone(),
                },
                &mut restored_state,
            ),
            EntropyUnavailable
        ));
        assert_eq!(
            restored_state.data.ai_app_card_authority.check(
                first.token.as_ref(),
                &first_binding,
                Some(owner),
                restored_state.env.now(),
            ),
            crate::model::ai_app_card_authority::CheckResult::NotFound
        );

        reseed_current_lifecycle(&mut restored_state, [13; 32]);
        assert_eq!(
            restored_state.data.ai_app_card_authority.check(
                first.token.as_ref(),
                &first_binding,
                Some(owner),
                restored_state.env.now(),
            ),
            crate::model::ai_app_card_authority::CheckResult::NotFound
        );
        let Success(after_restore) = issue(Args { binding: second_binding }, &mut restored_state) else {
            panic!("post-restore authority issuance must succeed")
        };
        assert_ne!(
            first.token, after_restore.token,
            "a snapshot restore must not replay an already exposed GroupIndex authority bearer"
        );
    }
}
