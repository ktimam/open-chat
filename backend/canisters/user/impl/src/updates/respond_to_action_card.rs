use crate::guards::caller_is_owner;
use crate::{RuntimeState, execute_update};
use canister_api_macros::update;
use chat_events::RespondToActionCardArgs;
use local_user_index_canister::c2c_deposit_action_confirmed::ActionDepositContext;
use oc_error_codes::OCErrorCode;
use serde_bytes::ByteBuf;
use types::{ActionCardResponse, ActionCardState, CanisterId, Chat, EventIndex, OCResult, TimestampMillis, UserId};
use user_canister::respond_to_action_card::{Response::*, *};
use user_canister::{ActionCardStatusChange, UserCanisterEvent};

// Only the payload committed when the card was posted may be deposited. A future editable-card
// flow must first obtain a one-time server attestation over the exact final payload.
fn resolve_confirm_payload(
    override_bytes: &Option<ByteBuf>,
    confirmation_grant: &Option<ByteBuf>,
    stored: ByteBuf,
) -> OCResult<ByteBuf> {
    match (override_bytes, confirmation_grant) {
        (None, None) => Ok(stored),
        _ => Err(OCErrorCode::InvalidRequest.with_message("edited confirmations are unavailable in direct chats")),
    }
}

// The direct-chat confirm path. Two-phase like the group/community canisters: a confirm that carries
// delivery routing DEPOSITS FIRST and only commits `Confirmed` (and mirrors that onto the other
// participant's copy) once the deposit is stored — so a FAILED deposit leaves the card Pending
// (retryable) and never mirrors a Confirmed-but-undelivered state to the peer. Cancels and
// routing-less confirms commit in a single synchronous pass.
#[update(guard = "caller_is_owner", msgpack = true)]
async fn respond_to_action_card(args: Args) -> Response {
    let deposit = match execute_update(|state| prepare(&args, state)) {
        Ok(Prepared::Committed(state)) => return Success(state),
        Ok(Prepared::NeedsDeposit(deposit)) => deposit,
        Err(error) => return Error(error.into()),
    };

    match local_user_index_canister_c2c_client::c2c_deposit_action_confirmed(
        deposit.local_user_index_canister_id,
        &local_user_index_canister::c2c_deposit_action_confirmed::Args {
            // Legacy sender-carried routing stays empty. local_user_index resolves the exact
            // manifest inbox and recipient keys from app provenance and these two participants.
            consumer_public_key_pem: String::new(),
            consumer_public_key_pems: Vec::new(),
            plaintext: deposit.confirm_payload.clone(),
            created_at: deposit.created_at,
            inbox_canister_id: None,
            context: deposit.context.clone(),
            // Direct-chat delivery is intentionally unsupported by LocalUserIndex and fails before
            // authority use. Keep this legacy call wire-complete without minting any authority.
            authority: ByteBuf::new(),
        },
    )
    .await
    {
        Ok(local_user_index_canister::c2c_deposit_action_confirmed::Response::Success) => {}
        Ok(local_user_index_canister::c2c_deposit_action_confirmed::Response::OutcomeUnknown) | Err(_) => {
            return Error(OCErrorCode::C2CError.with_message("action deposit outcome is pending reconciliation"));
        }
        Ok(_) => {
            execute_update(|state| abort_response(&args, state));
            return Error(OCErrorCode::C2CError.with_message("action deposit was rejected"));
        }
    }

    // Deposit stored — commit the confirm (and mirror it to the peer) now.
    match execute_update(|state| complete_response(&args, &deposit, state)) {
        Ok(state) => Success(state),
        Err(error) => Error(error.into()),
    }
}

enum Prepared {
    Committed(ActionCardState),
    NeedsDeposit(DepositInstruction),
}

struct DepositInstruction {
    local_user_index_canister_id: CanisterId,
    confirm_payload: ByteBuf,
    confirm_payload_hash: [u8; 32],
    created_at: TimestampMillis,
    context: ActionDepositContext,
}

