use crate::activity_notifications::handle_activity_notification;
use crate::{RuntimeState, execute_update};
use canister_api_macros::update;
use group_canister::respond_to_action_card::{Response::*, *};
use local_user_index_canister::c2c_deposit_action_confirmed::ActionDepositContext;
use oc_error_codes::{OCError, OCErrorCode};
use serde_bytes::ByteBuf;
use types::{ActionCardResponse, ActionCardState, CanisterId, Chat, EventIndex, OCResult, TimestampMillis, UserId};

fn requested_confirm_payload_hash(args: &Args, edited_confirmation_enabled: bool) -> OCResult<Option<[u8; 32]>> {
    match (&args.confirm_payload_override, &args.confirmation_grant) {
        (None, None) => Ok(None),
        (Some(payload), Some(grant)) if edited_confirmation_enabled => {
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

    let grant_hash_to_consume = match confirmation_grant_consume_plan(
        deposit.confirmation_grant_hash,
        deposit.confirmation_grant.as_ref().map(|grant| grant.as_slice()),
    ) {
        Ok(plan) => plan,
        Err(error) => return Error(error),
    };

    if (grant_hash_to_consume.is_some() || deposit.confirmation_grant_hash.is_none())
        && let Err(error) = execute_update(|state| revalidate_before_deposit(user_id, &deposit, state))
    {
        // `reserve_action_card_confirm` may have returned a lease already shared with an in-flight
        // exact retry. This callback cannot prove it created the lease, so it must not release it.
        return Error(error);
    }

    let consumed_grant_hash = if let Some(grant_hash) = grant_hash_to_consume {
        let grant = deposit
            .confirmation_grant
            .clone()
            .expect("a grant hash to consume must have its bearer");
        let authority = match crate::ai_app_card_authority::issue(
            deposit.group_index_canister_id,
            confirmation_consume_binding(&deposit, &grant),
        )
        .await
        {
            Ok(token) => token,
            Err(error) => {
                return Error(error);
            }
        };
        if let Err(error) = execute_update(|state| revalidate_before_deposit(user_id, &deposit, state)) {
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
        if let Some(error) = confirmation_grant_consumption_error(result) {
            // A concurrent exact retry may have consumed the one-use grant and persisted its marker
            // before this reply arrived. Only that exact marker reconciles the failed consume. Any
            // other state preserves the lease because this post-await outcome is ambiguous.
            match execute_update(|state| consumed_grant_is_persisted(user_id, &deposit, grant_hash, state)) {
                Ok(true) => {}
                Ok(false) => return Error(error),
                Err(marker_error) => return Error(marker_error),
            }
        } else if let Err(error) = execute_update(|state| persist_consumed_grant(user_id, &deposit, grant_hash, state)) {
            // The bearer is already one-use-consumed. Never release its exact lease if persisting
            // the durable marker fails or conflicts.
            return Error(error);
        }
        Some(grant_hash)
    } else if let (Some(grant_hash), Some(grant)) = (
        deposit.confirmation_grant_hash,
        deposit.confirmation_grant.as_ref().map(|grant| grant.as_slice()),
    ) {
        let supplied_hash = chat_events::ai_app_card_confirmation_grant_hash_v1(grant);
        debug_assert_eq!(grant_hash, supplied_hash);
        Some(supplied_hash)
    } else {
        None
    };

    if let Some(grant_hash) = consumed_grant_hash
        && let Err(error) = execute_update(|state| require_consumed_grant(user_id, &deposit, grant_hash, state))
    {
        return Error(error);
    }

    let deposit_authority = match crate::ai_app_card_authority::issue(
        deposit.group_index_canister_id,
        confirmation_deposit_binding(&deposit),
    )
    .await
    {
        Ok(token) => token,
        Err(error) => {
            return Error(error);
        }
    };
    // The issue call yielded. Recheck the exact member/card/app/action/lease reservation before
    // handing the one-use authority and payload to LocalUserIndex.
    let revalidation = execute_update(|state| {
        if let Some(grant_hash) = consumed_grant_hash {
            require_consumed_grant(user_id, &deposit, grant_hash, state)
        } else {
            revalidate_before_deposit(user_id, &deposit, state)
        }
    });
    if let Err(error) = revalidation {
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
            // The inbox may have committed. Preserve the exact payload-bound lease; an identical
            // retry reconciles through the full-width ActionInbox commitment.
            return Error(OCErrorCode::C2CError.with_message("action deposit outcome is pending reconciliation"));
        }
        Ok(_) => {
            // Even a definite rejection belongs only to this callback. Another exact callback may
            // already be awaiting delivery on the same actor/generation/payload lease.
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
    confirmation_grant_hash: Option<[u8; 32]>,
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
        Chat::Group(chat_id) => format!("group:{chat_id}"),
        _ => unreachable!("group confirmation prepared a non-group chat"),
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
    let user_id = state.get_caller_user_id()?;
    let now = state.env.now();
    if !matches!(args.response, ActionCardResponse::Confirm)
        && (args.confirm_payload_override.is_some() || args.confirmation_grant.is_some())
    {
        return Err(OCErrorCode::InvalidRequest.with_message("cancel cannot carry a confirmation payload or grant"));
    }
    // Persisted test_mode is the explicit local-only release gate. Production canisters continue
    // to reject edited payloads while retaining the original stored-payload confirmation path.
    let requested_payload_hash = requested_confirm_payload_hash(args, state.data.test_mode)?;

    // Enforce chat-local app policy before reservation. A failed source lookup may be a legacy,
    // routing-less card, so the ordinary reserve/response path remains authoritative for that case.
    if matches!(args.response, ActionCardResponse::Confirm)
        && let Ok(source) =
            state
                .data
                .chat
                .ai_app_card_confirmation_source(user_id, args.thread_root_message_index, args.message_id, now)
        && !state.data.enabled_ai_apps.contains(&source.app_id)
    {
        return Err(OCErrorCode::InvalidRequest.with_message("the card's producing app is not enabled in this chat"));
    }

    // Reserve before the await. An exact retry intentionally reuses the same durable lease.
    if matches!(args.response, ActionCardResponse::Confirm)
        && let Some(deposit) = state.data.chat.reserve_action_card_confirm(
            user_id,
            args.thread_root_message_index,
            args.message_id,
            requested_payload_hash,
            now,
        )?
    {
        // This canister IS the group, so it supplies the chat identity for the deposit context itself.
        let chat = Chat::Group(state.env.canister_id().into());
        // App-rendered cards (Phase 2): if the confirmer's app sent an edited payload within bounds,
        // deposit THOSE bytes instead of the frozen stored payload; None keeps the stored bytes,
        // while empty/oversized overrides are rejected. SECURITY: the caller is already the
        // authed confirmer (get_caller_user_id) and a chat member; the size bound stops an oversized
        // blob; and the consumer app re-validates the payload against its own schema — so OpenChat
        // stays semantics-blind, depositing opaque bytes exactly as today.
        let (confirm_payload, confirmation_grant) = match (&args.confirm_payload_override, &args.confirmation_grant) {
            (None, None) => (deposit.confirm_payload, None),
            (Some(payload), Some(grant)) => (payload.clone(), Some(grant.clone())),
            _ => unreachable!("both-or-neither was validated before reservation"),
        };
        // The chat canister, not the message sender, derives the bounded recipient identity set.
        // Take one beyond the delivery cap so local_user_index can reject oversized groups instead of
        // silently omitting members.
        let member_user_ids = local_user_index_canister::c2c_deposit_action_confirmed::bounded_action_card_members(
            deposit.confirmed_by,
            state.data.chat.members.member_ids().iter().copied(),
        );
        return Ok(Prepared::NeedsDeposit {
            user_id,
            deposit: DepositInstruction {
                local_user_index_canister_id: state.data.local_user_index_canister_id,
                group_index_canister_id: state.data.group_index_canister_id,
                confirm_payload,
                confirm_payload_hash: deposit.confirm_payload_hash,
                confirmation_grant,
                confirmation_grant_hash: deposit.confirmation_grant_hash,
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

    // Cancel, or a confirm with nothing to deposit — commit synchronously.
    commit_response(args, user_id, state).map(Prepared::Committed)
}

fn revalidate_before_deposit(user_id: UserId, deposit: &DepositInstruction, state: &RuntimeState) -> OCResult {
    state.data.verify_not_frozen()?;
    if deposit.confirmation_grant.is_some() && !state.data.test_mode {
        return Err(OCErrorCode::InvalidRequest.with_message("edited card confirmation is not enabled"));
    }
    if state.data.local_user_index_canister_id != deposit.local_user_index_canister_id
        || state.data.group_index_canister_id != deposit.group_index_canister_id
    {
        return Err(OCErrorCode::InvalidRequest.with_message("action-card route changed before delivery"));
    }
    if !state.data.chat.members.contains(&user_id) {
        return Err(OCErrorCode::InitiatorNotInChat.into());
    }
    let source = state.data.chat.ai_app_card_confirmation_reservation_source(
        user_id,
        deposit.context.thread_root_message_index,
        deposit.context.message_id,
        deposit.context.confirmation_lease_generation,
        deposit.confirm_payload_hash,
        state.env.now(),
    )?;
    if !state.data.enabled_ai_apps.contains(&source.app_id)
        || Some(source.app_id) != deposit.context.app_id
        || Some(source.app_revision) != deposit.context.app_revision
        || source.action_id != deposit.context.action_id
        || Some(source.content_hash) != deposit.context.content_hash
    {
        return Err(OCErrorCode::InvalidRequest.with_message("card authorization changed before delivery"));
    }
    Ok(())
}

fn current_confirmation_grant_hash(
    user_id: UserId,
    deposit: &DepositInstruction,
    state: &RuntimeState,
) -> OCResult<Option<[u8; 32]>> {
    state.data.chat.events.action_card_confirmation_grant_hash_for_lease(
        deposit.context.thread_root_message_index,
        deposit.context.message_id,
        EventIndex::default(),
        user_id,
        deposit.context.confirmation_lease_generation,
        deposit.confirm_payload_hash,
        state.env.now(),
    )
}

fn consumed_grant_is_persisted(
    user_id: UserId,
    deposit: &DepositInstruction,
    grant_hash: [u8; 32],
    state: &RuntimeState,
) -> OCResult<bool> {
    match current_confirmation_grant_hash(user_id, deposit, state)? {
        None => Ok(false),
        Some(existing) if existing == grant_hash => Ok(true),
        Some(_) => Err(OCErrorCode::InvalidRequest.with_message("confirmation grant does not match the durable lease")),
    }
}

fn require_consumed_grant(
    user_id: UserId,
    deposit: &DepositInstruction,
    grant_hash: [u8; 32],
    state: &RuntimeState,
) -> OCResult {
    if !consumed_grant_is_persisted(user_id, deposit, grant_hash, state)? {
        return Err(OCErrorCode::InvalidRequest.with_message("confirmation grant marker is missing from the durable lease"));
    }
    revalidate_before_deposit(user_id, deposit, state)
}

fn persist_consumed_grant(
    user_id: UserId,
    deposit: &DepositInstruction,
    grant_hash: [u8; 32],
    state: &mut RuntimeState,
) -> OCResult {
    let now = state.env.now();
    state.data.chat.events.mark_action_card_confirmation_grant_consumed(
        deposit.context.thread_root_message_index,
        deposit.context.message_id,
        EventIndex::default(),
        user_id,
        deposit.context.confirmation_lease_generation,
        deposit.confirm_payload_hash,
        grant_hash,
        now,
    )
}

fn commit_response(args: &Args, user_id: UserId, state: &mut RuntimeState) -> OCResult<ActionCardState> {
    state.data.verify_not_frozen()?;
    let now = state.env.now();

    let result =
        state
            .data
            .chat
            .respond_to_action_card(user_id, args.thread_root_message_index, args.message_id, args.response, now)?;

    state.push_bot_notification(result.bot_notification);
    handle_activity_notification(state);

    Ok(result.value.state)
}

fn complete_response(deposit: &DepositInstruction, user_id: UserId, state: &mut RuntimeState) -> OCResult<ActionCardState> {
    let result = state.data.chat.complete_action_card_confirm(
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

#[cfg(test)]
mod tests {
    use super::{confirmation_grant_consume_plan, requested_confirm_payload_hash};
    use group_canister::respond_to_action_card::Args;
    use serde_bytes::ByteBuf;
    use types::{ActionCardResponse, MessageId};

    // The frozen payload posted at propose time — the fallback whenever the override is absent/invalid.
    fn args(payload: Option<ByteBuf>, grant: Option<ByteBuf>) -> Args {
        Args {
            thread_root_message_index: None,
            message_id: MessageId::from(1u64),
            response: ActionCardResponse::Confirm,
            confirm_payload_override: payload,
            confirmation_grant: grant,
        }
    }

    #[test]
    fn none_override_keeps_stored() {
        assert_eq!(requested_confirm_payload_hash(&args(None, None), false).unwrap(), None);
        assert_eq!(requested_confirm_payload_hash(&args(None, None), true).unwrap(), None);
    }

    #[test]
    fn payload_without_a_grant_is_rejected() {
        // Edited payload and grant are an atomic pair; neither may be supplied alone.
        assert!(requested_confirm_payload_hash(&args(Some(ByteBuf::new()), None), true).is_err());
    }

    #[test]
    fn valid_edited_payload_with_exact_size_grant_hashes_the_exact_bytes_in_test_mode() {
        let edited = ByteBuf::from(b"EDITED".to_vec());
        let expected = types::ai_app_card_confirm_payload_hash_v1(&edited).unwrap();
        assert_eq!(
            requested_confirm_payload_hash(
                &args(Some(edited), Some(ByteBuf::from(vec![7; types::AI_APP_CARD_TOKEN_BYTES])),),
                true,
            )
            .unwrap(),
            Some(expected)
        );
    }

    #[test]
    fn production_gate_rejects_a_well_shaped_edited_confirmation() {
        assert!(
            requested_confirm_payload_hash(
                &args(
                    Some(ByteBuf::from(b"EDITED".to_vec())),
                    Some(ByteBuf::from(vec![7; types::AI_APP_CARD_TOKEN_BYTES])),
                ),
                false,
            )
            .is_err()
        );
    }

    #[test]
    fn maximum_size_edited_payload_is_accepted() {
        let edited = ByteBuf::from(vec![b'x'; types::MAX_AI_APP_CONFIRM_PAYLOAD_BYTES]);
        let expected = types::ai_app_card_confirm_payload_hash_v1(&edited).unwrap();
        assert_eq!(
            requested_confirm_payload_hash(
                &args(Some(edited), Some(ByteBuf::from(vec![7; types::AI_APP_CARD_TOKEN_BYTES])),),
                true,
            )
            .unwrap(),
            Some(expected)
        );
    }

    #[test]
    fn empty_override_is_rejected_even_with_a_valid_grant() {
        assert!(
            requested_confirm_payload_hash(
                &args(
                    Some(ByteBuf::new()),
                    Some(ByteBuf::from(vec![7; types::AI_APP_CARD_TOKEN_BYTES])),
                ),
                true,
            )
            .is_err()
        );
    }

    #[test]
    fn grant_without_a_payload_is_rejected() {
        // A bearer without its bound edited bytes must not enter the consume path.
        assert!(
            requested_confirm_payload_hash(
                &args(None, Some(ByteBuf::from(vec![7; types::AI_APP_CARD_TOKEN_BYTES])),),
                true,
            )
            .is_err()
        );
    }

    #[test]
    fn wrong_size_grants_are_rejected() {
        let edited = ByteBuf::from(b"EDITED".to_vec());
        for grant_len in [types::AI_APP_CARD_TOKEN_BYTES - 1, types::AI_APP_CARD_TOKEN_BYTES + 1] {
            assert!(
                requested_confirm_payload_hash(&args(Some(edited.clone()), Some(ByteBuf::from(vec![7; grant_len]))), true,)
                    .is_err()
            );
        }
    }

    #[test]
    fn oversized_override_is_rejected() {
        // One byte over MAX (16_385) is rejected — the cap limits how much a member can deposit.
        let edited = ByteBuf::from(vec![b'x'; types::MAX_AI_APP_CONFIRM_PAYLOAD_BYTES + 1]);
        assert!(
            requested_confirm_payload_hash(
                &args(Some(edited), Some(ByteBuf::from(vec![7; types::AI_APP_CARD_TOKEN_BYTES])),),
                true,
            )
            .is_err()
        );
    }

    #[test]
    fn consumed_grant_marker_skips_only_the_exact_grant() {
        let grant = ByteBuf::from(vec![7; types::AI_APP_CARD_TOKEN_BYTES]);
        let grant_hash = chat_events::ai_app_card_confirmation_grant_hash_v1(&grant);

        assert_eq!(confirmation_grant_consume_plan(None, Some(&grant)).unwrap(), Some(grant_hash));
        let sibling_retry_a = confirmation_grant_consume_plan(Some(grant_hash), Some(&grant)).unwrap();
        let sibling_retry_b = confirmation_grant_consume_plan(Some(grant_hash), Some(&grant)).unwrap();
        assert_eq!(sibling_retry_a, None);
        assert_eq!(
            sibling_retry_b, None,
            "two exact callbacks sharing one lease must both reuse its durable consumed marker"
        );
        assert!(
            confirmation_grant_consume_plan(Some(grant_hash), None).is_err(),
            "omitting the consumed bearer must not use the retry fast path"
        );
        assert!(
            confirmation_grant_consume_plan(Some([0xAA; 32]), Some(&grant)).is_err(),
            "a different grant must not inherit another grant's durable consumed marker"
        );
    }

    #[test]
    fn shared_async_lease_is_never_aborted_and_app_policy_precedes_reservation() {
        let source = include_str!("respond_to_action_card.rs");
        assert!(
            !source.contains(concat!("abort_action_card_", "confirm")),
            "a callback cannot abort a lease that an exact sibling may already be awaiting"
        );
        let app_preflight = source.find(".ai_app_card_confirmation_source(").unwrap();
        let reservation = source.find(".reserve_action_card_confirm(").unwrap();
        assert!(
            app_preflight < reservation,
            "enabled-app policy must run before the shared reservation is created"
        );
    }
}

// `Some` means this lease has not consumed the supplied bearer yet. `None` means either no
// bearer is involved or the exact bearer is already durably bound to this lease and must not be
// consumed a second time.
fn confirmation_grant_consume_plan(consumed_grant_hash: Option<[u8; 32]>, grant: Option<&[u8]>) -> OCResult<Option<[u8; 32]>> {
    match (consumed_grant_hash, grant) {
        (None, None) => Ok(None),
        (None, Some(grant)) => Ok(Some(chat_events::ai_app_card_confirmation_grant_hash_v1(grant))),
        (Some(_), None) => {
            Err(OCErrorCode::InvalidRequest.with_message("the reserved retry requires its original confirmation grant"))
        }
        (Some(existing), Some(grant)) if existing == chat_events::ai_app_card_confirmation_grant_hash_v1(grant) => Ok(None),
        (Some(_), Some(_)) => {
            Err(OCErrorCode::InvalidRequest.with_message("confirmation grant does not match the reserved retry"))
        }
    }
}

fn confirmation_grant_consumption_error(
    result: Result<local_user_index_canister::c2c_consume_ai_app_card_confirmation_grant::Response, types::C2CError>,
) -> Option<OCError> {
    match result {
        Ok(local_user_index_canister::c2c_consume_ai_app_card_confirmation_grant::Response::Success) => None,
        Ok(local_user_index_canister::c2c_consume_ai_app_card_confirmation_grant::Response::NotFound) => {
            Some(OCErrorCode::InvalidRequest.with_message("confirmation grant was not found"))
        }
        Ok(local_user_index_canister::c2c_consume_ai_app_card_confirmation_grant::Response::Expired) => {
            Some(OCErrorCode::InvalidRequest.with_message("confirmation grant expired"))
        }
        Ok(local_user_index_canister::c2c_consume_ai_app_card_confirmation_grant::Response::AppUnavailable) => {
            Some(OCErrorCode::InvalidRequest.with_message("AI app is unavailable"))
        }
        Ok(local_user_index_canister::c2c_consume_ai_app_card_confirmation_grant::Response::InvalidRequest(error)) => {
            Some(OCErrorCode::InvalidRequest.with_message(error))
        }
        Ok(local_user_index_canister::c2c_consume_ai_app_card_confirmation_grant::Response::Error(_)) | Err(_) => {
            Some(OCErrorCode::C2CError.with_message("confirmation grant service unavailable"))
        }
    }
}
