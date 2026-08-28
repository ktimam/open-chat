use crate::guards::caller_is_owner;
use crate::{RuntimeState, read_state};
use canister_api_macros::update;
use local_user_index_canister::c2c_create_ai_app_card_confirmation_grant as relay;
use oc_error_codes::OCErrorCode;
use types::{Chat, EventIndex};
use user_canister::create_ai_app_card_confirmation_grant::{Response::*, *};

#[update(guard = "caller_is_owner", msgpack = true)]
async fn create_ai_app_card_confirmation_grant(args: Args) -> Response {
    if !read_state(|state| state.data.test_mode) {
        return AppUnavailable;
    }
    let prepared = match read_state(|state| prepare(&args, state)) {
        Ok(value) => value,
        Err(error) => return Error(error),
    };
    let result = local_user_index_canister_c2c_client::c2c_create_ai_app_card_confirmation_grant(
        prepared.local_user_index_canister_id,
        &prepared.relay_args,
    )
    .await;
    if let Err(error) = read_state(|state| revalidate(&prepared, state)) {
        return Error(error);
    }
    match result {
        Ok(relay::Response::Success(result)) => Success(SuccessResult {
            grant: result.grant,
            expires_at: result.expires_at,
        }),
        Ok(relay::Response::InvalidProvenance) => InvalidProvenance,
        Ok(relay::Response::AppUnavailable) => AppUnavailable,
        Ok(relay::Response::InvalidRequest(error)) => InvalidRequest(error),
        Ok(relay::Response::Error(error)) => Error(OCErrorCode::C2CError.with_message(error)),
        Err(_) => Error(OCErrorCode::C2CError.with_message("confirmation grant service unavailable")),
    }
}

struct Prepared {
    ingress_owner: candid::Principal,
    local_user_index_canister_id: types::CanisterId,
    relay_args: relay::Args,
}

fn prepare(args: &Args, state: &RuntimeState) -> Result<Prepared, oc_error_codes::OCError> {
    state.data.verify_not_suspended()?;
    if !state.data.test_mode {
        return Err(OCErrorCode::InvalidRequest.with_message("edited card confirmation is not enabled"));
    }
    if args.confirm_payload.is_empty() || args.confirm_payload.len() > types::MAX_AI_APP_CONFIRM_PAYLOAD_BYTES {
        return Err(OCErrorCode::InvalidRequest.with_message(format!(
            "confirmation payload must contain 1..={} bytes",
            types::MAX_AI_APP_CONFIRM_PAYLOAD_BYTES
        )));
    }
    if !state.is_caller_owner() {
        return Err(OCErrorCode::InitiatorNotAuthorized.into());
    }
    let user_id: types::UserId = state.env.canister_id().into();
    if args.user_id == user_id {
        return Err(OCErrorCode::ChatNotFound.into());
    }
    let chat = state
        .data
        .direct_chats
        .get(&args.user_id.into())
        .ok_or(OCErrorCode::ChatNotFound)?;
    if chat.user_type != types::UserType::User {
        return Err(OCErrorCode::InitiatorNotAuthorized.with_message("AI-app cards require a human direct chat"));
    }
    let source = chat.events.ai_app_card_confirmation_source(
        args.thread_root_message_index,
        args.message_id,
        EventIndex::default(),
        state.env.now(),
    )?;
    Ok(Prepared {
        ingress_owner: state.data.owner,
        local_user_index_canister_id: state.data.local_user_index_canister_id,
        relay_args: relay::Args {
            user_id,
            chat: Chat::Direct(args.user_id.into()),
            thread_root_message_index: args.thread_root_message_index,
            message_id: args.message_id,
            app_id: source.app_id,
            app_revision: source.app_revision,
            action_id: source.action_id,
            content_hash: source.content_hash,
            member_user_ids: vec![user_id, args.user_id],
            confirm_payload: args.confirm_payload.clone(),
            authority: serde_bytes::ByteBuf::new(),
        },
    })
}

fn revalidate(prepared: &Prepared, state: &RuntimeState) -> Result<(), oc_error_codes::OCError> {
    state.data.verify_not_suspended()?;
    if !state.data.test_mode {
        return Err(OCErrorCode::InvalidRequest.with_message("edited card confirmation is not enabled"));
    }
    let Chat::Direct(other) = prepared.relay_args.chat else {
        return Err(OCErrorCode::InvalidRequest.with_message("direct card identity changed during grant mint"));
    };
    let other_user_id: types::UserId = other.into();
    let user_id: types::UserId = state.env.canister_id().into();
    if state.data.owner != prepared.ingress_owner
        || state.data.local_user_index_canister_id != prepared.local_user_index_canister_id
        || user_id != prepared.relay_args.user_id
        || other_user_id == user_id
        || prepared.relay_args.member_user_ids != [user_id, other_user_id]
    {
        return Err(OCErrorCode::C2CError.with_message("direct card route changed during grant mint"));
    }
    let chat = state
        .data
        .direct_chats
        .get(&other_user_id.into())
        .ok_or(OCErrorCode::ChatNotFound)?;
    if chat.user_type != types::UserType::User {
        return Err(OCErrorCode::InitiatorNotAuthorized.with_message("AI-app cards require a human direct chat"));
    }
    let source = chat.events.ai_app_card_confirmation_source(
        prepared.relay_args.thread_root_message_index,
        prepared.relay_args.message_id,
        EventIndex::default(),
        state.env.now(),
    )?;
    if source.app_id != prepared.relay_args.app_id
        || source.app_revision != prepared.relay_args.app_revision
        || source.action_id != prepared.relay_args.action_id
        || source.content_hash != prepared.relay_args.content_hash
    {
        return Err(OCErrorCode::InvalidRequest.with_message("card authorization changed during grant mint"));
    }
    Ok(())
}
