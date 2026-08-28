use crate::{RuntimeState, read_state};
use canister_api_macros::update;
use group_canister::create_ai_app_card_confirmation_grant::{Response::*, *};
use local_user_index_canister::c2c_create_ai_app_card_confirmation_grant as relay;
use types::Chat;

#[update(msgpack = true)]
async fn create_ai_app_card_confirmation_grant(args: Args) -> Response {
    // The generic edited-confirmation protocol is intentionally local/test-mode only until its
    // production rollout is approved separately.
    if !read_state(|state| state.data.test_mode) {
        return AppUnavailable;
    }
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
    prepared.relay_args.authority = authority;
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
        Ok(relay::Response::Error(_)) | Err(_) => {
            Error(oc_error_codes::OCErrorCode::C2CError.with_message("confirmation grant service unavailable"))
        }
    }
}

struct Prepared {
    local_user_index_canister_id: types::CanisterId,
    group_index_canister_id: types::CanisterId,
    relay_args: relay::Args,
}

impl Prepared {
    fn binding(&self) -> group_index_canister::ai_app_card_authority::AiAppCardAuthorityBindingV1 {
        let chat_key = match self.relay_args.chat {
            Chat::Group(chat_id) => format!("group:{chat_id}"),
            _ => unreachable!("group confirmation prepared a non-group chat"),
        };
        group_index_canister::ai_app_card_authority::AiAppCardAuthorityBindingV1 {
            local_user_index_canister_id: self.local_user_index_canister_id,
            context: types::AiAppCardContext {
                user_id: self.relay_args.user_id,
                chat: self.relay_args.chat,
                chat_key,
                thread_root_message_index: self.relay_args.thread_root_message_index,
                message_id: self.relay_args.message_id,
                app_id: self.relay_args.app_id,
                app_revision: self.relay_args.app_revision,
                action_id: self.relay_args.action_id.clone(),
            },
            content_hash: self.relay_args.content_hash,
            operation: group_index_canister::ai_app_card_authority::AiAppCardAuthorityOperationV1::CreateConfirmationGrant {
                confirm_payload_hash: types::ai_app_card_confirm_payload_hash_v1(&self.relay_args.confirm_payload)
                    .expect("validated confirmation payload must hash"),
            },
        }
    }
}

fn prepare(args: &Args, state: &RuntimeState) -> Result<Prepared, oc_error_codes::OCError> {
    if !state.data.test_mode {
        return Err(oc_error_codes::OCErrorCode::InvalidRequest.with_message("edited card confirmation is not enabled"));
    }
    if args.confirm_payload.is_empty() || args.confirm_payload.len() > types::MAX_AI_APP_CONFIRM_PAYLOAD_BYTES {
        return Err(oc_error_codes::OCErrorCode::InvalidRequest.with_message(format!(
            "confirmation payload must contain 1..={} bytes",
            types::MAX_AI_APP_CONFIRM_PAYLOAD_BYTES
        )));
    }
    state.data.verify_not_frozen()?;
    let user_id = state.get_caller_user_id()?;
    let source = state.data.chat.ai_app_card_confirmation_source(
        user_id,
        args.thread_root_message_index,
        args.message_id,
        state.env.now(),
    )?;
    if !state.data.enabled_ai_apps.contains(&source.app_id) {
        return Err(oc_error_codes::OCErrorCode::InvalidRequest.with_message("the card's producing app is not enabled"));
    }
    Ok(Prepared {
        local_user_index_canister_id: state.data.local_user_index_canister_id,
        group_index_canister_id: state.data.group_index_canister_id,
        relay_args: relay::Args {
            user_id,
            chat: Chat::Group(state.env.canister_id().into()),
            thread_root_message_index: args.thread_root_message_index,
            message_id: args.message_id,
            app_id: source.app_id,
            app_revision: source.app_revision,
            action_id: source.action_id,
            content_hash: source.content_hash,
            member_user_ids: vec![user_id],
            confirm_payload: args.confirm_payload.clone(),
            authority: serde_bytes::ByteBuf::new(),
        },
    })
}

fn revalidate(prepared: &Prepared, state: &RuntimeState) -> Result<(), oc_error_codes::OCError> {
    if !state.data.test_mode {
        return Err(oc_error_codes::OCErrorCode::InvalidRequest.with_message("edited card confirmation is not enabled"));
    }
    state.data.verify_not_frozen()?;
    if state.data.local_user_index_canister_id != prepared.local_user_index_canister_id
        || state.data.group_index_canister_id != prepared.group_index_canister_id
    {
        return Err(
            oc_error_codes::OCErrorCode::C2CError.with_message("card authority route changed during confirmation attestation")
        );
    }
    let source = state.data.chat.ai_app_card_confirmation_source(
        prepared.relay_args.user_id,
        prepared.relay_args.thread_root_message_index,
        prepared.relay_args.message_id,
        state.env.now(),
    )?;
    if !state.data.enabled_ai_apps.contains(&source.app_id)
        || source.app_id != prepared.relay_args.app_id
        || source.app_revision != prepared.relay_args.app_revision
        || source.action_id != prepared.relay_args.action_id
        || source.content_hash != prepared.relay_args.content_hash
    {
        return Err(oc_error_codes::OCErrorCode::InvalidRequest.with_message("card authorization changed during attestation"));
    }
    Ok(())
}
