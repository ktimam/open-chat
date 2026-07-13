use crate::activity_notifications::handle_activity_notification;
use crate::{RuntimeState, execute_update};
use canister_api_macros::update;
use canister_tracing_macros::trace;
use community_canister::respond_to_action_card::{Response::*, *};
use local_user_index_canister::c2c_deposit_action_confirmed::ActionDepositContext;
use oc_error_codes::OCErrorCode;
use serde_bytes::ByteBuf;
use types::{ActionCardResponse, ActionCardState, CanisterId, Chat, OCResult, TimestampMillis, UserId};

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
            consumer_public_key_pem: deposit.recipient_public_key,
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
    recipient_public_key: String,
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
            return Ok(Prepared::NeedsDeposit {
                user_id,
                deposit: DepositInstruction {
                    local_user_index_canister_id: state.data.local_user_index_canister_id,
                    recipient_public_key: deposit.recipient_public_key,
                    confirm_payload: deposit.confirm_payload,
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
