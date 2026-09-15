use crate::model::ai_app_user_keys::{APP_CLEANUP_BATCH_SIZE, MIGRATION_BATCH_SIZE};
use crate::{RuntimeState, mutate_state, read_state};
use ic_cdk_timers::TimerId;
use std::cell::Cell;
use std::time::Duration;
use tracing::trace;

thread_local! {
    static TIMER_ID: Cell<Option<TimerId>> = Cell::default();
}

pub(crate) fn start_job_if_required(state: &RuntimeState) -> bool {
    if TIMER_ID.get().is_none() && state.data.ai_app_user_keys.maintenance_required() {
        let timer_id = ic_cdk_timers::set_timer(Duration::ZERO, async { run() });
        TIMER_ID.set(Some(timer_id));
        true
    } else {
        false
    }
}

fn run() {
    trace!("'migrate_ai_app_user_keys' job running");
    TIMER_ID.set(None);
    let more = mutate_state(|state| {
        if state.data.ai_app_user_keys.migration_required() {
            let data = &mut state.data;
            let apps = &data.ai_apps;
            data.ai_app_user_keys.migrate_batch(MIGRATION_BATCH_SIZE, |app_id| {
                apps.get(app_id)
                    .is_some_and(|app| app.published && app.manifest.per_user_keys)
            });
        } else {
            state.data.ai_app_user_keys.process_app_cleanup_batch(APP_CLEANUP_BATCH_SIZE);
        }
        state.data.ai_app_user_keys.maintenance_required()
    });
    if more {
        read_state(start_job_if_required);
    }
}
