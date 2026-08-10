use crate::Data;
use crate::lifecycle::{init_env, init_state};
use crate::memory::{get_stable_memory_map_memory, get_upgrades_memory};
use canister_logger::LogEntry;
use canister_tracing_macros::trace;
use ic_cdk::post_upgrade;
use local_user_index_canister::post_upgrade::Args;
use stable_memory::get_reader;
use tracing::info;
use utils::cycles::init_cycles_dispenser_client;

const PR2_SENSITIVE_HISTORY_MARKERS: &[&str] = &[
    "c2c_deposit_action_confirmed",
    "c2c_validate_ai_app_card_provenance",
    "c2c_create_ai_app_card_capability",
    "c2c_create_ai_app_private_match_capability",
    "c2c_create_ai_app_chat_link_token",
    "c2c_cancel_ai_app_chat_link_token",
    "c2c_create_ai_app_card_confirmation_grant",
    "c2c_consume_ai_app_card_confirmation_grant",
];

#[post_upgrade]
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

    let env = init_env(data.rng_seed);
    init_cycles_dispenser_client(data.cycles_dispenser_canister_id, data.test_mode);
    init_state(env, data, args.wasm_version);
    crate::pr2_entropy::start_after_lifecycle();

    let total_instructions = ic_cdk::api::call_context_instruction_counter();
    info!(version = %args.wasm_version, total_instructions, purged_pr2_history, "Post-upgrade complete");
}
