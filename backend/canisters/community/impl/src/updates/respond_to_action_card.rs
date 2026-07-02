use crate::activity_notifications::handle_activity_notification;
use crate::{RuntimeState, execute_update};
use canister_api_macros::update;
use canister_tracing_macros::trace;
use community_canister::respond_to_action_card::{Response::*, *};
use local_user_index_canister::c2c_deposit_action_confirmed::ActionDepositContext;
use serde_bytes::ByteBuf;
use types::{ActionCardState, CanisterId, Chat, OCResult, TimestampMillis};

#[update(msgpack = true)]
#[trace]
async fn respond_to_action_card(args: Args) -> Response {
    let result = match execute_update(|state| respond_to_action_card_impl(args, state)) {
        Ok(result) => result,
        Err(error) => return Error(error),
    };

    if let Some(deposit) = result.deposit {
        // Forward the confirmed action to local_user_index, which wraps it with the confirmation context,
        // encrypts it to the recipient, signs it, and deposits it into the action_inbox. The card state is
        // already committed; this is a downstream effect.
        let _ = local_user_index_canister_c2c_client::c2c_deposit_action_confirmed(
            deposit.local_user_index_canister_id,
            &local_user_index_canister::c2c_deposit_action_confirmed::Args {
                consumer_public_key_pem: deposit.recipient_public_key,
                plaintext: deposit.confirm_payload,
                created_at: deposit.created_at,
                context: deposit.context,
            },
        )
        .await;
    }

    Success(result.state)
}

struct RespondResult {
    state: ActionCardState,
    deposit: Option<DepositInstruction>,
}

struct DepositInstruction {
    local_user_index_canister_id: CanisterId,
    recipient_public_key: String,
    confirm_payload: ByteBuf,
    created_at: TimestampMillis,
    context: ActionDepositContext,
}

fn respond_to_action_card_impl(args: Args, state: &mut RuntimeState) -> OCResult<RespondResult> {
    state.data.verify_not_frozen()?;

    let member = state.get_calling_member(true)?;
    let channel = state.data.channels.get_mut_or_err(&args.channel_id)?;
    let user_id = member.user_id;
    let now = state.env.now();

    let result =
        channel
            .chat
            .respond_to_action_card(user_id, args.thread_root_message_index, args.message_id, args.response, now)?;

    state.push_bot_notification(result.bot_notification);
    handle_activity_notification(state);

    let local_user_index_canister_id = state.data.local_user_index_canister_id;
    // This canister IS the community, so it supplies the chat identity for the deposit context itself.
    let chat = Chat::Channel(state.env.canister_id().into(), args.channel_id);
    let deposit = result.value.deposit.map(|d| DepositInstruction {
        local_user_index_canister_id,
        recipient_public_key: d.recipient_public_key,
        confirm_payload: d.confirm_payload,
        created_at: d.responded_at,
        context: ActionDepositContext {
            chat,
            message_id: d.message_id,
            confirmed_by: d.confirmed_by,
        },
    });

    Ok(RespondResult {
        state: result.value.state,
        deposit,
    })
}
