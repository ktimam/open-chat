use crate::activity_notifications::handle_activity_notification;
use crate::{RuntimeState, execute_update};
use canister_api_macros::update;
use community_canister::respond_to_action_card::{Response::*, *};
use local_user_index_canister::c2c_deposit_action_confirmed::ActionDepositContext;
use oc_error_codes::OCErrorCode;
use serde_bytes::ByteBuf;
use types::{ActionCardResponse, ActionCardState, CanisterId, Chat, OCResult, TimestampMillis, UserId};

const AI_APP_EDITED_CONFIRMATION_ENABLED: bool = false;

fn requested_confirm_payload_hash(args: &Args) -> OCResult<Option<[u8; 32]>> {
    match (&args.confirm_payload_override, &args.confirmation_grant) {
        (None, None) => Ok(None),
        (Some(payload), Some(grant)) if AI_APP_EDITED_CONFIRMATION_ENABLED => {
            if payload.is_empty()
                || payload.len() > types::MAX_AI_APP_CONFIRM_PAYLOAD_BYTES
                || grant.len() != types::AI_APP_CARD_TOKEN_BYTES
            {
                return Err(OCErrorCode::InvalidRequest.with_message("invalid edited confirmation payload or grant"));
            }
            types::ai_app_card_confirm_payload_hash_v1(payload)
                .map(Some)
                .map_err(|error| OCErrorCode::InvalidRequest.with_message(error))
        }
        (Some(_), Some(_)) => Err(OCErrorCode::InvalidRequest.with_message("edited card confirmation is not enabled")),
        _ => Err(OCErrorCode::InvalidRequest
            .with_message("confirm_payload_override and confirmation_grant must be supplied together")),
    }
}

// Two-phase confirm: a confirm that carries delivery routing DEPOSITS FIRST and only commits
// `Confirmed` once the deposit is stored — so a FAILED deposit leaves the card Pending (the user can
// retry) rather than a Confirmed-but-undelivered card that silently reached no inbox. Cancels and
// routing-less confirms commit in a single synchronous pass (there is nothing to deposit).
#[update(msgpack = true)]
async fn respond_to_action_card(args: Args) -> Response {
    // `user_id` is captured in `prepare` BEFORE the await: after the inter-canister deposit call the
    // caller (`msg_caller`) is the local_user_index canister, not the user, so the commit must reuse
    // the resolved id rather than re-read the caller.
    let (user_id, deposit) = match execute_update(|state| prepare(&args, state)) {
        Ok(Prepared::Committed(state)) => return Success(state),
        Ok(Prepared::NeedsDeposit { user_id, deposit }) => (user_id, deposit),
        Err(error) => return Error(error),
    };

    if let Some(grant) = deposit.confirmation_grant.clone() {
        let authority = match crate::ai_app_card_authority::issue(
            deposit.group_index_canister_id,
            confirmation_consume_binding(&deposit, &grant),
        )
        .await
        {
            Ok(token) => token,
            Err(error) => {
                execute_update(|state| abort_response(&args, user_id, state));
                return Error(error);
            }
        };
        if let Err(error) = execute_update(|state| revalidate_before_deposit(user_id, &deposit, state)) {
            execute_update(|state| abort_response(&args, user_id, state));
            return Error(error);
        }
        let result = local_user_index_canister_c2c_client::c2c_consume_ai_app_card_confirmation_grant(
            deposit.local_user_index_canister_id,
            &local_user_index_canister::c2c_consume_ai_app_card_confirmation_grant::Args {
                user_id,
                chat: deposit.context.chat,
                thread_root_message_index: deposit.context.thread_root_message_index,
                message_id: deposit.context.message_id,
                app_id: deposit.context.app_id.expect("verified app deposit must have an app id"),
                app_revision: deposit
                    .context
                    .app_revision
                    .expect("verified app deposit must have a revision"),
                action_id: deposit.context.action_id.clone(),
                content_hash: deposit
                    .context
                    .content_hash
                    .expect("verified app deposit must have a content hash"),
                member_user_ids: deposit.context.member_user_ids.clone(),
                confirm_payload_hash: deposit.confirm_payload_hash,
                grant,
                confirmation_lease_generation: deposit.context.confirmation_lease_generation,
                authority,
            },
        )
        .await;
        match result {
            Ok(local_user_index_canister::c2c_consume_ai_app_card_confirmation_grant::Response::Success) => {}
            Ok(_) | Err(_) => {
                execute_update(|state| abort_response(&args, user_id, state));
                return Error(OCErrorCode::C2CError.with_message("confirmation grant could not be consumed"));
            }
        }
        if let Err(error) = execute_update(|state| revalidate_before_deposit(user_id, &deposit, state)) {
            execute_update(|state| abort_response(&args, user_id, state));
            return Error(error);
        }
    }

    let deposit_authority = match crate::ai_app_card_authority::issue(
        deposit.group_index_canister_id,
        confirmation_deposit_binding(&deposit),
    )
    .await
    {
        Ok(token) => token,
        Err(error) => {
            execute_update(|state| abort_response(&args, user_id, state));
            return Error(error);
        }
    };
    // The issue call yielded. Recheck the exact member/card/app/action/lease reservation before
    // handing the one-use authority and payload to LocalUserIndex.
    if let Err(error) = execute_update(|state| revalidate_before_deposit(user_id, &deposit, state)) {
        execute_update(|state| abort_response(&args, user_id, state));
        return Error(error);
    }

    match local_user_index_canister_c2c_client::c2c_deposit_action_confirmed(
        deposit.local_user_index_canister_id,
        &local_user_index_canister::c2c_deposit_action_confirmed::Args {
            // Legacy sender-carried routing stays empty. local_user_index resolves the exact
            // manifest inbox and recipient keys from app provenance and these authoritative members.
            consumer_public_key_pem: String::new(),
            consumer_public_key_pems: Vec::new(),
            plaintext: deposit.confirm_payload.clone(),
            created_at: deposit.created_at,
            inbox_canister_id: None,
            context: deposit.context.clone(),
            authority: deposit_authority,
        },
    )
    .await
    {
        Ok(local_user_index_canister::c2c_deposit_action_confirmed::Response::Success) => {}
        Ok(local_user_index_canister::c2c_deposit_action_confirmed::Response::OutcomeUnknown) | Err(_) => {
            return Error(OCErrorCode::C2CError.with_message("action deposit outcome is pending reconciliation"));
        }
        Ok(_) => {
            execute_update(|state| abort_response(&args, user_id, state));
            return Error(OCErrorCode::C2CError.with_message("action deposit was rejected"));
        }
    }

    // Deposit stored — commit the confirm now (using the pre-await `user_id`).
    match execute_update(|state| complete_response(&deposit, user_id, state)) {
        Ok(state) => Success(state),
        Err(error) => Error(error),
    }
}

