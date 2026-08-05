use std::fs;
use std::path::{Path, PathBuf};

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(4)
        .expect("workspace root")
        .to_path_buf()
}

fn source(relative: &str) -> String {
    fs::read_to_string(workspace_root().join(relative)).expect("contract source must exist")
}

#[test]
fn post_upgrade_starts_the_bounded_key_migration_timer() {
    let lifecycle = source("backend/canisters/user_index/impl/src/lifecycle/mod.rs");
    let jobs = source("backend/canisters/user_index/impl/src/jobs/mod.rs");
    let migration = source("backend/canisters/user_index/impl/src/jobs/migrate_ai_app_user_keys.rs");

    assert!(lifecycle.contains("crate::jobs::start(&state)"));
    assert!(jobs.contains("migrate_ai_app_user_keys::start_job_if_required(state)"));
    assert!(migration.contains("ic_cdk_timers::set_timer(Duration::ZERO, async { run() })"));
    assert!(migration.contains("migrate_batch(MIGRATION_BATCH_SIZE,"));
    assert!(migration.contains("process_app_cleanup_batch(APP_CLEANUP_BATCH_SIZE)"));

    let removal = source("backend/canisters/user_index/impl/src/updates/remove_ai_app.rs");
    assert!(removal.contains("migrate_ai_app_user_keys::start_job_if_required(state)"));
}

#[test]
fn fanout_and_self_reads_trap_instead_of_returning_partial_migration_results() {
    let fanout = source("backend/canisters/user_index/impl/src/queries/ai_app_user_keys.rs");
    let own = source("backend/canisters/user_index/impl/src/queries/my_ai_app_keys.rs");
    for query in [fanout, own] {
        assert!(query.contains("unwrap_or_else(|error| ic_cdk::trap(&error.message()))"));
    }
}

#[test]
fn every_delivery_key_ingress_uses_the_p256_canonicalizer() {
    let set = source("backend/canisters/user_index/impl/src/updates/set_my_ai_app_key.rs");
    let claim = source("backend/canisters/user_index/impl/src/updates/c2c_claim_ai_app_link_code.rs");
    let register = source("backend/canisters/user_index/impl/src/updates/register_ai_app.rs");

    assert!(set.contains("canonicalize_p256_public_key"));
    assert!(claim.contains("validate_user_public_key"));
    assert!(claim.contains("restore_link_code"));
    assert!(register.matches("canonicalize_p256_public_key").count() >= 3);
}
