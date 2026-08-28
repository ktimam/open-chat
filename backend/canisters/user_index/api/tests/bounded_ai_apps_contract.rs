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
fn checked_in_candid_exposes_only_explicit_bounded_registry_shapes() {
    let candid = read_repo_file("backend/canisters/user_index/api/can.did");
    for method in ["ai_apps_by_ids", "my_ai_apps", "explore_ai_apps"] {
        assert!(candid.contains(&format!("{method} :")), "missing {method} from Candid");
    }
    for variant in ["TooManyApps", "InvalidPageSize", "ResponseTooLarge"] {
        assert!(candid.contains(variant), "missing fail-closed variant {variant}");
    }
}

#[test]
fn legacy_full_list_is_bounded_and_has_no_product_client_path() {
    let backend = read_repo_file("backend/canisters/user_index/impl/src/queries/ai_apps.rs");
    assert!(backend.contains("list_visible_page"));
    assert!(!backend.contains(".list_visible("));
    assert!(backend.contains("MAX_AI_APP_QUERY_PAGE_SIZE"));
    assert!(backend.contains("MAX_AI_APP_QUERY_RESPONSE_BYTES"));

    let client = read_repo_file("frontend/openchat-agent/src/services/userIndex/userIndex.client.ts");
    assert!(
        !client.contains("\"ai_apps\""),
        "product client must not call the legacy full-list query"
    );
    assert!(client.contains("boundedAiAppLookupBatches(lookups)"));
    assert!(client.contains("MAX_AI_APP_LOOKUPS_PER_CLIENT_CALL = 32"));

    for path in [
        "frontend/app/src/utils/aiActionRunner.ts",
        "frontend/app/src/utils/aiAppSurfaces.ts",
        "frontend/app/src/components/home/groupdetails/AiAppsSummary.svelte",
        "frontend/app/src/components/home/groupdetails/AiAppsDirectSummary.svelte",
        "frontend/app/src/components_mobile/home/groupdetails/AiAppsSummary.svelte",
        "frontend/app/src/components_mobile/home/groupdetails/AiAppsDirectSummary.svelte",
    ] {
        let source = read_repo_file(path);
        assert!(!source.contains(".aiApps()"), "{path} must never request the full registry");
    }
}

#[test]
fn every_directory_and_owner_page_uses_the_backend_limit() {
    for path in [
        "frontend/app/src/components/home/communities/explore/Explore.svelte",
        "frontend/app/src/components_mobile/home/communities/explore/Explore.svelte",
    ] {
        let source = read_repo_file(path).replace(char::is_whitespace, "");
        assert!(source.contains(".exploreAiApps("), "missing explorer call in {path}");
        assert!(source.contains(",8,)"), "{path} must request at most eight apps");
        assert!(!source.contains(",32,)"), "{path} still requests the old oversized page");
    }

    for path in [
        "frontend/app/src/components/home/profile/MyApps.svelte",
        "frontend/app/src/components_mobile/home/user_profile/MyApps.svelte",
    ] {
        let source = read_repo_file(path);
        assert!(source.contains("myAiAppsPage(pageIndex, 8)"));
        assert!(source.contains("apps.length < total"), "{path} must expose later owner pages");
    }
}

#[test]
fn strict_runtime_validators_cover_new_methods_and_failures() {
    let typebox = read_repo_file("frontend/openchat-agent/src/typebox.ts");
    for shape in [
        "UserIndexAiAppsByIdsArgs",
        "UserIndexAiAppsByIdsResponse",
        "UserIndexMyAiAppsArgs",
        "UserIndexMyAiAppsResponse",
        "TooManyApps",
        "InvalidPageSize",
        "ResponseTooLarge",
    ] {
        assert!(typebox.contains(shape), "missing strict runtime shape {shape}");
    }
}