enum Prepared {
    Committed(ActionCardState),
    NeedsDeposit { user_id: UserId, deposit: DepositInstruction },
}

struct DepositInstruction {
    local_user_index_canister_id: CanisterId,
    group_index_canister_id: CanisterId,
    confirm_payload: ByteBuf,
    confirm_payload_hash: [u8; 32],
    confirmation_grant: Option<ByteBuf>,
    created_at: TimestampMillis,
    context: ActionDepositContext,
}

fn confirmation_consume_binding(
    deposit: &DepositInstruction,
    grant: &ByteBuf,
) -> group_index_canister::ai_app_card_authority::AiAppCardAuthorityBindingV1 {
    confirmation_binding(
        deposit,
        group_index_canister::ai_app_card_authority::AiAppCardAuthorityOperationV1::ConsumeConfirmationGrant {
            confirm_payload_hash: deposit.confirm_payload_hash,
            confirmation_grant_hash: group_index_canister::ai_app_card_authority::opaque_hash_v1(
                group_index_canister::ai_app_card_authority::OpaqueHashPurposeV1::ConfirmationGrant,
                grant,
            ),
            confirmation_lease_generation: deposit.context.confirmation_lease_generation,
        },
    )
}

fn confirmation_binding(
    deposit: &DepositInstruction,
    operation: group_index_canister::ai_app_card_authority::AiAppCardAuthorityOperationV1,
) -> group_index_canister::ai_app_card_authority::AiAppCardAuthorityBindingV1 {
    let chat_key = match deposit.context.chat {
        Chat::Channel(community_id, channel_id) => format!("channel:{community_id}:{channel_id}"),
        _ => unreachable!("community confirmation prepared a non-channel chat"),
    };
    group_index_canister::ai_app_card_authority::AiAppCardAuthorityBindingV1 {
        local_user_index_canister_id: deposit.local_user_index_canister_id,
        context: types::AiAppCardContext {
            user_id: deposit.context.confirmed_by,
            chat: deposit.context.chat,
            chat_key,
            thread_root_message_index: deposit.context.thread_root_message_index,
            message_id: deposit.context.message_id,
            app_id: deposit.context.app_id.expect("verified app deposit must have an app id"),
            app_revision: deposit
                .context
                .app_revision
                .expect("verified app deposit must have a revision"),
            action_id: deposit.context.action_id.clone(),
        },
        content_hash: deposit
            .context
            .content_hash
            .expect("verified app deposit must have a content hash"),
        operation,
    }
}