fn prepare(args: &Args, state: &mut RuntimeState) -> OCResult<Prepared> {
    state.data.verify_not_suspended()?;

    let my_user_id: UserId = state.env.canister_id().into();
    let now = state.env.now();

    // Confirm of a Pending, routing-bearing card: peek the deposit (no state change, no mirror) and
    // defer the commit until the deposit lands.
    if matches!(args.response, ActionCardResponse::Confirm) {
        let Some(chat) = state.data.direct_chats.get_mut(&args.user_id.into()) else {
            return Err(OCErrorCode::ChatNotFound.into());
        };
        let peeked = chat.events.reserve_action_card_confirm(
            args.thread_root_message_index,
            args.message_id,
            EventIndex::default(),
            my_user_id,
            None,
            now,
        )?;
        // `chat`'s borrow of `state.data.direct_chats` ends here — `peeked` is owned.
        if let Some(deposit) = peeked {
            // Chat::Direct remains the local perspective ("the other participant"). The authoritative
            // two-member set below lets local_user_index derive one canonical pair identity from either
            // participant's user canister.
            let chat_identity = Chat::Direct(args.user_id.into());
            // App-rendered cards (Phase 2): if the confirmer's app sent an edited payload within
            // bounds, deposit THOSE bytes instead of the frozen stored payload; None keeps the stored
            // bytes, while empty/oversized overrides are rejected. SECURITY: the caller is
            // already the authed owner (caller_is_owner guard); the size bound stops an oversized blob;
            // and the consumer app re-validates the payload against its own schema — so OpenChat stays
            // semantics-blind, depositing opaque bytes exactly as today.
            let confirm_payload = match resolve_confirm_payload(
                &args.confirm_payload_override,
                &args.confirmation_grant,
                deposit.confirm_payload,
            ) {
                Ok(payload) => payload,
                Err(error) => {
                    let _ = chat.events.abort_action_card_confirm(
                        args.thread_root_message_index,
                        args.message_id,
                        EventIndex::default(),
                        my_user_id,
                        now,
                    );
                    return Err(error);
                }
            };
            return Ok(Prepared::NeedsDeposit(DepositInstruction {
                local_user_index_canister_id: state.data.local_user_index_canister_id,
                confirm_payload,
                confirm_payload_hash: deposit.confirm_payload_hash,
                created_at: deposit.responded_at,
                context: ActionDepositContext {
                    chat: chat_identity,
                    message_id: deposit.message_id,
                    thread_root_message_index: deposit.thread_root_message_index,
                    confirmed_by: deposit.confirmed_by,
                    app_id: deposit.app_id,
                    app_revision: deposit.app_revision,
                    app_verified: deposit.app_verified,
                    content_hash: deposit.content_hash,
                    confirmation_lease_generation: deposit.confirmation_lease_generation,
                    action_id: deposit.action_id,
                    member_user_ids: vec![my_user_id, args.user_id.into()],
                },
            }));
        }
    }

    // Cancel, or a confirm with nothing to deposit — commit synchronously.
    commit_response(args, state).map(Prepared::Committed)
}

fn commit_response(args: &Args, state: &mut RuntimeState) -> OCResult<ActionCardState> {
    state.data.verify_not_suspended()?;

    let my_user_id: UserId = state.env.canister_id().into();
    let now = state.env.now();

    let Some(chat) = state.data.direct_chats.get_mut(&args.user_id.into()) else {
        return Err(OCErrorCode::ChatNotFound.into());
    };

    let result = chat.events.respond_to_action_card(RespondToActionCardArgs {
        user_id: my_user_id,
        min_visible_event_index: EventIndex::default(),
        thread_root_message_index: args.thread_root_message_index,
        message_id: args.message_id,
        response: args.response,
        now,
    })?;

    let thread_root_message_id = args.thread_root_message_index.map(|i| chat.main_message_index_to_id(i));

    // Mirror the committed outcome onto the other participant's copy (apply-only there). Deferred to
    // the commit, so a confirm whose deposit FAILED never mirrors a Confirmed state to the peer.
    state.push_user_canister_event(
        args.user_id.into(),
        UserCanisterEvent::ActionCardStatusChange(Box::new(ActionCardStatusChange {
            thread_root_message_id,
            message_id: args.message_id,
            state: result.value.state.clone(),
            responded_by: my_user_id,
            responded_at: now,
        })),
    );

    Ok(result.value.state)
}

