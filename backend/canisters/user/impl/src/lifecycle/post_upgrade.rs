use crate::Data;
use crate::lifecycle::init_state;
use crate::memory::{get_stable_memory_map_memory, get_upgrades_memory};
use canister_api_macros::post_upgrade;
use canister_logger::LogEntry;
use canister_tracing_macros::trace;
use stable_memory::get_reader;
use tracing::info;
use user_canister::post_upgrade::Args;
use utils::env::canister::CanisterEnv;

const PR2_SENSITIVE_HISTORY_MARKERS: &[&str] = &[
    "respond_to_action_card",
    "create_ai_app_card_capability",
    "create_ai_app_card_confirmation_grant",
    "create_ai_app_chat_link_token",
    "c2c_user_canister",
    "edit_message",
];

#[post_upgrade(msgpack = true)]
#[trace]
fn post_upgrade(args: Args) {
    stable_memory_map::init(get_stable_memory_map_memory());

    let memory = get_upgrades_memory();
    let reader = get_reader(&memory);

    let (data, mut errors, mut logs, mut traces): (Data, Vec<LogEntry>, Vec<LogEntry>, Vec<LogEntry>) =
        msgpack::deserialize(reader).unwrap();
    let purged_pr2_history =
        canister_logger::purge_history_containing(&mut errors, &mut logs, &mut traces, PR2_SENSITIVE_HISTORY_MARKERS);

    canister_logger::init_with_logs(data.test_mode, errors, logs, traces);

    let env = Box::new(CanisterEnv::new(data.rng_seed));
    init_state(env, data, args.wasm_version);

    let total_instructions = ic_cdk::api::call_context_instruction_counter();
    info!(version = %args.wasm_version, total_instructions, purged_pr2_history, "Post-upgrade complete");
}