fn confirmation_deposit_binding(
    deposit: &DepositInstruction,
) -> group_index_canister::ai_app_card_authority::AiAppCardAuthorityBindingV1 {
    confirmation_binding(
        deposit,
        group_index_canister::ai_app_card_authority::AiAppCardAuthorityOperationV1::DepositConfirmedAction {
            confirm_payload_hash: deposit.confirm_payload_hash,
            confirmation_lease_generation: deposit.context.confirmation_lease_generation,
            created_at: deposit.created_at,
        },
    )
}

fn prepare(args: &Args, state: &mut RuntimeState) -> OCResult<Prepared> {
    state.data.verify_not_frozen()?;
    let user_id = state.get_calling_member(true)?.user_id;
    let now = state.env.now();
    if !matches!(args.response, ActionCardResponse::Confirm)
        && (args.confirm_payload_override.is_some() || args.confirmation_grant.is_some())
    {
        return Err(OCErrorCode::InvalidRequest.with_message("cancel cannot carry a confirmation payload or grant"));
    }
    let requested_payload_hash = requested_confirm_payload_hash(args)?;

    // Confirm of a Pending, routing-bearing card: peek the deposit (no state change) and defer the
    // commit until the deposit lands.
    if matches!(args.response, ActionCardResponse::Confirm) {
        let channel = state.data.channels.get_mut_or_err(&args.channel_id)?;
        let peeked = channel.chat.reserve_action_card_confirm(
            user_id,
            args.thread_root_message_index,
            args.message_id,
            requested_payload_hash,
            now,
        )?;
        // `channel`'s borrow of `state.data.channels` ends here — `peeked` is owned.
        if let Some(deposit) = peeked {
            if deposit
                .app_id
                .is_some_and(|app_id| !channel.enabled_ai_apps.contains(&app_id))
            {
                let _ = channel
                    .chat
                    .abort_action_card_confirm(user_id, args.thread_root_message_index, args.message_id, now);
                return Err(OCErrorCode::InvalidRequest.with_message("the card's producing app is not enabled in this chat"));
            }
            // This canister IS the community, so it supplies the chat identity for the deposit context.
            let chat = Chat::Channel(state.env.canister_id().into(), args.channel_id);
            // App-rendered cards (Phase 2): if the confirmer's app sent an edited payload within
            // bounds, deposit THOSE bytes instead of the frozen stored payload; None keeps the stored
            // bytes, while empty/oversized overrides are rejected. SECURITY: the caller is
            // already the authed confirmer (a chat member); the size bound stops an oversized blob;
            // and the consumer app re-validates the payload against its own schema — so OpenChat stays
            // semantics-blind, depositing opaque bytes exactly as today.
            let (confirm_payload, confirmation_grant) = match (&args.confirm_payload_override, &args.confirmation_grant) {
                (None, None) => (deposit.confirm_payload, None),
                (Some(payload), Some(grant)) => (payload.clone(), Some(grant.clone())),
                _ => unreachable!("both-or-neither was validated before reservation"),
            };
            let member_user_ids = local_user_index_canister::c2c_deposit_action_confirmed::bounded_action_card_members(
                deposit.confirmed_by,
                channel.chat.members.member_ids().iter().copied(),
            );
            return Ok(Prepared::NeedsDeposit {
                user_id,
                deposit: DepositInstruction {
                    local_user_index_canister_id: state.data.local_user_index_canister_id,
                    group_index_canister_id: state.data.group_index_canister_id,
                    confirm_payload,
                    confirm_payload_hash: deposit.confirm_payload_hash,
                    confirmation_grant,
                    created_at: deposit.responded_at,
                    context: ActionDepositContext {
                        chat,
                        message_id: deposit.message_id,
                        thread_root_message_index: deposit.thread_root_message_index,
                        confirmed_by: deposit.confirmed_by,
                        app_id: deposit.app_id,
                        app_revision: deposit.app_revision,
                        app_verified: deposit.app_verified,
                        content_hash: deposit.content_hash,
                        confirmation_lease_generation: deposit.confirmation_lease_generation,
                        action_id: deposit.action_id,
                        member_user_ids,
                    },
                },
            });
        }
    }

    // Cancel, or a confirm with nothing to deposit — commit synchronously.
    commit_response(args, user_id, state).map(Prepared::Committed)
}

