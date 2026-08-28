use crate::guards::caller_is_owner;
use crate::{RuntimeState, read_state};
use canister_api_macros::update;
use local_user_index_canister::c2c_create_ai_app_card_capability as relay;
use oc_error_codes::OCErrorCode;
use types::{Chat, EventIndex};
use user_canister::create_ai_app_card_capability::{Response::*, *};

#[update(guard = "caller_is_owner", msgpack = true)]
async fn create_ai_app_card_capability(args: Args) -> Response {
    if !read_state(|state| state.data.test_mode) {
        return AppUnavailable;
    }
    let prepared = match read_state(|state| prepare(&args, state)) {
        Ok(value) => value,
        Err(error) => return Error(error),
    };
    let result = local_user_index_canister_c2c_client::c2c_create_ai_app_card_capability(
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
    relay_args: relay::Args,
}

fn prepare(args: &Args, state: &RuntimeState) -> Result<Prepared, oc_error_codes::OCError> {
    state.data.verify_not_suspended()?;
    if !state.data.test_mode {
        return Err(OCErrorCode::InvalidRequest.with_message("private app-card context delivery is not enabled"));
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
    let source = chat.events.ai_app_card_capability_source(
        args.thread_root_message_index,
        args.message_id,
        EventIndex::default(),
        state.env.now(),
        state.data.test_mode,
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
            recipient_key_scheme: args.recipient_key_scheme.clone(),
            recipient_public_key: args.recipient_public_key.clone(),
            authority: serde_bytes::ByteBuf::new(),
        },
    })
}

fn revalidate(prepared: &Prepared, state: &RuntimeState) -> Result<(), oc_error_codes::OCError> {
    state.data.verify_not_suspended()?;
    if !state.data.test_mode {
        return Err(OCErrorCode::InvalidRequest.with_message("private app-card context delivery is not enabled"));
    }
    let Chat::Direct(other) = prepared.relay_args.chat else {
        return Err(OCErrorCode::InvalidRequest.with_message("direct card identity changed during capability mint"));
    };
    let other_user_id: types::UserId = other.into();
    let user_id: types::UserId = state.env.canister_id().into();
    if state.data.owner != prepared.ingress_owner
        || state.data.local_user_index_canister_id != prepared.local_user_index_canister_id
        || user_id != prepared.relay_args.user_id
        || other_user_id == user_id
        || prepared.relay_args.member_user_ids != [user_id, other_user_id]
    {
        return Err(OCErrorCode::C2CError.with_message("direct card route changed during capability mint"));
    }
    let chat = state
        .data
        .direct_chats
        .get(&other_user_id.into())
        .ok_or(OCErrorCode::ChatNotFound)?;
    if chat.user_type != types::UserType::User {
        return Err(OCErrorCode::InitiatorNotAuthorized.with_message("AI-app cards require a human direct chat"));
    }
    let source = chat.events.ai_app_card_capability_source(
        prepared.relay_args.thread_root_message_index,
        prepared.relay_args.message_id,
        EventIndex::default(),
        state.env.now(),
        state.data.test_mode,
    )?;
    if source.app_id != prepared.relay_args.app_id
        || source.app_revision != prepared.relay_args.app_revision
        || source.action_id != prepared.relay_args.action_id
        || source.content_hash != prepared.relay_args.content_hash
    {
        return Err(OCErrorCode::InvalidRequest.with_message("card authorization changed during capability mint"));
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
        Ok(relay::Response::InvalidProvenance) => InvalidProvenance,
        Ok(relay::Response::AppUnavailable) => AppUnavailable,
        Ok(relay::Response::InvalidRequest(error)) => InvalidRequest(error),
        Ok(relay::Response::Error(error)) => Error(OCErrorCode::C2CError.with_message(error)),
        Err(_) => Error(OCErrorCode::C2CError.with_message("capability service unavailable")),
    }
}

#[cfg(test)]
mod tests {
    // The behavioral authorization/content checks live in chat_events tests; this narrow source
    // contract catches wiring regressions in the public direct endpoint.
    const HANDLER_SOURCE: &str = include_str!("create_ai_app_card_capability.rs");

    #[test]
    fn direct_capability_handler_relays_the_attested_card_to_local_user_index() {
        assert!(
            HANDLER_SOURCE.contains("local_user_index_canister_c2c_client::c2c_create_ai_app_card_capability"),
            "the User canister must relay direct-card capability requests through its LocalUserIndex"
        );
        assert!(
            HANDLER_SOURCE.contains("Chat::Direct"),
            "the relay must bind the request to the exact direct-chat counterpart"
        );
        for required in [
            "read_state(|state| prepare(&args, state))",
            "read_state(|state| revalidate(&prepared, state))",
            "ai_app_card_capability_source(",
            "authority: serde_bytes::ByteBuf::new()",
        ] {
            assert!(
                HANDLER_SOURCE.contains(required),
                "missing direct capability contract: {required}"
            );
        }
    }
}
