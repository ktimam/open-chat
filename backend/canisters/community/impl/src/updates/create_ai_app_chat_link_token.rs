use crate::{RuntimeState, mutate_state, read_state};
use canister_api_macros::update;
use community_canister::create_ai_app_chat_link_token::{Response::*, *};
use group_community_common::{AiAppChatLinkAdmissionError, AiAppChatLinkAdmissionLease};
use local_user_index_canister::c2c_create_ai_app_chat_link_token as relay;
use types::Chat;

#[update(msgpack = true)]
async fn create_ai_app_chat_link_token(args: Args) -> Response {
    let mut prepared = match mutate_state(|state| prepare(&args, state)) {
        Ok(value) => value,
        Err(error) => return map_prepare_error(error),
    };
    let authority = match crate::ai_app_chat_link_authority::issue(prepared.group_index_canister_id, prepared.binding()).await {
        Ok(token) => token,
        Err(error) => {
            release_admission(&prepared);
            return Error(error);
        }
    };
    prepared.relay_args.authority = authority;
    if let Err(error) = read_state(|state| revalidate(&prepared, state)) {
        cancel_authority(&prepared).await;
        release_admission(&prepared);
        return map_prepare_error(error);
    }
    let response = local_user_index_canister_c2c_client::c2c_create_ai_app_chat_link_token(
        prepared.local_user_index_canister_id,
        &prepared.relay_args,
    )
    .await;
    if let Err(error) = read_state(|state| revalidate(&prepared, state)) {
        if !relay_succeeded(&response) {
            cancel_authority(&prepared).await;
        }
        cleanup_success(&prepared, &response).await;
        release_admission(&prepared);
        return map_prepare_error(error);
    }
    if !relay_succeeded(&response) {
        cancel_authority(&prepared).await;
    }
    release_admission(&prepared);
    relay_response(response)
}

async fn cancel_authority(prepared: &Prepared) {
    crate::ai_app_chat_link_authority::cancel(
        prepared.group_index_canister_id,
        prepared.binding(),
        &prepared.relay_args.authority,
    )
    .await;
}

fn release_admission(prepared: &Prepared) {
    mutate_state(|state| {
        state.data.ai_app_chat_link_admission.release(&prepared.admission);
    });
}

fn relay_succeeded(result: &Result<relay::Response, types::C2CError>) -> bool {
    matches!(result, Ok(relay::Response::Success(_)))
}

async fn cleanup_success(prepared: &Prepared, result: &Result<relay::Response, types::C2CError>) {
    let Ok(relay::Response::Success(success)) = result else {
        return;
    };
    let _ = local_user_index_canister_c2c_client::c2c_cancel_ai_app_chat_link_token(
        prepared.local_user_index_canister_id,
        &local_user_index_canister::c2c_cancel_ai_app_chat_link_token::Args {
            user_id: prepared.relay_args.user_id,
            chat: prepared.relay_args.chat,
            app_id: prepared.relay_args.app_id,
            app_revision: prepared.relay_args.app_revision,
            token: success.token.clone(),
        },
    )
    .await;
}

struct Prepared {
    local_user_index_canister_id: types::CanisterId,
    group_index_canister_id: types::CanisterId,
    channel_id: types::ChannelId,
    admission: AiAppChatLinkAdmissionLease,
    relay_args: relay::Args,
}

impl Prepared {
    fn binding(&self) -> group_index_canister::ai_app_chat_link_authority::AiAppChatLinkAuthorityBindingV1 {
        group_index_canister::ai_app_chat_link_authority::AiAppChatLinkAuthorityBindingV1 {
            local_user_index_canister_id: self.local_user_index_canister_id,
            user_id: self.relay_args.user_id,
            chat: self.relay_args.chat,
            app_id: self.relay_args.app_id,
            app_revision: self.relay_args.app_revision,
        }
    }
}