fn revalidate_before_deposit(user_id: UserId, deposit: &DepositInstruction, state: &RuntimeState) -> OCResult {
    state.data.verify_not_frozen()?;
    if state.data.local_user_index_canister_id != deposit.local_user_index_canister_id
        || state.data.group_index_canister_id != deposit.group_index_canister_id
    {
        return Err(OCErrorCode::InvalidRequest.with_message("action-card route changed before delivery"));
    }
    let channel_id = match deposit.context.chat {
        Chat::Channel(_, channel_id) => channel_id,
        _ => return Err(OCErrorCode::InvalidRequest.with_message("invalid channel confirmation context")),
    };
    let channel = state.data.channels.get_or_err(&channel_id)?;
    if !state.data.members.contains(&user_id) || !channel.chat.members.contains(&user_id) {
        return Err(OCErrorCode::InitiatorNotInChat.into());
    }
    let source = channel.chat.ai_app_card_confirmation_reservation_source(
        user_id,
        deposit.context.thread_root_message_index,
        deposit.context.message_id,
        deposit.context.confirmation_lease_generation,
        deposit.confirm_payload_hash,
        state.env.now(),
    )?;
    if !channel.enabled_ai_apps.contains(&source.app_id)
        || Some(source.app_id) != deposit.context.app_id
        || Some(source.app_revision) != deposit.context.app_revision
        || source.action_id != deposit.context.action_id
        || Some(source.content_hash) != deposit.context.content_hash
    {
        return Err(OCErrorCode::InvalidRequest.with_message("card authorization changed before delivery"));
    }
    Ok(())
}

fn commit_response(args: &Args, user_id: UserId, state: &mut RuntimeState) -> OCResult<ActionCardState> {
    state.data.verify_not_frozen()?;
    let now = state.env.now();

    let channel = state.data.channels.get_mut_or_err(&args.channel_id)?;
    let result =
        channel
            .chat
            .respond_to_action_card(user_id, args.thread_root_message_index, args.message_id, args.response, now)?;

    state.push_bot_notification(result.bot_notification);
    handle_activity_notification(state);

    Ok(result.value.state)
}

fn complete_response(deposit: &DepositInstruction, user_id: UserId, state: &mut RuntimeState) -> OCResult<ActionCardState> {
    let channel_id = match deposit.context.chat {
        Chat::Channel(_, channel_id) => channel_id,
        _ => return Err(OCErrorCode::InvalidRequest.with_message("invalid channel confirmation context")),
    };
    let channel = state.data.channels.get_mut_or_err(&channel_id)?;
    let result = channel.chat.complete_action_card_confirm(
        user_id,
        deposit.context.thread_root_message_index,
        deposit.context.message_id,
        deposit.context.confirmation_lease_generation,
        deposit.confirm_payload_hash,
        state.env.now(),
    )?;
    state.push_bot_notification(result.bot_notification);
    handle_activity_notification(state);
    Ok(result.value.state)
}

fn abort_response(args: &Args, user_id: UserId, state: &mut RuntimeState) {
    if let Ok(channel) = state.data.channels.get_mut_or_err(&args.channel_id) {
        let _ =
            channel
                .chat
                .abort_action_card_confirm(user_id, args.thread_root_message_index, args.message_id, state.env.now());
    }
}
#[cfg(test)]
mod tests {
    use super::requested_confirm_payload_hash;
    use community_canister::respond_to_action_card::Args;
    use serde_bytes::ByteBuf;
    use types::{ActionCardResponse, MessageId};

    // The frozen payload posted at propose time — the fallback whenever the override is absent/invalid.
    fn args(payload: Option<ByteBuf>, grant: Option<ByteBuf>) -> Args {
        Args {
            channel_id: 1u32.into(),
            thread_root_message_index: None,
            message_id: MessageId::from(1u64),
            response: ActionCardResponse::Confirm,
            confirm_payload_override: payload,
            confirmation_grant: grant,
        }
    }

    #[test]
    fn none_override_keeps_stored() {
        assert_eq!(requested_confirm_payload_hash(&args(None, None)).unwrap(), None);
    }

    #[test]
    fn empty_override_is_rejected() {
        // len 0 is outside 1..=MAX — a member must not be able to blank the payload to empty bytes.
        assert!(requested_confirm_payload_hash(&args(Some(ByteBuf::new()), None)).is_err());
    }

    #[test]
    fn different_override_is_rejected() {
        assert!(
            requested_confirm_payload_hash(&args(
                Some(ByteBuf::from(b"EDITED".to_vec())),
                Some(ByteBuf::from(vec![7; types::AI_APP_CARD_TOKEN_BYTES])),
            ))
            .is_err()
        );
    }

    #[test]
    fn byte_identical_override_is_rejected_without_a_one_time_grant() {
        // The 16_384-byte bound is INCLUSIVE — exactly MAX is deposited.
        assert!(requested_confirm_payload_hash(&args(None, Some(ByteBuf::from(vec![7; 32])))).is_err());
    }

    #[test]
    fn oversized_override_is_rejected() {
        // One byte over MAX (16_385) is rejected — the cap limits how much a member can deposit.
        let edited = ByteBuf::from(vec![b'x'; types::MAX_AI_APP_CONFIRM_PAYLOAD_BYTES + 1]);
        assert!(requested_confirm_payload_hash(&args(Some(edited), Some(ByteBuf::from(vec![7; 32])))).is_err());
    }
}
