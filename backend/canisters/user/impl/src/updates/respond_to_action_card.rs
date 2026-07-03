use crate::guards::caller_is_owner;
use crate::{RuntimeState, execute_update};
use canister_api_macros::update;
use canister_tracing_macros::trace;
use chat_events::RespondToActionCardArgs;
use local_user_index_canister::c2c_deposit_action_confirmed::ActionDepositContext;
use oc_error_codes::OCErrorCode;
use serde_bytes::ByteBuf;
use types::{ActionCardState, CanisterId, Chat, EventIndex, OCResult, TimestampMillis, UserId};
use user_canister::respond_to_action_card::{Response::*, *};
use user_canister::{ActionCardStatusChange, UserCanisterEvent};

// The direct-chat confirm path. The responder's OWN canister runs the state transition and emits
// the deposit (mirroring the group/community canisters), then syncs the outcome onto the other
// participant's copy via ActionCardStatusChange (apply-only there — one deposit per response).
#[update(guard = "caller_is_owner", msgpack = true)]
#[trace]
async fn respond_to_action_card(args: Args) -> Response {
    let result = match execute_update(|state| respond_to_action_card_impl(args, state)) {
        Ok(result) => result,
        Err(error) => return Error(error.into()),
    };

    if let Some(deposit) = result.deposit {
        // Forward the confirmed action to local_user_index (wraps, encrypts, signs, deposits).
        // The card state is already committed; this is a downstream effect.
        let _ = local_user_index_canister_c2c_client::c2c_deposit_action_confirmed(
            deposit.local_user_index_canister_id,
            &local_user_index_canister::c2c_deposit_action_confirmed::Args {
                consumer_public_key_pem: deposit.recipient_public_key,
                plaintext: deposit.confirm_payload,
                created_at: deposit.created_at,
                inbox_canister_id: deposit.inbox_canister_id,
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
    inbox_canister_id: Option<CanisterId>,
    context: ActionDepositContext,
}

fn respond_to_action_card_impl(args: Args, state: &mut RuntimeState) -> OCResult<RespondResult> {
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

    // Mirror the outcome onto the other participant's copy (apply-only there).
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

    let local_user_index_canister_id = state.data.local_user_index_canister_id;
    // The canonical direct-chat key is rendered per participant: each side identifies the chat by
    // the OTHER participant ("direct:<them>"), which is what the responder's deposit carries.
    let chat_identity = Chat::Direct(args.user_id.into());
    let deposit = result.value.deposit.map(|d| DepositInstruction {
        local_user_index_canister_id,
        recipient_public_key: d.recipient_public_key,
        confirm_payload: d.confirm_payload,
        created_at: d.responded_at,
        inbox_canister_id: d.inbox_canister_id,
        context: ActionDepositContext {
            chat: chat_identity,
            message_id: d.message_id,
            confirmed_by: d.confirmed_by,
        },
    });

    Ok(RespondResult {
        state: result.value.state,
        deposit,
    })
}
