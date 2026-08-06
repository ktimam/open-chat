use crate::{RuntimeState, mutate_state};
use ic_cdk_timers::TimerId;
use rand::rngs::StdRng;
use std::cell::Cell;
use std::time::Duration;
use types::{
    PR2_ENTROPY_RESEED_WATCHDOG_MS, Pr2EntropyCommitmentMode, Pr2EntropyLifecycleId, Pr2EntropyReseedAdmission,
    Pr2EntropyReseedTicket, Pr2EntropyReseedWatchdog,
};

thread_local! {
    static TIMER_ID: Cell<Option<TimerId>> = Cell::default();
}

/// Starts one bounded management-canister reseed attempt after init or post-upgrade. PR2 remains
/// unavailable until the callback is accepted for the exact persisted logical lifecycle.
pub(crate) fn start_after_lifecycle() {
    let version_salt = ic_cdk::api::canister_version();
    match mutate_state(|state| advance_lifecycle(state, version_salt)) {
        Ok(_) => schedule(Duration::ZERO),
        Err(error) => tracing::error!(version_salt, error, "PR2 entropy lifecycle advance failed closed"),
    }
}

pub(crate) fn advance_lifecycle(state: &mut RuntimeState, version_salt: u64) -> Result<Pr2EntropyLifecycleId, &'static str> {
    // Authorities and every secondary index are lifecycle-local. Clear them even if generation
    // overflow makes the new entropy lifecycle terminally unavailable.
    state.data.ai_app_card_authority.invalidate_all();
    state.data.pr2_entropy.advance_lifecycle(version_salt)
}

pub(crate) fn output_rng(state: &mut RuntimeState, purpose: &[u8]) -> Result<StdRng, &'static str> {
    let canister_id = state.env.canister_id();
    state.data.pr2_entropy.output_rng(canister_id, purpose)
}

fn schedule(delay: Duration) {
    if TIMER_ID.get().is_some() {
        return;
    }
    TIMER_ID.set(Some(ic_cdk_timers::set_timer(delay, async { attempt_reseed() })));
}

fn attempt_reseed() {
    TIMER_ID.set(None);
    let now = canister_time::now_millis();
    let admission = mutate_state(|state| state.data.pr2_entropy.begin_reseed(now));
    match admission {
        Pr2EntropyReseedAdmission::Unavailable | Pr2EntropyReseedAdmission::Ready => {}
        Pr2EntropyReseedAdmission::InProgress {
            ticket,
            watchdog_delay_ms,
        } => schedule_watchdog(ticket, watchdog_delay_ms),
        Pr2EntropyReseedAdmission::RetryAfter(delay_ms) => schedule(Duration::from_millis(delay_ms)),
        Pr2EntropyReseedAdmission::Started(ticket) => {
            schedule_watchdog(ticket, PR2_ENTROPY_RESEED_WATCHDOG_MS);
            ic_cdk::futures::spawn_migratory(finish_reseed(ticket));
        }
    }
}

fn schedule_watchdog(ticket: Pr2EntropyReseedTicket, delay_ms: u64) {
    let _ = ic_cdk_timers::set_timer(Duration::from_millis(delay_ms), async move {
        check_watchdog(ticket);
    });
}

fn check_watchdog(ticket: Pr2EntropyReseedTicket) {
    let now = canister_time::now_millis();
    let outcome = mutate_state(|state| state.data.pr2_entropy.check_reseed_watchdog(ticket, now));
    match outcome {
        Pr2EntropyReseedWatchdog::Stale => {}
        Pr2EntropyReseedWatchdog::Pending(delay_ms) => schedule_watchdog(ticket, delay_ms),
        Pr2EntropyReseedWatchdog::Expired => schedule(Duration::ZERO),
    }
}

async fn finish_reseed(ticket: Pr2EntropyReseedTicket) {
    let raw_rand = ic_cdk_management_canister::raw_rand().await;
    let now = canister_time::now_millis();
    let retry = mutate_state(|state| {
        let commitment_mode = Pr2EntropyCommitmentMode::from_test_mode(state.data.test_mode);
        match raw_rand {
            Ok(ref bytes) => {
                let was_current = state.data.pr2_entropy.is_active_reseed_ticket(ticket);
                was_current
                    && !state
                        .data
                        .pr2_entropy
                        .finish_reseed(ticket, state.env.canister_id(), commitment_mode, bytes, now)
            }
            Err(_) => state.data.pr2_entropy.fail_reseed(ticket, now),
        }
    });
    if retry {
        // Re-enter through begin_reseed, which applies the persisted bounded retry delay.
        schedule(Duration::ZERO);
    }
}
