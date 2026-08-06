use crate::{RuntimeState, mutate_state};
use ic_cdk_timers::TimerId;
use std::cell::Cell;
use std::time::Duration;
use tracing::trace;

const CLEANUP_INTERVAL: Duration = Duration::from_secs(60);

thread_local! {
    static TIMER_ID: Cell<Option<TimerId>> = Cell::default();
}

pub(crate) fn start_job_if_required(_state: &RuntimeState) -> bool {
    schedule_if_required(CLEANUP_INTERVAL)
}

fn schedule_if_required(delay: Duration) -> bool {
    if TIMER_ID.get().is_some() {
        return false;
    }
    TIMER_ID.set(Some(ic_cdk_timers::set_timer(delay, run)));
    true
}

fn run() {
    trace!("'prune_ai_app_card_tokens' job running");
    TIMER_ID.set(None);
    let more = mutate_state(|state| state.data.ai_app_card_tokens.prune_expired_bounded(state.env.now()));
    schedule_if_required(next_delay(more));
}

fn next_delay(more: bool) -> Duration {
    if more { Duration::ZERO } else { CLEANUP_INTERVAL }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backlog_is_rescheduled_immediately_and_idle_cleanup_is_periodic() {
        assert_eq!(next_delay(true), Duration::ZERO);
        assert_eq!(next_delay(false), CLEANUP_INTERVAL);
    }
}
