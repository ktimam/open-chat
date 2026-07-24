use crate::guards::caller_is_owner;
use crate::{RuntimeState, execute_update};
use canister_api_macros::update;
use canister_tracing_macros::trace;
use chat_events::RespondToActionCardArgs;
use local_user_index_canister::c2c_deposit_action_confirmed::ActionDepositContext;
use oc_error_codes::OCErrorCode;
use serde_bytes::ByteBuf;
use types::{ActionCardResponse, ActionCardState, CanisterId, Chat, EventIndex, OCResult, TimestampMillis, UserId};
use user_canister::respond_to_action_card::{Response::*, *};
use user_canister::{ActionCardStatusChange, UserCanisterEvent};

// Upper bound on an app-supplied edited payload (Phase 2 / app-rendered cards). A member can't
// deposit an arbitrary blob; anything larger (or empty) falls back to the stored payload.
const MAX_OVERRIDE_BYTES: usize = 16_384;

// Pick the bytes to deposit: the confirmer's edited `confirm_payload_override` when it is present and
// within `1..=MAX_OVERRIDE_BYTES`, else the frozen stored payload. OpenChat never interprets either.
fn resolve_confirm_payload(override_bytes: &Option<ByteBuf>, stored: ByteBuf) -> ByteBuf {
    match override_bytes {
        Some(bytes) if (1..=MAX_OVERRIDE_BYTES).contains(&bytes.len()) => bytes.clone(),
        _ => stored,
    }
}

// The direct-chat confirm path. Two-phase like the group/community canisters: a confirm that carries
// delivery routing DEPOSITS FIRST and only commits `Confirmed` (and mirrors that onto the other
// participant's copy) once the deposit is stored — so a FAILED deposit leaves the card Pending
// (retryable) and never mirrors a Confirmed-but-undelivered state to the peer. Cancels and
// routing-less confirms commit in a single synchronous pass.
#[update(guard = "caller_is_owner", msgpack = true)]
#[trace]
async fn respond_to_action_card(args: Args) -> Response {
    let deposit = match execute_update(|state| prepare(&args, state)) {
        Ok(Prepared::Committed(state)) => return Success(state),
        Ok(Prepared::NeedsDeposit(deposit)) => deposit,
        Err(error) => return Error(error.into()),
    };

    match local_user_index_canister_c2c_client::c2c_deposit_action_confirmed(
        deposit.local_user_index_canister_id,
        &local_user_index_canister::c2c_deposit_action_confirmed::Args {
            // Fan-out: every recipient key the card carries travels in the plural field; the legacy
            // singular stays empty (local_user_index merges + dedupes the two).
            consumer_public_key_pem: String::new(),
            consumer_public_key_pems: deposit.recipient_public_keys,
            plaintext: deposit.confirm_payload,
            created_at: deposit.created_at,
            inbox_canister_id: deposit.inbox_canister_id,
            context: deposit.context,
        },
    )
    .await
    {
        Ok(local_user_index_canister::c2c_deposit_action_confirmed::Response::Success) => {}
        Ok(response) => {
            return Error(OCErrorCode::C2CError.with_message(format!("action deposit was not stored: {response:?}")));
        }
        Err(error) => {
            return Error(OCErrorCode::C2CError.with_message(format!("action deposit call failed: {error:?}")));
        }
    }

    // Deposit stored — commit the confirm (and mirror it to the peer) now.
    match execute_update(|state| commit_response(&args, state)) {
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
    recipient_public_keys: Vec<String>,
    confirm_payload: ByteBuf,
    created_at: TimestampMillis,
    inbox_canister_id: Option<CanisterId>,
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
        let peeked = chat.events.action_card_confirm_deposit(
            args.thread_root_message_index,
            args.message_id,
            EventIndex::default(),
            my_user_id,
            now,
        );
        // `chat`'s borrow of `state.data.direct_chats` ends here — `peeked` is owned.
        if let Some(deposit) = peeked {
            // The canonical direct-chat key is rendered per participant: each side identifies the chat
            // by the OTHER participant ("direct:<them>"), which is what the responder's deposit carries.
            let chat_identity = Chat::Direct(args.user_id.into());
            // App-rendered cards (Phase 2): if the confirmer's app sent an edited payload within
            // bounds, deposit THOSE bytes instead of the frozen stored payload; otherwise (None /
            // empty / oversized) keep the stored bytes exactly as before. SECURITY: the caller is
            // already the authed owner (caller_is_owner guard); the size bound stops an oversized blob;
            // and the consumer app re-validates the payload against its own schema — so OpenChat stays
            // semantics-blind, depositing opaque bytes exactly as today.
            let confirm_payload = resolve_confirm_payload(&args.confirm_payload_override, deposit.confirm_payload);
            return Ok(Prepared::NeedsDeposit(DepositInstruction {
                local_user_index_canister_id: state.data.local_user_index_canister_id,
                recipient_public_keys: deposit.recipient_public_keys,
                confirm_payload,
                created_at: deposit.responded_at,
                inbox_canister_id: deposit.inbox_canister_id,
                context: ActionDepositContext {
                    chat: chat_identity,
                    message_id: deposit.message_id,
                    confirmed_by: deposit.confirmed_by,
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
#[cfg(test)]
mod tests {
    use super::{resolve_confirm_payload, MAX_OVERRIDE_BYTES};
    use serde_bytes::ByteBuf;

    // The frozen payload posted at propose time — the fallback whenever the override is absent/invalid.
    fn stored() -> ByteBuf {
        ByteBuf::from(b"STORED".to_vec())
    }

    #[test]
    fn none_override_keeps_stored() {
        assert_eq!(resolve_confirm_payload(&None, stored()), stored());
    }

    #[test]
    fn empty_override_keeps_stored() {
        // len 0 is outside 1..=MAX — a member must not be able to blank the payload to empty bytes.
        assert_eq!(resolve_confirm_payload(&Some(ByteBuf::new()), stored()), stored());
    }

    #[test]
    fn in_bounds_override_wins() {
        let edited = ByteBuf::from(b"EDITED".to_vec());
        assert_eq!(resolve_confirm_payload(&Some(edited.clone()), stored()), edited);
    }

    #[test]
    fn max_len_override_accepted() {
        // The 16_384-byte bound is INCLUSIVE — exactly MAX is deposited.
        let edited = ByteBuf::from(vec![b'x'; MAX_OVERRIDE_BYTES]);
        assert_eq!(resolve_confirm_payload(&Some(edited.clone()), stored()), edited);
    }

    #[test]
    fn oversized_override_keeps_stored() {
        // One byte over MAX (16_385) is rejected — the cap limits how much a member can deposit.
        let edited = ByteBuf::from(vec![b'x'; MAX_OVERRIDE_BYTES + 1]);
        assert_eq!(resolve_confirm_payload(&Some(edited), stored()), stored());
    }
}
