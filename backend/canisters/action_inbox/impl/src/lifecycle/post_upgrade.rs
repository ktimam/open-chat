use crate::lifecycle::stable_state;
use crate::lifecycle::{init_env, init_state};
use crate::memory::get_upgrades_memory;
use action_inbox_canister::post_upgrade::Args;
use canister_tracing_macros::trace;
use ic_cdk::post_upgrade;
use stable_memory::get_reader;
use tracing::info;
use utils::cycles::init_cycles_dispenser_client;

#[post_upgrade]
#[trace]
fn post_upgrade(args: Args) {
    let memory = get_upgrades_memory();
    let reader = get_reader(&memory);

    let stable_state::RestoredStableState {
        mut data,
        errors,
        logs,
        purged_trace_count,
    } = stable_state::read(reader);

    canister_logger::init_with_logs(data.test_mode, errors, logs, Vec::new());

    let env = init_env(data.rng_seed);
    data.inbox
        .prepare_after_upgrade()
        .expect("ActionInbox post-upgrade compatibility check failed");
    init_cycles_dispenser_client(data.cycles_dispenser_canister_id, data.test_mode);
    init_state(env, data, args.wasm_version);

    info!(version = %args.wasm_version, purged_trace_count, "Post-upgrade complete");
}
