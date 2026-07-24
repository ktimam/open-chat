use crate::activity_notifications::handle_activity_notification;
use crate::{RuntimeState, execute_update};
use canister_api_macros::update;
use canister_tracing_macros::trace;
use community_canister::respond_to_action_card::{Response::*, *};
use local_user_index_canister::c2c_deposit_action_confirmed::ActionDepositContext;
use oc_error_codes::OCErrorCode;
use serde_bytes::ByteBuf;
use types::{ActionCardResponse, ActionCardState, CanisterId, Chat, OCResult, TimestampMillis, UserId};

// Upper bound on an app-supplied edited payload (Phase 2 / app-rendered cards). A member can't
// deposit an arbitrary blob; anything larger (or empty) falls back to the stored payload.
const MAX_OVERRIDE_BYTES: usize = 16_384;

// Pick the bytes to deposit: the confirmer's edited `confirm_payload_override` when it is present and
// within `1..=MAX_OVERRIDE_BYTES`, else the frozen stored payload. OpenChat never interprets either.
fn resolve_confirm_payload(args: &Args, stored: ByteBuf) -> ByteBuf {
    match &args.confirm_payload_override {
        Some(bytes) if (1..=MAX_OVERRIDE_BYTES).contains(&bytes.len()) => bytes.clone(),
        _ => stored,
    }
}

// Two-phase confirm: a confirm that carries delivery routing DEPOSITS FIRST and only commits
// `Confirmed` once the deposit is stored — so a FAILED deposit leaves the card Pending (the user can
// retry) rather than a Confirmed-but-undelivered card that silently reached no inbox. Cancels and
// routing-less confirms commit in a single synchronous pass (there is nothing to deposit).
#[update(msgpack = true)]
#[trace]
async fn respond_to_action_card(args: Args) -> Response {
    // `user_id` is captured in `prepare` BEFORE the await: after the inter-canister deposit call the
    // caller (`msg_caller`) is the local_user_index canister, not the user, so the commit must reuse
    // the resolved id rather than re-read the caller.
    let (user_id, deposit) = match execute_update(|state| prepare(&args, state)) {
        Ok(Prepared::Committed(state)) => return Success(state),
        Ok(Prepared::NeedsDeposit { user_id, deposit }) => (user_id, deposit),
        Err(error) => return Error(error),
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

    // Deposit stored — commit the confirm now (using the pre-await `user_id`).
    match execute_update(|state| commit_response(&args, user_id, state)) {
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
    recipient_public_keys: Vec<String>,
    confirm_payload: ByteBuf,
    created_at: TimestampMillis,
    inbox_canister_id: Option<CanisterId>,
    context: ActionDepositContext,
}

fn prepare(args: &Args, state: &mut RuntimeState) -> OCResult<Prepared> {
    state.data.verify_not_frozen()?;
    let user_id = state.get_calling_member(true)?.user_id;
    let now = state.env.now();

    // Confirm of a Pending, routing-bearing card: peek the deposit (no state change) and defer the
    // commit until the deposit lands.
    if matches!(args.response, ActionCardResponse::Confirm) {
        let channel = state.data.channels.get_mut_or_err(&args.channel_id)?;
        let peeked =
            channel
                .chat
                .action_card_confirm_deposit(user_id, args.thread_root_message_index, args.message_id, now);
        // `channel`'s borrow of `state.data.channels` ends here — `peeked` is owned.
        if let Some(deposit) = peeked {
            // This canister IS the community, so it supplies the chat identity for the deposit context.
            let chat = Chat::Channel(state.env.canister_id().into(), args.channel_id);
            // App-rendered cards (Phase 2): if the confirmer's app sent an edited payload within
            // bounds, deposit THOSE bytes instead of the frozen stored payload; otherwise (None /
            // empty / oversized) keep the stored bytes exactly as before. SECURITY: the caller is
            // already the authed confirmer (a chat member); the size bound stops an oversized blob;
            // and the consumer app re-validates the payload against its own schema — so OpenChat stays
            // semantics-blind, depositing opaque bytes exactly as today.
            let confirm_payload = resolve_confirm_payload(args, deposit.confirm_payload);
            return Ok(Prepared::NeedsDeposit {
                user_id,
                deposit: DepositInstruction {
                    local_user_index_canister_id: state.data.local_user_index_canister_id,
                    recipient_public_keys: deposit.recipient_public_keys,
                    confirm_payload,
                    created_at: deposit.responded_at,
                    inbox_canister_id: deposit.inbox_canister_id,
                    context: ActionDepositContext {
                        chat,
                        message_id: deposit.message_id,
                        confirmed_by: deposit.confirmed_by,
                    },
                },
            });
        }
    }

    // Cancel, or a confirm with nothing to deposit — commit synchronously.
    commit_response(args, user_id, state).map(Prepared::Committed)
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
