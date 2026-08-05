use crate::{RuntimeState, mutate_state, read_state};
use ic_cdk_timers::TimerId;
use std::cell::Cell;
use std::time::Duration;

const MIGRATION_STEP_INTERVAL: Duration = Duration::from_secs(1);

thread_local! {
    static MIGRATION_TIMER_ID: Cell<Option<TimerId>> = Cell::default();
}

pub(crate) fn start(state: &RuntimeState) {
    ic_cdk_timers::set_timer_interval(Duration::from_secs(60 * 60), || {
        mutate_state(|state| {
            let now = state.env.now();
            state.data.inbox.prune(now);
        });
    });
    start_migration_job_if_required(state, Duration::ZERO);
}

fn start_migration_job_if_required(state: &RuntimeState, delay: Duration) -> bool {
    if MIGRATION_TIMER_ID.get().is_none() && state.data.inbox.migration_in_progress() {
        let timer_id = ic_cdk_timers::set_timer(delay, run_migration_step);
        MIGRATION_TIMER_ID.set(Some(timer_id));
        true
    } else {
        false
    }
}

fn run_migration_step() {
    MIGRATION_TIMER_ID.set(None);
    let more = mutate_state(advance_migration);
    if more {
        read_state(|state| start_migration_job_if_required(state, MIGRATION_STEP_INTERVAL));
    }
}

fn advance_migration(state: &mut RuntimeState) -> bool {
    let now = state.env.now();
    state.data.inbox.run_migration_step(now);
    state.data.inbox.migration_in_progress()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Data;
    use utils::env::test::TestEnv;

    fn state() -> RuntimeState {
        let env = TestEnv::default();
        let canister_id = env.canister_id;
        RuntimeState::new(
            Box::new(env),
            Data::new(7, canister_id, canister_id, Vec::new(), Vec::new(), true),
        )
    }

    #[test]
    fn migration_callback_only_reschedules_while_bounded_work_remains() {
        let mut complete = state();
        assert!(!advance_migration(&mut complete));

        let mut incomplete = state();
        incomplete.data.inbox.force_incomplete_migration_for_test();
        assert!(advance_migration(&mut incomplete));
        assert_eq!(incomplete.data.inbox.migration_steps(), 1);
        assert_eq!(incomplete.data.inbox.migration_last_step_items(), 0);
        assert!(incomplete.data.inbox.migration_last_step_saturated());
    }
}
