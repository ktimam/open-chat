use crate::guards::caller_is_owner;
use crate::{RuntimeState, read_state};
use canister_api_macros::update;
use local_user_index_canister::c2c_create_ai_app_chat_link_token as relay;
use types::Chat;
use user_canister::create_ai_app_chat_link_token::{Response::*, *};

#[update(guard = "caller_is_owner", msgpack = true)]
async fn create_ai_app_chat_link_token(args: Args) -> Response {
    let prepared = match read_state(|state| prepare(&args, state)) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let result = local_user_index_canister_c2c_client::c2c_create_ai_app_chat_link_token(
        prepared.local_user_index_canister_id,
        &prepared.relay_args,
    )
    .await;
    if let Err(response) = read_state(|state| revalidate(&prepared, state)) {
        cleanup_success(&prepared, &result).await;
        return response;
    }
    relay_response(result)
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
    relay_args: relay::Args,
}

fn prepare(args: &Args, state: &RuntimeState) -> Result<Prepared, Response> {
    let user_id: types::UserId = state.env.canister_id().into();
    if args.user_id == user_id || !state.data.direct_chats.exists(&args.user_id.into()) {
        return Err(ChatNotFound);
    }
    if !types::is_valid_ai_app_chat_name(&args.chat_name) {
        return Err(InvalidRequest("chat_name is missing or invalid".to_string()));
    }
    Ok(Prepared {
        local_user_index_canister_id: state.data.local_user_index_canister_id,
        relay_args: relay::Args {
            user_id,
            chat: Chat::Direct(args.user_id.into()),
            chat_name: args.chat_name.clone(),
            app_id: args.app_id,
            app_revision: args.app_revision,
            member_user_ids: vec![user_id, args.user_id],
            authority: serde_bytes::ByteBuf::new(),
        },
    })
}

fn revalidate(prepared: &Prepared, state: &RuntimeState) -> Result<(), Response> {
    let Chat::Direct(other) = prepared.relay_args.chat else {
        return Err(InvalidRequest("direct chat identity changed during token mint".to_string()));
    };
    let other_user_id: types::UserId = other.into();
    if state.data.local_user_index_canister_id != prepared.local_user_index_canister_id
        || types::UserId::from(state.env.canister_id()) != prepared.relay_args.user_id
        || !types::is_valid_ai_app_chat_name(&prepared.relay_args.chat_name)
        || !state.data.direct_chats.exists(&other_user_id.into())
    {
        return Err(NotAuthorized);
    }
    Ok(())
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
