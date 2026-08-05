use crate::RuntimeState;
pub mod action_delivery_outbox;
pub mod make_pending_payments;
pub mod migrate_ai_app_user_keys;
pub mod prune_ai_app_card_tokens;
pub mod remove_from_online_users_canister;
pub mod reset_leaderboard;
pub mod retire_action_signing_keys;
pub mod scrub_upgrade_snapshot;
pub mod submit_message_to_modclub;
pub mod sync_events_to_local_user_index_canisters;
pub mod sync_users_to_identity_canister;
pub mod upgrade_canisters;

pub(crate) fn start(state: &RuntimeState) {
    action_delivery_outbox::start_job_if_required(state);
    make_pending_payments::start_job_if_required(state);
    migrate_ai_app_user_keys::start_job_if_required(state);
    prune_ai_app_card_tokens::start_job_if_required(state);
    retire_action_signing_keys::start_job_if_required(state);
    remove_from_online_users_canister::start_job_if_required(state);
    submit_message_to_modclub::start_job_if_required(state);
    sync_events_to_local_user_index_canisters::start_job_if_required(state);
    sync_users_to_identity_canister::start_job_if_required(state);
    upgrade_canisters::start_job_if_required(state);
    reset_leaderboard::start_job_if_required(state);
}