fn prepare(args: &Args, state: &mut RuntimeState) -> Result<Prepared, oc_error_codes::OCError> {
    state.data.verify_not_frozen()?;
    let user_id = state.get_calling_member(true)?.user_id;
    let channel = state.data.channels.get_or_err(&args.channel_id)?;
    // Community membership alone does not grant access to a private channel. This is the same
    // present/not-suspended/not-lapsed check used by message operations.
    channel.chat.members.get_verified_member(user_id)?;
    if !channel.enabled_ai_apps.contains(&args.app_id) {
        return Err(oc_error_codes::OCErrorCode::InitiatorNotAuthorized.with_message("the app is not enabled in this channel"));
    }
    let admission = state
        .data
        .ai_app_chat_link_admission
        .reserve(user_id, args.app_id, state.env.now())
        .map_err(admission_error)?;
    Ok(Prepared {
        local_user_index_canister_id: state.data.local_user_index_canister_id,
        group_index_canister_id: state.data.group_index_canister_id,
        channel_id: args.channel_id,
        admission,
        relay_args: relay::Args {
            user_id,
            chat: Chat::Channel(state.env.canister_id().into(), args.channel_id),
            app_id: args.app_id,
            app_revision: args.app_revision,
            member_user_ids: vec![user_id],
            authority: serde_bytes::ByteBuf::new(),
        },
    })
}

fn revalidate(prepared: &Prepared, state: &RuntimeState) -> Result<(), oc_error_codes::OCError> {
    state.data.verify_not_frozen()?;
    let user_id = state.get_calling_member(true)?.user_id;
    let channel = state.data.channels.get_or_err(&prepared.channel_id)?;
    channel.chat.members.get_verified_member(user_id)?;
    if !state
        .data
        .ai_app_chat_link_admission
        .is_current(&prepared.admission, state.env.now())
    {
        return Err(oc_error_codes::OCErrorCode::Throttled.with_message("chat-link mint admission expired or was superseded"));
    }
    if state.data.local_user_index_canister_id != prepared.local_user_index_canister_id
        || state.data.group_index_canister_id != prepared.group_index_canister_id
        || user_id != prepared.relay_args.user_id
        || !channel.enabled_ai_apps.contains(&prepared.relay_args.app_id)
    {
        return Err(oc_error_codes::OCErrorCode::InitiatorNotAuthorized
            .with_message("channel membership, app policy, or authority route changed during token mint"));
    }
    Ok(())
}

fn admission_error(error: AiAppChatLinkAdmissionError) -> oc_error_codes::OCError {
    let message = match error {
        AiAppChatLinkAdmissionError::InFlight => "a chat-link mint is already in flight for this user and app",
        AiAppChatLinkAdmissionError::SubjectRateLimited => "chat-link mint attempt limit reached for this user and app",
        AiAppChatLinkAdmissionError::ChildRateLimited => "chat-link mint attempt limit reached for this community",
        AiAppChatLinkAdmissionError::Capacity => "chat-link mint admission capacity reached",
    };
    oc_error_codes::OCErrorCode::Throttled.with_message(message)
}

fn map_prepare_error(error: oc_error_codes::OCError) -> Response {
    if error.matches_code(oc_error_codes::OCErrorCode::InitiatorNotFound) {
        ChatNotFound
    } else if error.matches_code(oc_error_codes::OCErrorCode::InitiatorNotAuthorized) {
        NotAuthorized
    } else {
        Error(error)
    }
}

