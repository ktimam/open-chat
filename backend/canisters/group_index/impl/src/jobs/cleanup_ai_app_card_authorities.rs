use crate::mutate_state;
use constants::MINUTE_IN_MS;
use std::time::Duration;
use utils::canister_timers::run_now_then_interval;

const CLEANUP_INTERVAL: Duration = Duration::from_millis(MINUTE_IN_MS);
const CLEANUP_BATCH: usize = 64;

pub fn start_job() {
    run_now_then_interval(CLEANUP_INTERVAL, run);
}

fn run() {
    let more = mutate_state(|state| {
        state
            .data
            .ai_app_card_authority
            .cleanup_expired_bounded(state.env.now(), CLEANUP_BATCH)
    });
    if more {
        ic_cdk_timers::set_timer(Duration::ZERO, run);
    }
}
