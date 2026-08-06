use crate::{RuntimeState, mutate_state, read_state};
use ic_cdk_timers::TimerId;
use rand::rngs::StdRng;
use std::cell::Cell;
use std::time::Duration;
use types::{
    PR2_ENTROPY_RESEED_WATCHDOG_MS, Pr2EntropyCommitmentMode, Pr2EntropyReseedAdmission, Pr2EntropyReseedTicket,
    Pr2EntropyReseedWatchdog,
};

const ACTION_SIGNING_KEY_INIT_PURPOSE: &[u8] = b"user-index/action-signing-key-init/v1";
const SCOPED_IDENTITY_KEY_INIT_PURPOSE: &[u8] = b"user-index/scoped-identity-key-init/v1";

#[cfg(test)]
pub(crate) const TEST_CANISTER_VERSION: u64 = 1;

thread_local! {
    static TIMER_ID: Cell<Option<TimerId>> = Cell::default();
    static TIMER_CANISTER_VERSION: Cell<Option<u64>> = Cell::default();
}

#[cfg(not(test))]
pub(crate) fn current_canister_version() -> u64 {
    ic_cdk::api::canister_version()
}

#[cfg(test)]
pub(crate) fn current_canister_version() -> u64 {
    TEST_CANISTER_VERSION
}

/// Installs the current bearer epoch synchronously, then schedules one PR2-only raw_rand reseed.
/// Long-lived app/key configuration and the durable delivery outbox are never modified here.
pub(crate) fn start_after_lifecycle() {
    let canister_version = current_canister_version();
    mutate_state(|state| ensure_current_bearer_epoch_for_version(state, canister_version));
    schedule(Duration::ZERO);
}

pub(crate) fn ensure_current_bearer_epoch(state: &mut RuntimeState) -> u64 {
    let canister_version = current_canister_version();
    if ensure_current_bearer_epoch_for_version(state, canister_version) {
        // Snapshot restoration does not run a lifecycle hook in every test or recovery harness.
        // Detecting a new epoch on demand must therefore also arrange the fresh raw_rand reseed.
        schedule(Duration::ZERO);
    }
    canister_version
}

pub(crate) fn ensure_current_bearer_epoch_for_version(state: &mut RuntimeState, canister_version: u64) -> bool {
    let entropy_epoch_changed = state.data.pr2_entropy.ensure_canister_version(canister_version);
    let bearer_epoch_changed = state.data.pr2_bearer_canister_version != Some(canister_version);
    if state.data.pr2_bearer_canister_version != Some(canister_version) {
        state.data.ai_app_link_codes.invalidate_all();
        state.data.ai_app_card_tokens.invalidate_all_bearers();
        state.data.pr2_bearer_canister_version = Some(canister_version);
    }
    entropy_epoch_changed || bearer_epoch_changed
}

pub(crate) fn is_ready(state: &mut RuntimeState) -> bool {
    let canister_version = ensure_current_bearer_epoch(state);
    state.data.pr2_entropy.is_ready(canister_version)
}

pub(crate) fn output_rng(state: &mut RuntimeState, purpose: &[u8]) -> Result<StdRng, &'static str> {
    let canister_version = ensure_current_bearer_epoch(state);
    state.data.pr2_entropy.output_rng(canister_version, purpose)
}

fn schedule(delay: Duration) {
    let canister_version = current_canister_version();
    if TIMER_CANISTER_VERSION.get() != Some(canister_version) {
        if let Some(timer_id) = TIMER_ID.take() {
            ic_cdk_timers::clear_timer(timer_id);
        }
        TIMER_CANISTER_VERSION.set(Some(canister_version));
    }
    if TIMER_ID.get().is_some() {
        return;
    }
    TIMER_ID.set(Some(ic_cdk_timers::set_timer(delay, async { attempt_reseed() })));
}

