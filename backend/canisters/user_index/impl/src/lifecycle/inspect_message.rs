use crate::{RuntimeState, read_state};
use ic_cdk::inspect_message;

#[inspect_message]
fn inspect_message() {
    read_state(accept_if_valid);
}

fn accept_if_valid(state: &RuntimeState) {
    let method_name = ic_cdk::api::msg_method_name().trim_end_matches("_msgpack").to_string();

    let is_valid = match method_name.as_str() {
        "claim_daily_chit"
        | "create_canister"
        | "delete_user"
        | "mark_as_online"
        | "mark_suspected_bot"
        | "pay_for_diamond_membership"
        | "pay_for_premium_item"
        | "register_bot"
        | "set_display_name"
        | "set_hide_online_status"
        | "set_moderation_flags"
        | "set_username"
        | "submit_proof_of_unique_personhood"
        | "update_bot"
        | "update_diamond_membership_subscription" => state.is_caller_openchat_user(),
        // In test_mode a standalone deploy identity must be explicitly configured as governance;
        // user-facing operations still resolve an actual registered OpenChat account in-method.
        "create_ai_app_link_code" | "delete_ai_app" | "register_ai_app" | "set_my_ai_app_key" | "remove_my_ai_app_key" => {
            state.is_caller_openchat_user() || state.data.test_mode
        }
        "create_ai_app_card_provenance" => state.is_caller_openchat_user(),
        // Accepted from ANY principal — bearer semantics, validated in the method body; external
        // apps call these with principals that are not OpenChat users. Claim uses a single-use,
        // app-bound 256-bit token; revoke requires a signed proof-of-possession challenge. Failed
        // calls use independent bounded per-principal throttle buckets in the method bodies.
        "claim_ai_app_link_code" | "revoke_ai_app_user_key" => true,
        "suspend_user" | "unsuspend_user" => state.is_caller_platform_moderator(),
        "set_diamond_membership_fees"
        | "set_premium_item_cost"
        | "set_user_upgrade_concurrency"
        | "update_blocked_username_patterns" => state.is_caller_platform_operator(),
        "upload_wasm_chunk" => state.can_caller_upload_wasm_chunks(),
        "add_platform_moderator"
        | "add_platform_operator"
        | "remove_platform_moderator"
        | "remove_platform_operator"
        | "assign_platform_moderators_group"
        | "set_max_concurrent_user_canister_upgrades"
        | "add_local_user_index_canister"
        | "upgrade_user_canister_wasm"
        | "upgrade_local_user_index_canister_wasm"
        | "mark_local_user_index_full"
        | "register_external_achievement"
        | "publish_bot"
        | "remove_ai_app"
        | "suspected_bots" => state.is_caller_governance_principal(),
        // Mirrors publish_bot, but also reaches the msgpack variant for registered users in local
        // test mode; the handler then enforces exact app ownership (or configured governance).
        "publish_ai_app" => state.is_caller_governance_principal() || (state.data.test_mode && state.is_caller_openchat_user()),
        "award_external_achievement" | "modclub_callback" => true,
        "remove_bot" => state.is_caller_governance_principal() || state.is_caller_openchat_user(),
        _ => false,
    };

    if is_valid {
        ic_cdk::api::accept_message();
    }
}