fn relay_response(result: Result<relay::Response, types::C2CError>) -> Response {
    match result {
        Ok(relay::Response::Success(result)) => Success(SuccessResult {
            token: result.token,
            expires_at: result.expires_at,
        }),
        Ok(relay::Response::AppUnavailable) => AppUnavailable,
        Ok(relay::Response::NotAuthorized) => NotAuthorized,
        Ok(relay::Response::InvalidRequest(error)) => InvalidRequest(error),
        Ok(relay::Response::Error(error)) => Error(oc_error_codes::OCErrorCode::C2CError.with_message(error)),
        Err(_) => Error(oc_error_codes::OCErrorCode::C2CError.with_message("chat-link token service unavailable")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use candid::Principal;
    use oc_error_codes::OCErrorCode;
    use rand::SeedableRng;
    use rand::rngs::StdRng;
    use types::{ChannelId, CommunityPermissions, Rules, UserId, UserType};
    use utils::env::test::TestEnv;

    fn state() -> (RuntimeState, ChannelId, UserId) {
        stable_memory_map::init(crate::memory::get_stable_memory_map_memory());
        let creator = Principal::from_slice(&[1]);
        let creator_user_id: UserId = creator.into();
        let viewer = Principal::from_slice(&[2]);
        let viewer_user_id: UserId = viewer.into();
        let channel_id = ChannelId::from(1u32);
        let mut env = TestEnv::default();
        env.caller = viewer;
        let mut data = crate::Data::new(
            env.canister_id.into(),
            creator,
            creator_user_id,
            UserType::User,
            false,
            "community".to_string(),
            String::new(),
            Rules::default(),
            None,
            None,
            CommunityPermissions::default(),
            "en".to_string(),
            Principal::from_slice(&[22]),
            Principal::from_slice(&[23]),
            Principal::from_slice(&[21]),
            Principal::from_slice(&[24]).into(),
            Principal::from_slice(&[25]),
            Principal::from_slice(&[26]),
            None,
            vec![(channel_id, "private".to_string())],
            None,
            0,
            Vec::new(),
            true,
            &mut StdRng::seed_from_u64(7),
            env.now,
        );
        data.channels.get_mut(&channel_id).unwrap().enabled_ai_apps.insert(7);
        data.members.add(viewer_user_id, viewer, UserType::User, None, env.now);
        data.channels.get_mut(&channel_id).unwrap().chat.members.add(
            viewer_user_id,
            env.now,
            0.into(),
            0.into(),
            false,
            UserType::User,
        );
        data.members.mark_member_joined_channel(viewer_user_id, channel_id);
        (
            RuntimeState::new(Box::new(env), data, crate::regular_jobs::build()),
            channel_id,
            viewer_user_id,
        )
    }

    fn args(channel_id: ChannelId) -> Args {
        Args {
            channel_id,
            app_id: 7,
            app_revision: 11,
        }
    }

    #[test]
    fn community_member_outside_the_channel_cannot_mint_from_a_known_id() {
        let (mut state, channel_id, user_id) = state();
        let prepared = prepare(&args(channel_id), &mut state).expect("active channel member");
        state
            .data
            .channels
            .get_mut(&channel_id)
            .unwrap()
            .chat
            .members
            .remove(user_id, 1);
        let error = prepare(&args(channel_id), &mut state)
            .err()
            .expect("private channel membership is required");
        assert!(error.matches_code(OCErrorCode::InitiatorNotFound));
        let error = revalidate(&prepared, &state).expect_err("channel removal during await");
        assert!(error.matches_code(OCErrorCode::InitiatorNotFound));
    }

    #[test]
    fn community_and_channel_suspension_or_lapse_each_block_minting() {
        let (mut state, channel_id, user_id) = state();
        let prepared = prepare(&args(channel_id), &mut state).expect("active community and channel member");

        state.data.members.set_suspended(user_id, true, 1);
        let error = prepare(&args(channel_id), &mut state).err().expect("community suspension");
        assert!(error.matches_code(OCErrorCode::InitiatorSuspended));
        let error = revalidate(&prepared, &state).expect_err("community suspension during await");
        assert!(error.matches_code(OCErrorCode::InitiatorSuspended));
        state.data.members.set_suspended(user_id, false, 2);

        state.data.members.update_lapsed(user_id, true, 3);
        let error = prepare(&args(channel_id), &mut state).err().expect("community lapse");
        assert!(error.matches_code(OCErrorCode::InitiatorLapsed));
        let error = revalidate(&prepared, &state).expect_err("community lapse during await");
        assert!(error.matches_code(OCErrorCode::InitiatorLapsed));
        state.data.members.update_lapsed(user_id, false, 4);

        state
            .data
            .channels
            .get_mut(&channel_id)
            .unwrap()
            .chat
            .members
            .set_suspended(user_id, true, 5);
        let error = prepare(&args(channel_id), &mut state).err().expect("channel suspension");
        assert!(error.matches_code(OCErrorCode::InitiatorSuspended));
        let error = revalidate(&prepared, &state).expect_err("channel suspension during await");
        assert!(error.matches_code(OCErrorCode::InitiatorSuspended));
        let channel_members = &mut state.data.channels.get_mut(&channel_id).unwrap().chat.members;
        channel_members.set_suspended(user_id, false, 6);
        channel_members.update_lapsed(user_id, true, 7);
        let error = prepare(&args(channel_id), &mut state).err().expect("channel lapse");
        assert!(error.matches_code(OCErrorCode::InitiatorLapsed));
        let error = revalidate(&prepared, &state).expect_err("channel lapse during await");
        assert!(error.matches_code(OCErrorCode::InitiatorLapsed));
    }

    #[test]
    fn local_admission_blocks_a_second_attempt_before_any_await() {
        let (mut state, channel_id, _) = state();
        let first = prepare(&args(channel_id), &mut state).expect("first local admission");
        let error = prepare(&args(channel_id), &mut state)
            .err()
            .expect("second local attempt must be rejected");
        assert!(error.matches_code(OCErrorCode::Throttled));
        assert!(state.data.ai_app_chat_link_admission.release(&first.admission));
        assert!(prepare(&args(channel_id), &mut state).is_ok());
    }
}
