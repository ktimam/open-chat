use crate::{RuntimeState, read_state};
use canister_api_macros::update;
use group_canister::create_ai_app_private_match_capability::{Response::*, *};
use local_user_index_canister::c2c_create_ai_app_private_match_capability as relay;
use types::Chat;

#[update(msgpack = true)]
async fn create_ai_app_private_match_capability(args: Args) -> Response {
    let mut prepared = match read_state(|state| prepare(&args, state)) {
        Ok(value) => value,
        Err(error) => return Error(error),
    };
    let authority = match crate::ai_app_card_authority::issue(prepared.group_index_canister_id, prepared.binding()).await {
        Ok(token) => token,
        Err(error) => return Error(error),
    };
    if let Err(error) = read_state(|state| revalidate(&prepared, state)) {
        return Error(error);
    }
    prepared.args.authority = authority;
    let result = local_user_index_canister_c2c_client::c2c_create_ai_app_private_match_capability(
        prepared.local_user_index_canister_id,
        &prepared.args,
    )
    .await;
    if let Err(error) = read_state(|state| revalidate(&prepared, state)) {
        return Error(error);
    }
    relay_response(result)
}

struct Prepared {
    local_user_index_canister_id: types::CanisterId,
    group_index_canister_id: types::CanisterId,
    source_event_index: types::EventIndex,
    source_message_timestamp: types::TimestampMillis,
    args: relay::Args,
}

impl Prepared {
    fn binding(&self) -> group_index_canister::ai_app_card_authority::AiAppCardAuthorityBindingV1 {
        let Chat::Group(chat_id) = self.args.chat else {
            unreachable!("group private match prepared a non-group chat")
        };
        group_index_canister::ai_app_card_authority::AiAppCardAuthorityBindingV1 {
            local_user_index_canister_id: self.local_user_index_canister_id,
            context: types::AiAppCardContext {
                user_id: self.args.user_id,
                chat: self.args.chat,
                chat_key: format!("group:{chat_id}"),
                thread_root_message_index: self.args.thread_root_message_index,
                message_id: self.args.message_id,
                app_id: self.args.app_id,
                app_revision: self.args.app_revision,
                action_id: self.args.action_id.clone(),
            },
            content_hash: [0; 32],
            operation:
                group_index_canister::ai_app_card_authority::AiAppCardAuthorityOperationV1::CreatePrivateMatchCapability {
                    source_binding: self.args.source_binding,
                    recipient_key_scheme: self.args.recipient_key_scheme.clone(),
                    recipient_public_key_hash: group_index_canister::ai_app_card_authority::opaque_hash_v1(
                        group_index_canister::ai_app_card_authority::OpaqueHashPurposeV1::RecipientPublicKey,
                        &self.args.recipient_public_key,
                    ),
                },
        }
    }
}

fn prepare(args: &Args, state: &RuntimeState) -> Result<Prepared, oc_error_codes::OCError> {
    state.data.verify_not_frozen()?;
    let user_id = state.get_caller_user_id()?;
    if !state.data.enabled_ai_apps.contains(&args.app_id) {
        return Err(oc_error_codes::OCErrorCode::InvalidRequest.with_message("the app is not enabled in this chat"));
    }
    let source = state.data.chat.ai_app_private_match_source(
        user_id,
        args.thread_root_message_index,
        args.message_id,
        state.env.now(),
    )?;
    Ok(Prepared {
        local_user_index_canister_id: state.data.local_user_index_canister_id,
        group_index_canister_id: state.data.group_index_canister_id,
        source_event_index: source.event_index,
        source_message_timestamp: source.message_timestamp,
        args: relay::Args {
            user_id,
            chat: Chat::Group(state.env.canister_id().into()),
            thread_root_message_index: args.thread_root_message_index,
            message_id: args.message_id,
            app_id: args.app_id,
            app_revision: args.app_revision,
            action_id: args.action_id.clone(),
            source_binding: source.source_binding,
            member_user_ids: vec![user_id],
            recipient_key_scheme: args.recipient_key_scheme.clone(),
            recipient_public_key: args.recipient_public_key.clone(),
            authority: serde_bytes::ByteBuf::new(),
        },
    })
}

fn revalidate(prepared: &Prepared, state: &RuntimeState) -> Result<(), oc_error_codes::OCError> {
    state.data.verify_not_frozen()?;
    if state.data.local_user_index_canister_id != prepared.local_user_index_canister_id
        || state.data.group_index_canister_id != prepared.group_index_canister_id
        || !state.data.enabled_ai_apps.contains(&prepared.args.app_id)
    {
        return Err(oc_error_codes::OCErrorCode::C2CError.with_message("private-match route changed during mint"));
    }
    let source = state.data.chat.ai_app_private_match_source(
        prepared.args.user_id,
        prepared.args.thread_root_message_index,
        prepared.args.message_id,
        state.env.now(),
    )?;
    if source.source_binding != prepared.args.source_binding
        || source.event_index != prepared.source_event_index
        || source.message_timestamp != prepared.source_message_timestamp
    {
        return Err(oc_error_codes::OCErrorCode::InvalidRequest.with_message("private-match source changed during mint"));
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
        Ok(relay::Response::Error(error)) => Error(oc_error_codes::OCErrorCode::C2CError.with_message(error)),
        Err(_) => Error(oc_error_codes::OCErrorCode::C2CError.with_message("private-match service unavailable")),
    }
}
