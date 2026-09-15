use crate::guards::caller_is_owner;
use crate::{RuntimeState, read_state};
use canister_api_macros::update;
use local_user_index_canister::c2c_create_ai_app_private_match_capability as relay;
use oc_error_codes::OCErrorCode;
use types::{Chat, EventIndex};
use user_canister::create_ai_app_private_match_capability::{Response::*, *};

#[update(guard = "caller_is_owner", msgpack = true)]
async fn create_ai_app_private_match_capability(args: Args) -> Response {
    let prepared = match read_state(|state| prepare(&args, state)) {
        Ok(value) => value,
        Err(error) => return Error(error),
    };
    let result = local_user_index_canister_c2c_client::c2c_create_ai_app_private_match_capability(
        prepared.local_user_index_canister_id,
        &prepared.relay_args,
    )
    .await;
    if let Err(error) = read_state(|state| revalidate(&prepared, state)) {
        return Error(error);
    }
    relay_response(result)
}

struct Prepared {
    ingress_owner: candid::Principal,
    local_user_index_canister_id: types::CanisterId,
    source_event_index: types::EventIndex,
    source_message_timestamp: types::TimestampMillis,
    relay_args: relay::Args,
}

fn prepare(args: &Args, state: &RuntimeState) -> Result<Prepared, oc_error_codes::OCError> {
    state.data.verify_not_suspended()?;
    if !state.is_caller_owner() {
        return Err(OCErrorCode::InitiatorNotAuthorized.into());
    }
    let user_id: types::UserId = state.env.canister_id().into();
    if args.user_id == user_id || state.data.blocked_users.contains(&args.user_id) {
        return Err(OCErrorCode::ChatNotFound.into());
    }
    let chat = state
        .data
        .direct_chats
        .get(&args.user_id.into())
        .ok_or(OCErrorCode::ChatNotFound)?;
    if chat.user_type != types::UserType::User {
        return Err(OCErrorCode::InitiatorNotAuthorized.with_message("private match requires a human direct chat"));
    }
    let source = chat.events.ai_app_private_match_source(
        args.thread_root_message_index,
        args.message_id,
        EventIndex::default(),
        state.env.now(),
    )?;
    Ok(Prepared {
        ingress_owner: state.data.owner,
        local_user_index_canister_id: state.data.local_user_index_canister_id,
        source_event_index: source.event_index,
        source_message_timestamp: source.message_timestamp,
        relay_args: relay::Args {
            user_id,
            chat: Chat::Direct(args.user_id.into()),
            thread_root_message_index: args.thread_root_message_index,
            message_id: args.message_id,
            app_id: args.app_id,
            app_revision: args.app_revision,
            action_id: args.action_id.clone(),
            source_binding: source.source_binding,
            member_user_ids: vec![user_id, args.user_id],
            recipient_key_scheme: args.recipient_key_scheme.clone(),
            recipient_public_key: args.recipient_public_key.clone(),
            authority: serde_bytes::ByteBuf::new(),
        },
    })
}

fn revalidate(prepared: &Prepared, state: &RuntimeState) -> Result<(), oc_error_codes::OCError> {
    state.data.verify_not_suspended()?;
    let Chat::Direct(other) = prepared.relay_args.chat else {
        return Err(OCErrorCode::InvalidRequest.with_message("direct private-match identity changed"));
    };
    let other_user_id: types::UserId = other.into();
    let user_id: types::UserId = state.env.canister_id().into();
    if state.data.owner != prepared.ingress_owner
        || state.data.local_user_index_canister_id != prepared.local_user_index_canister_id
        || user_id != prepared.relay_args.user_id
        || other_user_id == user_id
        || state.data.blocked_users.contains(&other_user_id)
        || prepared.relay_args.member_user_ids != [user_id, other_user_id]
    {
        return Err(OCErrorCode::C2CError.with_message("direct private-match route changed during mint"));
    }
    let chat = state
        .data
        .direct_chats
        .get(&other_user_id.into())
        .ok_or(OCErrorCode::ChatNotFound)?;
    if chat.user_type != types::UserType::User {
        return Err(OCErrorCode::InitiatorNotAuthorized.with_message("private match requires a human direct chat"));
    }
    let source = chat.events.ai_app_private_match_source(
        prepared.relay_args.thread_root_message_index,
        prepared.relay_args.message_id,
        EventIndex::default(),
        state.env.now(),
    )?;
    if source.source_binding != prepared.relay_args.source_binding
        || source.event_index != prepared.source_event_index
        || source.message_timestamp != prepared.source_message_timestamp
    {
        return Err(OCErrorCode::InvalidRequest.with_message("private-match source changed during mint"));
    }
    Ok(())
}

fn relay_response(result: Result<relay::Response, types::C2CError>) -> Response {
    match result {
        Ok(relay::Response::Success(result)) => Success(SuccessResult {
            token: result.token,
            expires_at: result.expires_at,
            context: result.context,
        }),
        Ok(relay::Response::InvalidSource) => InvalidSource,
        Ok(relay::Response::AppUnavailable) => AppUnavailable,
        Ok(relay::Response::InvalidRequest(error)) => InvalidRequest(error),
        Ok(relay::Response::Error(error)) => Error(OCErrorCode::C2CError.with_message(error)),
        Err(_) => Error(OCErrorCode::C2CError.with_message("private-match service unavailable")),
    }
}
