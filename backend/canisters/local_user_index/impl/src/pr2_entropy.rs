use crate::{RuntimeState, mutate_state};
use ic_cdk_timers::TimerId;
use rand::rngs::StdRng;
use std::cell::Cell;
use std::time::Duration;
use types::{Pr2EntropyReseedAdmission, Pr2EntropyReseedTicket};

thread_local! {
    static TIMER_ID: Cell<Option<TimerId>> = Cell::default();
    static TIMER_CANISTER_VERSION: Cell<Option<u64>> = Cell::default();
}

/// Reseeds only the PR2 envelope stream. The established LocalUserIndex RNG remains untouched.
pub(crate) fn start_after_lifecycle() {
    let canister_version = ic_cdk::api::canister_version();
    mutate_state(|state| ensure_current_version(state, canister_version));
    schedule(Duration::ZERO);
}

pub(crate) fn ensure_current_version(state: &mut RuntimeState, canister_version: u64) {
    let changed = state.data.pr2_entropy.ensure_canister_version(canister_version);
    #[cfg(target_arch = "wasm32")]
    if changed {
        schedule(Duration::ZERO);
    }
    #[cfg(not(target_arch = "wasm32"))]
    let _ = changed;
}

pub(crate) fn output_rng(state: &mut RuntimeState, canister_version: u64, purpose: &[u8]) -> Result<StdRng, &'static str> {
    ensure_current_version(state, canister_version);
    state.data.pr2_entropy.output_rng(canister_version, purpose)
}

fn schedule(delay: Duration) {
    let canister_version = ic_cdk::api::canister_version();
    if TIMER_CANISTER_VERSION.get() != Some(canister_version) {
        if let Some(timer_id) = TIMER_ID.take() {
            ic_cdk_timers::clear_timer(timer_id);
        }
        TIMER_CANISTER_VERSION.set(Some(canister_version));
    }
    if TIMER_ID.get().is_some() {
        return;
    }
    TIMER_ID.set(Some(ic_cdk_timers::set_timer(delay, attempt_reseed)));
}

fn attempt_reseed() {
    TIMER_ID.set(None);
    let canister_version = ic_cdk::api::canister_version();
    TIMER_CANISTER_VERSION.set(Some(canister_version));
    let now = canister_time::now_millis();
    let admission = mutate_state(|state| {
        ensure_current_version(state, canister_version);
        state.data.pr2_entropy.begin_reseed(canister_version, now)
    });
    match admission {
        Pr2EntropyReseedAdmission::Ready | Pr2EntropyReseedAdmission::InProgress => {}
        Pr2EntropyReseedAdmission::RetryAfter(delay_ms) => schedule(Duration::from_millis(delay_ms)),
        Pr2EntropyReseedAdmission::Started(ticket) => {
            ic_cdk::futures::spawn(finish_reseed(ticket));
        }
    }
}

async fn finish_reseed(ticket: Pr2EntropyReseedTicket) {
    let raw_rand = ic_cdk::management_canister::raw_rand().await;
    let current_version = ic_cdk::api::canister_version();
    let now = canister_time::now_millis();
    let retry = mutate_state(|state| {
        ensure_current_version(state, current_version);
        let canister_id = state.env.canister_id();
        match raw_rand {
            Ok(ref bytes) => !state
                .data
                .pr2_entropy
                .finish_reseed(ticket, current_version, canister_id, bytes, now),
            Err(_) => {
                state.data.pr2_entropy.fail_reseed(ticket, current_version, now);
                true
            }
        }
    });
    if retry {
        schedule(Duration::ZERO);
    }
}
