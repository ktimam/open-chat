use std::fs;
use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../..")
        .canonicalize()
        .expect("resolve repository root")
}

fn read_repo_file(relative_path: &str) -> String {
    let path = repo_root().join(relative_path);
    fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

#[test]
fn actions_is_a_replicated_update_across_the_public_contract_and_clients() {
    let candid = read_repo_file("backend/canisters/action_inbox/api/can.did");
    assert!(
        candid
            .lines()
            .any(|line| line.trim() == "actions : (Args_1) -> (Response_1);"),
        "the public Candid contract must expose actions as an update"
    );
    assert!(
        !candid
            .lines()
            .any(|line| line.trim().starts_with("actions :") && line.trim().ends_with(" query;")),
        "actions must not be callable as an uncertified query"
    );

    let api_main = read_repo_file("backend/canisters/action_inbox/api/src/main.rs");
    assert!(api_main.contains("generate_candid_method!(action_inbox, actions, update);"));
    assert!(!api_main.contains("generate_candid_method!(action_inbox, actions, query);"));

    let implementation = read_repo_file("backend/canisters/action_inbox/impl/src/queries/actions.rs");
    assert!(implementation.contains("#[update(candid = true, msgpack = true)]"));
    assert!(!implementation.contains("#[query(candid = true, msgpack = true)]"));

    let integration_client = read_repo_file("backend/integration_tests/src/client/action_inbox.rs");
    assert!(integration_client.contains("generate_msgpack_update_call!(actions);"));
    assert!(!integration_client.contains("generate_msgpack_query_call!(actions);"));
}