fn attempt_reseed() {
    TIMER_ID.set(None);
    let canister_version = current_canister_version();
    TIMER_CANISTER_VERSION.set(Some(canister_version));
    let now = canister_time::now_millis();
    let admission = mutate_state(|state| {
        ensure_current_bearer_epoch_for_version(state, canister_version);
        state.data.pr2_entropy.begin_reseed(canister_version, now)
    });
    match admission {
        Pr2EntropyReseedAdmission::Ready => {}
        Pr2EntropyReseedAdmission::InProgress {
            ticket,
            watchdog_delay_ms,
        } => schedule_watchdog(ticket, watchdog_delay_ms),
        Pr2EntropyReseedAdmission::RetryAfter(delay_ms) => schedule(Duration::from_millis(delay_ms)),
        Pr2EntropyReseedAdmission::Started(ticket) => {
            schedule_watchdog(ticket, PR2_ENTROPY_RESEED_WATCHDOG_MS);
            ic_cdk::futures::spawn(finish_reseed(ticket));
        }
    }
}

fn schedule_watchdog(ticket: Pr2EntropyReseedTicket, delay_ms: u64) {
    let _ = ic_cdk_timers::set_timer(Duration::from_millis(delay_ms), async move {
        check_watchdog(ticket);
    });
}

fn check_watchdog(ticket: Pr2EntropyReseedTicket) {
    let current_version = current_canister_version();
    let now = canister_time::now_millis();
    let outcome = mutate_state(|state| {
        ensure_current_bearer_epoch_for_version(state, current_version);
        state.data.pr2_entropy.check_reseed_watchdog(ticket, current_version, now)
    });
    match outcome {
        Pr2EntropyReseedWatchdog::Stale => {}
        Pr2EntropyReseedWatchdog::Pending(delay_ms) => schedule_watchdog(ticket, delay_ms),
        Pr2EntropyReseedWatchdog::Expired => schedule(Duration::ZERO),
    }
}