fn complete_response(args: &Args, deposit: &DepositInstruction, state: &mut RuntimeState) -> OCResult<ActionCardState> {
    let my_user_id: UserId = state.env.canister_id().into();
    let now = state.env.now();
    let Some(chat) = state.data.direct_chats.get_mut(&args.user_id.into()) else {
        return Err(OCErrorCode::ChatNotFound.into());
    };
    let result = chat.events.complete_action_card_confirm(
        deposit.context.thread_root_message_index,
        deposit.context.message_id,
        EventIndex::default(),
        my_user_id,
        deposit.context.confirmation_lease_generation,
        deposit.confirm_payload_hash,
        now,
    )?;
    let thread_root_message_id = args.thread_root_message_index.map(|i| chat.main_message_index_to_id(i));
    state.push_user_canister_event(
        args.user_id.into(),
        UserCanisterEvent::ActionCardStatusChange(Box::new(ActionCardStatusChange {
            thread_root_message_id,
            message_id: args.message_id,
            state: result.value.state.clone(),
            responded_by: my_user_id,
            responded_at: now,
        })),
    );
    Ok(result.value.state)
}

fn abort_response(args: &Args, state: &mut RuntimeState) {
    let my_user_id: UserId = state.env.canister_id().into();
    let now = state.env.now();
    if let Some(chat) = state.data.direct_chats.get_mut(&args.user_id.into()) {
        let _ = chat.events.abort_action_card_confirm(
            args.thread_root_message_index,
            args.message_id,
            EventIndex::default(),
            my_user_id,
            now,
        );
    }
}
#[cfg(test)]
mod tests {
    use super::resolve_confirm_payload;
    use serde_bytes::ByteBuf;

    // The frozen payload posted at propose time — the fallback whenever the override is absent/invalid.
    fn stored() -> ByteBuf {
        ByteBuf::from(b"STORED".to_vec())
    }

    #[test]
    fn none_override_keeps_stored() {
        assert_eq!(resolve_confirm_payload(&None, &None, stored()).unwrap(), stored());
    }

    #[test]
    fn empty_override_is_rejected() {
        // len 0 is outside 1..=MAX — a member must not be able to blank the payload to empty bytes.
        assert!(resolve_confirm_payload(&Some(ByteBuf::new()), &None, stored()).is_err());
    }

    #[test]
    fn different_override_is_rejected() {
        let edited = ByteBuf::from(b"EDITED".to_vec());
        assert!(resolve_confirm_payload(&Some(edited), &Some(ByteBuf::from(vec![7; 32])), stored()).is_err());
    }

    #[test]
    fn byte_identical_override_is_rejected_without_a_one_time_grant() {
        // The 16_384-byte bound is INCLUSIVE — exactly MAX is deposited.
        assert!(resolve_confirm_payload(&Some(stored()), &Some(ByteBuf::from(vec![7; 32])), stored()).is_err());
    }

    #[test]
    fn oversized_override_is_rejected() {
        // One byte over MAX (16_385) is rejected — the cap limits how much a member can deposit.
        let edited = ByteBuf::from(vec![b'x'; 16_385]);
        assert!(resolve_confirm_payload(&Some(edited), &Some(ByteBuf::from(vec![7; 32])), stored()).is_err());
    }
}
