#[cfg(test)]
use crate::model::action_delivery_outbox::ACTION_DELIVERY_LEASE_MS;
use crate::model::action_delivery_outbox::{ActionDeliveryDispatch, ActionDeliveryRemoteResult};
use crate::{RuntimeState, mutate_state, read_state};
use action_inbox_canister::c2c_notify_actions;
use ic_cdk_timers::TimerId;
use oc_error_codes::OCErrorCode;
use std::cell::Cell;
use std::time::Duration;

const ACTION_INBOX_CALL_TIMEOUT_SECONDS: u32 = 10;
const ACTION_INBOX_METHOD: &str = "c2c_notify_actions_msgpack";

thread_local! {
    static TIMER_ID: Cell<Option<TimerId>> = Cell::default();
    static TIMER_DUE_AT: Cell<u64> = Cell::default();
}

pub(crate) fn start_job_if_required(state: &RuntimeState) -> bool {
    let Some(due_at) = state.data.action_delivery_outbox.next_retry_at() else {
        return false;
    };
    let existing_due = TIMER_DUE_AT.get();
    if let Some(timer_id) = TIMER_ID.get() {
        if existing_timer_is_soon_enough(existing_due, due_at) {
            return false;
        }
        ic_cdk_timers::clear_timer(timer_id);
        TIMER_ID.set(None);
    }

    let delay = due_at.saturating_sub(state.env.now());
    let timer_id = ic_cdk_timers::set_timer(Duration::from_millis(delay), async { run() });
    TIMER_ID.set(Some(timer_id));
    TIMER_DUE_AT.set(due_at);
    true
}

fn existing_timer_is_soon_enough(existing_due: u64, required_due: u64) -> bool {
    existing_due != 0 && existing_due <= required_due
}

fn run() {
    TIMER_ID.set(None);
    TIMER_DUE_AT.set(0);
    let dispatch = mutate_state(|state| {
        let now = state.env.now();
        state.data.action_delivery_outbox.begin_due_retry(now)
    });
    if let Some(dispatch) = dispatch {
        ic_cdk::futures::spawn_migratory(deliver_and_record(dispatch));
    } else {
        read_state(start_job_if_required);
    }
}

async fn deliver_and_record(dispatch: ActionDeliveryDispatch) {
    let result = deliver_exact(&dispatch).await;
    mutate_state(|state| {
        let now = state.env.now();
        let _ = state
            .data
            .action_delivery_outbox
            .complete(dispatch.attempt_id, dispatch.epoch, result, now);
        start_job_if_required(state);
    });
}

/// Sends the exact persisted MessagePack bytes to the exact persisted destination. This deliberately
/// bypasses the typed client serializer so retries cannot pick up a changed route, key, ciphertext,
/// signature, or field encoding. It also emits no identifiers or remote text to shared logs.
pub(crate) async fn deliver_exact(dispatch: &ActionDeliveryDispatch) -> ActionDeliveryRemoteResult {
    let call = ic_cdk::call::Call::bounded_wait(dispatch.destination, ACTION_INBOX_METHOD)
        .change_timeout(ACTION_INBOX_CALL_TIMEOUT_SECONDS)
        .with_raw_args(&dispatch.request)
        .await;
    let Ok(response) = call else {
        return ActionDeliveryRemoteResult::OutcomeUnknown;
    };
    let bytes = response.into_bytes();
    match msgpack::deserialize::<c2c_notify_actions::Response, _>(bytes.as_slice()) {
        Ok(response) => classify_action_inbox_response(response),
        Err(_) => ActionDeliveryRemoteResult::OutcomeUnknown,
    }
}

fn classify_action_inbox_response(response: c2c_notify_actions::Response) -> ActionDeliveryRemoteResult {
    match response {
        c2c_notify_actions::Response::Success => ActionDeliveryRemoteResult::Delivered,
        c2c_notify_actions::Response::Error(error) if error.matches_code(OCErrorCode::InvalidRequest) => {
            ActionDeliveryRemoteResult::Rejected
        }
        // Capacity/migration throttles and any unknown/internal error are definite non-successes but
        // not permanent semantic rejections. Preserve the exact request and retry it unchanged.
        c2c_notify_actions::Response::Error(_) => ActionDeliveryRemoteResult::OutcomeUnknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_lease_is_strictly_longer_than_the_bounded_network_call() {
        assert!(ACTION_DELIVERY_LEASE_MS > u64::from(ACTION_INBOX_CALL_TIMEOUT_SECONDS) * 1_000);
    }

    #[test]
    fn existing_timer_and_due_at_are_sufficient_within_one_wasm_instance() {
        assert!(existing_timer_is_soon_enough(100, 100));
        assert!(existing_timer_is_soon_enough(100, 101));
        assert!(!existing_timer_is_soon_enough(101, 100));
        assert!(!existing_timer_is_soon_enough(0, 100));
    }

    #[test]
    fn only_deterministic_semantic_rejection_is_terminal() {
        assert_eq!(
            classify_action_inbox_response(c2c_notify_actions::Response::Success),
            ActionDeliveryRemoteResult::Delivered
        );
        assert_eq!(
            classify_action_inbox_response(c2c_notify_actions::Response::Error(
                OCErrorCode::InvalidRequest.with_message("deterministic conflict")
            )),
            ActionDeliveryRemoteResult::Rejected
        );
        for code in [OCErrorCode::Throttled, OCErrorCode::C2CError, OCErrorCode::Unknown] {
            assert_eq!(
                classify_action_inbox_response(c2c_notify_actions::Response::Error(
                    code.with_message("must remain retryable")
                )),
                ActionDeliveryRemoteResult::OutcomeUnknown
            );
        }
    }
}
