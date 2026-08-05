use crate::action_deposit_envelope;
use crate::guards::caller_is_local_child_canister;
use crate::read_state;
use crate::updates::c2c_create_ai_app_card_capability::{
    authoritative_child_registration, validate_authoritative_child_context,
};
use canister_api_macros::update;
use local_user_index_canister::c2c_validate_ai_app_card_provenance::{Response::*, *};
use types::AiAppCardContext;

#[update(guard = "caller_is_local_child_canister", msgpack = true)]
async fn c2c_validate_ai_app_card_provenance(args: Args) -> Response {
    let caller = ic_cdk::api::msg_caller();
    let caller_registration = read_state(|state| authoritative_child_registration(state, caller));
    let expected_user_id = args.user_id;
    let expected_chat = args.chat;
    let expected_member_user_ids = args.member_user_ids.clone();
    if let Err(error) = validate_authoritative_child_context(
        args.user_id,
        args.chat,
        &args.member_user_ids,
        caller,
        caller_registration.kind,
    ) {
        return InvalidRequest(error);
    }
    let chat_key = match action_deposit_envelope::chat_key(&args.chat, &args.member_user_ids) {
        Ok(value) => value,
        Err(error) => return InvalidRequest(error),
    };
    let context = AiAppCardContext {
        user_id: args.user_id,
        chat: args.chat,
        chat_key,
        thread_root_message_index: args.thread_root_message_index,
        message_id: args.message_id,
        app_id: args.app_id,
        app_revision: args.app_revision,
        action_id: args.action_id,
    };
    match user_index_canister_c2c_client::c2c_validate_ai_app_card_provenance(
        read_state(|state| state.data.user_index_canister_id),
        &user_index_canister::c2c_validate_ai_app_card_provenance::Args {
            context,
            content_hash: args.content_hash,
            provenance: args.provenance,
            authority: args.authority,
        },
    )
    .await
    {
        Ok(user_index_canister::c2c_validate_ai_app_card_provenance::Response::Success) => {
            // The child registry can change while UserIndex is awaited. Never forward Success to a
            // canister that was unregistered or reclassified during that gap.
            let current_registration = read_state(|state| authoritative_child_registration(state, caller));
            if current_registration != caller_registration {
                return InvalidRequest("local child registration changed while provenance was validated".to_string());
            }
            match validate_authoritative_child_context(
                expected_user_id,
                expected_chat,
                &expected_member_user_ids,
                caller,
                current_registration.kind,
            ) {
                Ok(()) => Success,
                Err(error) => InvalidRequest(error),
            }
        }
        Ok(user_index_canister::c2c_validate_ai_app_card_provenance::Response::InvalidProvenance) => InvalidProvenance,
        Ok(user_index_canister::c2c_validate_ai_app_card_provenance::Response::AppUnavailable) => AppUnavailable,
        Ok(user_index_canister::c2c_validate_ai_app_card_provenance::Response::InvalidRequest(error)) => InvalidRequest(error),
        Ok(user_index_canister::c2c_validate_ai_app_card_provenance::Response::Error(_)) | Err(_) => {
            Error("AI-app provenance service unavailable".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::updates::c2c_create_ai_app_card_capability::AuthoritativeChildKind;
    use candid::Principal;
    use types::UserId;

    #[test]
    fn unregister_during_user_index_await_invalidates_the_relay() {
        let caller = Principal::from_slice(&[7]);
        let viewer: UserId = Principal::from_slice(&[8]).into();
        let chat = types::Chat::Group(caller.into());
        assert!(validate_authoritative_child_context(viewer, chat, &[viewer], caller, AuthoritativeChildKind::Group).is_ok());
        assert!(
            validate_authoritative_child_context(viewer, chat, &[viewer], caller, AuthoritativeChildKind::Unknown).is_err()
        );
    }

    #[test]
    fn reclassification_during_user_index_await_invalidates_the_relay() {
        let caller = Principal::from_slice(&[7]);
        let viewer: UserId = Principal::from_slice(&[8]).into();
        let chat = types::Chat::Group(caller.into());
        assert!(
            validate_authoritative_child_context(viewer, chat, &[viewer], caller, AuthoritativeChildKind::Community).is_err()
        );
    }
}