async fn finish_reseed(ticket: Pr2EntropyReseedTicket) {
    let test_mode = read_state(|state| state.data.test_mode);
    let raw_rand = utils::canister::request_raw_rand(test_mode).await;
    let current_version = current_canister_version();
    let now = canister_time::now_millis();
    let retry = mutate_state(|state| {
        ensure_current_bearer_epoch_for_version(state, current_version);
        let canister_id = state.env.canister_id();
        let commitment_mode = Pr2EntropyCommitmentMode::from_test_mode(state.data.test_mode);
        match raw_rand {
            Ok(ref bytes) => {
                let was_current = state.data.pr2_entropy.is_active_reseed_ticket(ticket, current_version);
                if !state
                    .data
                    .pr2_entropy
                    .finish_reseed(ticket, current_version, canister_id, commitment_mode, bytes, now)
                {
                    return was_current;
                }
            }
            Err(_) => {
                return state.data.pr2_entropy.fail_reseed(ticket, current_version, now);
            }
        }

        // Existing valid keys are preserved by ensure_initialized. Missing keys are created only
        // from distinct purpose-separated PR2 streams after a fresh current-version reseed.
        let mut signing_rng = match state
            .data
            .pr2_entropy
            .output_rng(current_version, ACTION_SIGNING_KEY_INIT_PURPOSE)
        {
            Ok(rng) => rng,
            Err(_) => return false,
        };
        if state
            .data
            .action_signing_keyring
            .ensure_initialized(&mut signing_rng, now)
            .is_err()
        {
            state.data.pr2_entropy.mark_unavailable(current_version);
            return false;
        }
        let mut scoped_rng = match state
            .data
            .pr2_entropy
            .output_rng(current_version, SCOPED_IDENTITY_KEY_INIT_PURPOSE)
        {
            Ok(rng) => rng,
            Err(_) => return false,
        };
        if state
            .data
            .ai_app_scoped_identity_key
            .ensure_initialized(&mut scoped_rng)
            .is_err()
        {
            state.data.pr2_entropy.mark_unavailable(current_version);
        }
        false
    });
    if retry {
        schedule(Duration::ZERO);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::action_delivery_outbox::ActionDeliveryStart;
    use crate::model::ai_app_card_tokens::{Provenance, ProvenanceStatus, TOKEN_BYTES};
    use crate::{Data, RuntimeState};
    use rand::SeedableRng;
    use rand::rngs::StdRng;
    use types::{AiAppCardContext, Chat, MessageId, UserId};
    use utils::env::test::TestEnv;

    #[test]
    fn restored_epoch_revokes_bearers_but_preserves_long_lived_keys_and_outbox() {
        let env = TestEnv::default();
        let canister_id = env.canister_id;
        let now = env.now;
        let user_id: UserId = env.caller.into();
        let group = candid::Principal::from_slice(&[8]).into();
        let context = AiAppCardContext {
            user_id,
            chat: Chat::Group(group),
            chat_key: format!("group:{group}"),
            thread_root_message_index: None,
            message_id: MessageId::from(1u64),
            app_id: 7,
            app_revision: 11,
            action_id: "generic.action".to_string(),
        };
        let link_code = "ab".repeat(32);
        let provenance = [0xCD; TOKEN_BYTES];
        let mut data = Data::default();
        data.ai_app_link_codes
            .insert_bound(
                link_code.clone(),
                canister_id,
                user_id,
                7,
                11,
                candid::Principal::from_slice(&[9]),
                3,
                now + 1_000,
                now,
            )
            .unwrap();
        data.ai_app_card_tokens
            .insert_provenance(
                canister_id,
                &provenance,
                Provenance {
                    context: context.clone(),
                    content_hash: [4; 32],
                    expires_at: now + 1_000,
                },
                now,
            )
            .unwrap();
        let mut key_rng = StdRng::seed_from_u64(91);
        data.action_signing_keyring.ensure_initialized(&mut key_rng, now).unwrap();
        data.ai_app_scoped_identity_key.ensure_initialized(&mut key_rng).unwrap();
        assert_eq!(
            data.action_delivery_outbox.start([5; 32], 7, 1, now, now),
            Ok(ActionDeliveryStart::Prepare { epoch: 1 })
        );
        let signing_keys_before = msgpack::serialize_to_vec(&data.action_signing_keyring).unwrap();
        let scoped_key_before = msgpack::serialize_to_vec(&data.ai_app_scoped_identity_key).unwrap();
        let outbox_before = msgpack::serialize_to_vec(&data.action_delivery_outbox).unwrap();
        let mut state = RuntimeState::new(Box::new(env), data);

        assert!(ensure_current_bearer_epoch_for_version(&mut state, TEST_CANISTER_VERSION + 1));

        assert!(!state.data.ai_app_link_codes.contains_bound(&link_code, canister_id));
        assert_eq!(
            state
                .data
                .ai_app_card_tokens
                .provenance_status(canister_id, &provenance, &context, &[4; 32], now),
            ProvenanceStatus::NotFound
        );
        assert!(!state.data.pr2_entropy.is_ready(TEST_CANISTER_VERSION + 1));
        assert_eq!(state.data.pr2_bearer_canister_version, Some(TEST_CANISTER_VERSION + 1));
        assert_eq!(
            msgpack::serialize_to_vec(&state.data.action_signing_keyring).unwrap(),
            signing_keys_before
        );
        assert_eq!(
            msgpack::serialize_to_vec(&state.data.ai_app_scoped_identity_key).unwrap(),
            scoped_key_before
        );
        assert_eq!(
            msgpack::serialize_to_vec(&state.data.action_delivery_outbox).unwrap(),
            outbox_before
        );
        assert!(!ensure_current_bearer_epoch_for_version(
            &mut state,
            TEST_CANISTER_VERSION + 1
        ));
    }
}
