use crate::{RuntimeState, read_state};
use canister_api_macros::update;
use group_canister::create_ai_app_card_capability::{Response::*, *};
use local_user_index_canister::c2c_create_ai_app_card_capability as relay;
use types::Chat;

#[update(msgpack = true)]
async fn create_ai_app_card_capability(args: Args) -> Response {
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
    let result = local_user_index_canister_c2c_client::c2c_create_ai_app_card_capability(
        prepared.local_user_index_canister_id,
        &prepared.args,
    )
    .await;
    if let Err(error) = read_state(|state| revalidate(&prepared, state)) {
        return Error(error);
    }
    relay_response(result)
}

fn revalidate(prepared: &Prepared, state: &RuntimeState) -> Result<(), oc_error_codes::OCError> {
    state.data.verify_not_frozen()?;
    if state.data.local_user_index_canister_id != prepared.local_user_index_canister_id
        || state.data.group_index_canister_id != prepared.group_index_canister_id
    {
        return Err(oc_error_codes::OCErrorCode::C2CError.with_message("card authority route changed during capability mint"));
    }
    let source = state.data.chat.ai_app_card_capability_source(
        prepared.args.user_id,
        prepared.args.thread_root_message_index,
        prepared.args.message_id,
        state.env.now(),
    )?;
    if !state.data.enabled_ai_apps.contains(&source.app_id)
        || source.app_id != prepared.args.app_id
        || source.app_revision != prepared.args.app_revision
        || source.action_id != prepared.args.action_id
        || source.content_hash != prepared.args.content_hash
    {
        return Err(
            oc_error_codes::OCErrorCode::InvalidRequest.with_message("card authorization changed during capability mint")
        );
    }
    Ok(())
}

struct Prepared {
    local_user_index_canister_id: types::CanisterId,
    group_index_canister_id: types::CanisterId,
    args: relay::Args,
}

impl Prepared {
    fn binding(&self) -> group_index_canister::ai_app_card_authority::AiAppCardAuthorityBindingV1 {
        let chat_key = match self.args.chat {
            Chat::Group(chat_id) => format!("group:{chat_id}"),
            _ => unreachable!("group capability prepared a non-group chat"),
        };
        group_index_canister::ai_app_card_authority::AiAppCardAuthorityBindingV1 {
            local_user_index_canister_id: self.local_user_index_canister_id,
            context: types::AiAppCardContext {
                user_id: self.args.user_id,
                chat: self.args.chat,
                chat_key,
                thread_root_message_index: self.args.thread_root_message_index,
                message_id: self.args.message_id,
                app_id: self.args.app_id,
                app_revision: self.args.app_revision,
                action_id: self.args.action_id.clone(),
            },
            content_hash: self.args.content_hash,
            operation:
                group_index_canister::ai_app_card_authority::AiAppCardAuthorityOperationV1::CreatePrivateContextCapability {
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
    let source = state.data.chat.ai_app_card_capability_source(
        user_id,
        args.thread_root_message_index,
        args.message_id,
        state.env.now(),
    )?;
    if !state.data.enabled_ai_apps.contains(&source.app_id) {
        return Err(
            oc_error_codes::OCErrorCode::InvalidRequest.with_message("the card's producing app is not enabled in this chat")
        );
    }
    Ok(Prepared {
        local_user_index_canister_id: state.data.local_user_index_canister_id,
        group_index_canister_id: state.data.group_index_canister_id,
        args: relay::Args {
            user_id,
            chat: Chat::Group(state.env.canister_id().into()),
            thread_root_message_index: args.thread_root_message_index,
            message_id: args.message_id,
            app_id: source.app_id,
            app_revision: source.app_revision,
            action_id: source.action_id,
            content_hash: source.content_hash,
            member_user_ids: vec![user_id],
            recipient_key_scheme: args.recipient_key_scheme.clone(),
            recipient_public_key: args.recipient_public_key.clone(),
            authority: serde_bytes::ByteBuf::new(),
        },
    })
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
        Ok(relay::Response::Error(error)) => Error(oc_error_codes::OCErrorCode::C2CError.with_message(error)),
        Err(_) => Error(oc_error_codes::OCErrorCode::C2CError.with_message("capability service unavailable")),
    }
}
