use super::{certification::CertifiedDirectory, model::*};
use candid::Principal;
use ic_http_certification::HttpRequest;
use serde_json::{json, Value};

fn p(n: u32) -> Principal {
    Principal::from_slice(&n.to_be_bytes())
}
fn registry(local: bool) -> Registry {
    Registry::new(
        Init {
            operator: p(1),
            allow_loopback: local,
        },
        p(99),
    )
    .unwrap()
}
fn input(id: &str, revision: &str) -> Value {
    json!({
        "id": id, "name": format!("App {id}"), "description": "Public developer test app",
        "revision": revision, "publisherOrigin": "https://publisher.example",
        "catalog": {"url":"/app.json", "sha256":"a".repeat(64), "byteLength":123},
        "processor": {"url":"/processor.js", "sha256":"b".repeat(64), "byteLength":456},
        "setupUrl":"/connect"
    })
}
fn register(state: &mut Registry, owner: Principal, id: &str, revision: &str) -> Review {
    state
        .register(owner, &input(id, revision).to_string(), 1)
        .unwrap()
}
fn publish(state: &mut Registry, owner: Principal, id: &str, revision: &str) -> Review {
    let review = register(state, owner, id, revision);
    state
        .publish(p(1), owner, id, &review.commitment, 2)
        .unwrap()
}
fn page(state: &Registry) -> Value {
    serde_json::from_slice(&state.pages().unwrap()["/apps-v2.json"]).unwrap()
}

#[test]
fn anonymous_cannot_initialize_or_register() {
    assert!(Registry::new(
        Init {
            operator: Principal::anonymous(),
            allow_loopback: false
        },
        p(99)
    )
    .is_err());
    assert!(Registry::new(
        Init {
            operator: Principal::management_canister(),
            allow_loopback: false
        },
        p(99)
    )
    .is_err());
    assert!(registry(false)
        .register(Principal::anonymous(), &input("test", "r1").to_string(), 0)
        .is_err());
}
#[test]
fn caller_is_injected_as_publisher_and_unpublished_entries_stay_private() {
    let mut state = registry(false);
    let review = register(&mut state, p(2), "test", "r1");
    let descriptor: Value = serde_json::from_str(&review.descriptor_json).unwrap();
    assert_eq!(descriptor["publisher"]["principal"], p(2).to_text());
    assert_eq!(
        descriptor["catalog"]["url"],
        "https://publisher.example/app.json"
    );
    assert_eq!(page(&state)["apps"], json!([]));
    assert_eq!(state.generation, 0);
    assert!(state.pending(p(3), p(2), "test").is_err());
    assert!(state.pending(Principal::anonymous(), p(2), "test").is_err());
    assert!(state.pending(p(1), p(2), "test").is_ok());
    assert!(state.pending(p(2), p(2), "test").is_ok());
    assert!(state.mine(p(3), None).unwrap().apps.is_empty());
    assert!(state.mine(Principal::anonymous(), None).is_err());
}
#[test]
fn registration_cannot_inject_identity_or_unexpected_data() {
    for key in [
        "publisher",
        "owner",
        "privateKey",
        "processorContext",
        "version",
    ] {
        let mut value = input("test", "r1");
        value[key] = json!("not accepted");
        assert!(
            registry(false)
                .register(p(2), &value.to_string(), 0)
                .is_err(),
            "{key}"
        );
    }
    let duplicate = input("test", "r1")
        .to_string()
        .replacen('{', "{\"id\":\"duplicate\",", 1);
    assert!(registry(false).register(p(2), &duplicate, 0).is_err());
}
#[test]
fn production_origins_are_https_and_local_mode_only_allows_exact_loopback_http() {
    for origin in [
        "http://publisher.example",
        "https://publisher.example/",
        "https://user@publisher.example",
        "https://publisher.example:443",
        "https://publisher.example/path",
        "https://publisher.example?x",
        "https://publisher.example#x",
        "http://localhost:3000",
        "https://localhost",
    ] {
        let mut value = input("test", "r1");
        value["publisherOrigin"] = json!(origin);
        assert!(
            registry(false)
                .register(p(2), &value.to_string(), 0)
                .is_err(),
            "{origin}"
        );
    }
    for origin in [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://[::1]:3000",
    ] {
        let mut value = input("test", "r1");
        value["publisherOrigin"] = json!(origin);
        assert!(
            registry(true).register(p(2), &value.to_string(), 0).is_ok(),
            "{origin}"
        );
    }
    for origin in [
        "http://example.com",
        "http://127.0.0.2:3000",
        "http://localhost.example",
        "http://2130706433:3000",
    ] {
        let mut value = input("test", "r1");
        value["publisherOrigin"] = json!(origin);
        assert!(
            registry(true)
                .register(p(2), &value.to_string(), 0)
                .is_err(),
            "{origin}"
        );
    }
}
#[test]
fn resources_cannot_escape_origin_or_smuggle_credentials_queries_fragments() {
    for invalid in [
        "https://other.example/app",
        "//other.example/app",
        "https://user:secret@publisher.example/app",
        "/app?token=x",
        "/app#token",
        "javascript:alert(1)",
        "/\u{202e}app",
    ] {
        for field in ["catalog", "processor", "setupUrl"] {
            let mut value = input("test", "r1");
            if field == "setupUrl" {
                value[field] = json!(invalid);
            } else {
                value[field]["url"] = json!(invalid);
            }
            assert!(
                registry(false)
                    .register(p(2), &value.to_string(), 0)
                    .is_err(),
                "{field}: {invalid}"
            );
        }
    }
}
#[test]
fn hashes_lengths_metadata_and_ids_are_bounded() {
    for invalid in [
        json!(0),
        json!(-1),
        json!(1_048_577),
        json!(1.5),
        json!("123"),
    ] {
        let mut value = input("test", "r1");
        value["catalog"]["byteLength"] = invalid;
        assert!(registry(false)
            .register(p(2), &value.to_string(), 0)
            .is_err());
    }
    for hash in [
        "A".repeat(64),
        "g".repeat(64),
        "a".repeat(63),
        "a".repeat(65),
    ] {
        let mut value = input("test", "r1");
        value["processor"]["sha256"] = json!(hash);
        assert!(registry(false)
            .register(p(2), &value.to_string(), 0)
            .is_err());
    }
    for field in ["name", "description", "id", "revision"] {
        for value in [
            "",
            " leading",
            "trailing ",
            "control\n",
            "bidirectional\u{202e}",
        ] {
            let mut descriptor = input("test", "r1");
            descriptor[field] = json!(value);
            assert!(
                registry(false)
                    .register(p(2), &descriptor.to_string(), 0)
                    .is_err(),
                "{field}"
            );
        }
    }
    assert!(registry(false)
        .register(p(2), &input("not an id", "r1").to_string(), 0)
        .is_err());
    let mut value = input("test", "r1");
    value["description"] = json!("x".repeat(4097));
    assert!(registry(false)
        .register(p(2), &value.to_string(), 0)
        .is_err());
}
#[test]
fn publication_requires_operator_and_exact_reviewed_commitment() {
    let mut state = registry(false);
    let review = register(&mut state, p(2), "test", "r1");
    for caller in [p(2), p(3), Principal::anonymous()] {
        assert!(state
            .publish(caller, p(2), "test", &review.commitment, 2)
            .is_err());
    }
    assert!(state.publish(p(1), p(2), "test", "wrong", 2).is_err());
    assert!(state
        .publish(p(1), p(3), "test", &review.commitment, 2)
        .is_err());
    let published = state
        .publish(p(1), p(2), "test", &review.commitment, 2)
        .unwrap();
    assert_eq!(published.published_revision, Some(review.proposal_revision));
    assert_eq!(page(&state)["apps"].as_array().unwrap().len(), 1);
    assert_eq!(state.generation, 1);
}
#[test]
fn pending_update_does_not_replace_published_revision_or_accept_stale_approval() {
    let mut state = registry(false);
    let original = publish(&mut state, p(2), "test", "r1");
    let second = register(&mut state, p(2), "test", "r2");
    assert_eq!(page(&state)["apps"][0]["revision"], "r1");
    assert_eq!(state.generation, 1);
    assert!(state
        .publish(p(1), p(2), "test", &original.commitment, 4)
        .is_err());
    let third = register(&mut state, p(2), "test", "r3");
    assert!(state
        .publish(p(1), p(2), "test", &second.commitment, 4)
        .is_err());
    state
        .publish(p(1), p(2), "test", &third.commitment, 4)
        .unwrap();
    assert_eq!(page(&state)["apps"][0]["revision"], "r3");
    assert_eq!(state.generation, 2);
}
#[test]
fn identical_resync_and_duplicate_publish_are_idempotent() {
    let mut state = registry(false);
    let original = publish(&mut state, p(2), "test", "r1");
    let again = register(&mut state, p(2), "test", "r1");
    assert_eq!(original, again);
    state
        .publish(p(1), p(2), "test", &again.commitment, 4)
        .unwrap();
    assert_eq!(state.next_revision, 1);
    assert_eq!(state.generation, 1);
}
#[test]
fn publication_binds_id_permanently_and_competing_unpublished_drafts_do_not_squat() {
    let mut state = registry(false);
    let first = register(&mut state, p(2), "test", "r1");
    let other = register(&mut state, p(3), "test", "r1");
    state
        .publish(p(1), p(2), "test", &first.commitment, 2)
        .unwrap();
    assert!(state
        .publish(p(1), p(3), "test", &other.commitment, 2)
        .is_err());
    assert!(state
        .unpublish(p(3), "test", first.proposal_revision)
        .is_err());
    assert!(state
        .unpublish(p(2), "test", first.proposal_revision + 1)
        .is_err());
    state
        .unpublish(p(2), "test", first.proposal_revision)
        .unwrap();
    assert!(state
        .register(p(3), &input("test", "r2").to_string(), 3)
        .is_err());
    assert!(state
        .publish(p(1), p(3), "test", &other.commitment, 4)
        .is_err());
    assert_eq!(page(&state)["apps"], json!([]));
    state.validate_restored(p(99)).unwrap();
}
#[test]
fn operator_can_revoke_without_changing_owner_or_pending_content() {
    let mut state = registry(false);
    let original = publish(&mut state, p(2), "test", "r1");
    state
        .unpublish(p(1), "test", original.proposal_revision)
        .unwrap();
    let pending = state.pending(p(2), p(2), "test").unwrap();
    assert_ne!(pending.commitment, original.commitment);
    assert_eq!(pending.descriptor_json, original.descriptor_json);
    assert_eq!(state.bindings["test"], p(2));
}

#[test]
fn revoked_app_cannot_be_republished_by_replaying_its_old_approval() {
    let mut state = registry(false);
    let original = publish(&mut state, p(2), "test", "r1");
    state
        .unpublish(p(2), "test", original.proposal_revision)
        .unwrap();
    assert!(state
        .publish(p(1), p(2), "test", &original.commitment, 3)
        .is_err());
    assert_eq!(page(&state)["apps"], json!([]));
    let fresh_review = state.pending(p(1), p(2), "test").unwrap();
    assert!(fresh_review.proposal_revision > original.proposal_revision);
    assert_eq!(fresh_review.published_revision, None);
    state
        .publish(p(1), p(2), "test", &fresh_review.commitment, 4)
        .unwrap();
    assert_eq!(state.status().published_count, 1);
}

#[test]
fn revoke_preserves_pending_update_content_but_invalidates_its_old_approval() {
    let mut state = registry(false);
    let original = publish(&mut state, p(2), "test", "r1");
    let update = register(&mut state, p(2), "test", "r2");
    state
        .unpublish(p(1), "test", original.proposal_revision)
        .unwrap();
    assert!(state
        .publish(p(1), p(2), "test", &original.commitment, 3)
        .is_err());
    assert!(state
        .publish(p(1), p(2), "test", &update.commitment, 3)
        .is_err());
    let new = state.pending(p(1), p(2), "test").unwrap();
    assert_eq!(new.descriptor_json, update.descriptor_json);
    assert!(new.proposal_revision > update.proposal_revision);
    assert_ne!(new.commitment, update.commitment);
    // The invalidation also survives the exact stable upgrade representation.
    let mut restored: Registry = candid::decode_one(&candid::encode_one(&state).unwrap()).unwrap();
    restored.validate_restored(p(99)).unwrap();
    assert!(restored
        .publish(p(1), p(2), "test", &update.commitment, 4)
        .is_err());
    restored
        .publish(p(1), p(2), "test", &new.commitment, 4)
        .unwrap();
    assert_eq!(page(&restored)["apps"][0]["revision"], "r2");
}

#[test]
fn revocation_counter_exhaustion_leaves_all_state_unchanged() {
    for exhaust_generation in [false, true] {
        let mut state = registry(false);
        let original = publish(&mut state, p(2), "test", "r1");
        register(&mut state, p(2), "test", "r2");
        if exhaust_generation {
            state.generation = u64::MAX;
        } else {
            state.next_revision = u64::MAX;
        }
        let before = candid::encode_one(&state).unwrap();
        assert!(state
            .unpublish(p(1), "test", original.proposal_revision)
            .is_err());
        assert_eq!(candid::encode_one(&state).unwrap(), before);
        assert_eq!(state.status().published_count, 1);
    }
}
#[test]
fn commitment_binds_registry_owner_id_metadata_and_monotonic_revision() {
    let mut a = registry(false);
    let mut b = Registry::new(
        Init {
            operator: p(1),
            allow_loopback: false,
        },
        p(100),
    )
    .unwrap();
    let original = register(&mut a, p(2), "test", "r1");
    assert_ne!(
        original.commitment,
        register(&mut b, p(2), "test", "r1").commitment
    );
    assert_ne!(
        original.commitment,
        register(&mut a, p(3), "test", "r1").commitment
    );
    assert_ne!(
        original.commitment,
        register(&mut a, p(2), "test2", "r1").commitment
    );
    let second = register(&mut a, p(2), "test", "r2");
    let rollback = register(&mut a, p(2), "test", "r1");
    assert_ne!(original.commitment, rollback.commitment);
    assert!(rollback.proposal_revision > second.proposal_revision);
}
#[test]
fn draft_quota_and_expiry_are_bounded_without_deleting_published_apps() {
    let mut state = registry(false);
    for n in 0..MAX_PENDING_PER_OWNER {
        register(&mut state, p(2), &format!("draft{n}"), "r1");
    }
    assert!(state
        .register(p(2), &input("extra", "r1").to_string(), 2)
        .is_err());
    register(&mut state, p(2), "draft0", "r2");
    let review = state.pending(p(1), p(2), "draft0").unwrap();
    assert!(state
        .publish(p(1), p(2), "draft0", &review.commitment, DRAFT_TTL_NS + 1)
        .is_err());
    state
        .register(p(2), &input("extra", "r1").to_string(), DRAFT_TTL_NS + 2)
        .unwrap();
    assert_eq!(state.records.len(), 1);
    publish(&mut state, p(2), "published", "r1");
    state
        .register(
            p(2),
            &input("later", "r1").to_string(),
            DRAFT_TTL_NS * 2 + 3,
        )
        .unwrap();
    assert_eq!(state.status().published_count, 1);
}
#[test]
fn registry_record_capacity_cannot_be_bypassed_with_many_principals() {
    let mut state = registry(false);
    for n in 0..MAX_RECORDS {
        register(&mut state, p(n as u32 + 100), &format!("app{n}"), "r1");
    }
    assert!(state
        .register(p(5000), &input("extra", "r1").to_string(), 1)
        .is_err());
    assert_eq!(state.records.len(), MAX_RECORDS);
}
#[test]
fn empty_and_multi_page_snapshots_have_exact_generation_and_routes() {
    let mut state = registry(false);
    assert_eq!(
        page(&state),
        json!({"version":2,"generation":"0","page":0,"apps":[],"next":null})
    );
    for n in 0..17 {
        publish(&mut state, p(n + 100), &format!("app{n:03}"), "r1");
    }
    let pages = state.pages().unwrap();
    assert_eq!(pages.len(), 2);
    let first: Value = serde_json::from_slice(&pages["/apps-v2.json"]).unwrap();
    let last: Value = serde_json::from_slice(&pages["/pages/17/1.json"]).unwrap();
    assert_eq!(first["next"], "/pages/17/1.json");
    assert_eq!(first["apps"].as_array().unwrap().len(), 16);
    assert_eq!(last["generation"], "17");
    assert_eq!(last["page"], 1);
    assert_eq!(last["next"], Value::Null);
    assert_eq!(last["apps"].as_array().unwrap().len(), 1);
    publish(&mut state, p(999), "another", "r1");
    assert!(!state.pages().unwrap().contains_key("/pages/17/1.json"));
}
#[test]
fn max_published_apps_stays_at_sixteen_pages() {
    let mut state = registry(false);
    for n in 0..MAX_PUBLISHED {
        publish(&mut state, p(n as u32 + 100), &format!("app{n:03}"), "r1");
    }
    let review = register(&mut state, p(999), "extra", "r1");
    assert!(state
        .publish(p(1), p(999), "extra", &review.commitment, 2)
        .is_err());
    assert_eq!(state.pages().unwrap().len(), 16);
    assert_eq!(state.status().published_count, MAX_PUBLISHED as u32);
    assert!(state
        .pages()
        .unwrap()
        .values()
        .all(|bytes| bytes.len() <= MAX_PAGE_BYTES));
}
#[test]
fn stable_round_trip_preserves_pending_published_tombstones_and_certification() {
    let mut state = registry(false);
    publish(&mut state, p(2), "published", "r1");
    register(&mut state, p(2), "published", "r2");
    let revoked = publish(&mut state, p(3), "revoked", "r1");
    state
        .unpublish(p(3), "revoked", revoked.proposal_revision)
        .unwrap();
    let root = CertifiedDirectory::new(state.pages().unwrap())
        .unwrap()
        .root_hash();
    let bytes = candid::encode_one(&state).unwrap();
    let restored: Registry = candid::decode_one(&bytes).unwrap();
    restored.validate_restored(p(99)).unwrap();
    assert_eq!(state.pages().unwrap(), restored.pages().unwrap());
    assert_eq!(
        state.mine(p(2), None).unwrap(),
        restored.mine(p(2), None).unwrap()
    );
    assert_eq!(
        root,
        CertifiedDirectory::new(restored.pages().unwrap())
            .unwrap()
            .root_hash()
    );
    assert_eq!(restored.bindings["revoked"], p(3));
}
#[test]
fn corrupt_or_wrong_authority_stable_state_is_rejected_not_reset() {
    let mut original = registry(false);
    publish(&mut original, p(2), "test", "r1");
    assert!(original.validate_restored(p(98)).is_err());
    for change in 0..7 {
        let mut bad = original.clone();
        match change {
            0 => bad.schema_version = 0,
            1 => bad.operator = Principal::anonymous(),
            2 => bad.records.values_mut().next().unwrap().pending.commitment = "0".repeat(64),
            3 => {
                bad.records
                    .values_mut()
                    .next()
                    .unwrap()
                    .pending
                    .descriptor
                    .publisher
                    .principal = p(3).to_text()
            }
            4 => bad.next_revision = 0,
            5 => {
                bad.bindings.clear();
            }
            _ => {
                bad.records
                    .values_mut()
                    .next()
                    .unwrap()
                    .published
                    .as_mut()
                    .unwrap()
                    .descriptor
                    .id = "changed".into()
            }
        }
        assert!(bad.validate_restored(p(99)).is_err(), "mutation {change}");
    }
}

#[test]
fn identical_expired_draft_gets_a_fresh_commitment_and_can_be_reviewed_again() {
    let mut state = registry(false);
    let old = register(&mut state, p(2), "test", "r1");
    let new = state
        .register(p(2), &input("test", "r1").to_string(), DRAFT_TTL_NS + 1)
        .unwrap();
    assert_ne!(old.commitment, new.commitment);
    assert!(new.proposal_revision > old.proposal_revision);
    assert!(state
        .publish(p(1), p(2), "test", &old.commitment, DRAFT_TTL_NS + 2)
        .is_err());
    state
        .publish(p(1), p(2), "test", &new.commitment, DRAFT_TTL_NS + 2)
        .unwrap();
}

#[test]
fn owner_queries_are_paginated_and_do_not_include_other_publishers() {
    let mut state = registry(false);
    for n in 0..35 {
        publish(&mut state, p(2), &format!("app{n:03}"), "r1");
    }
    register(&mut state, p(3), "other", "r1");
    let first = state.mine(p(2), None).unwrap();
    assert_eq!(first.apps.len(), 16);
    assert_eq!(first.next.as_deref(), Some("app015"));
    let second = state.mine(p(2), first.next.as_deref()).unwrap();
    assert_eq!(second.apps.len(), 16);
    assert_eq!(second.next.as_deref(), Some("app031"));
    let last = state.mine(p(2), second.next.as_deref()).unwrap();
    assert_eq!(last.apps.len(), 3);
    assert!(last.next.is_none());
    assert!(state.mine(p(2), Some("invalid cursor")).is_err());
    assert_eq!(state.mine(p(3), None).unwrap().apps.len(), 1);
}
#[test]
fn certification_changes_only_with_publication_and_commits_exact_body() {
    let mut state = registry(false);
    let empty = CertifiedDirectory::new(state.pages().unwrap())
        .unwrap()
        .root_hash();
    register(&mut state, p(2), "test", "r1");
    assert_eq!(
        empty,
        CertifiedDirectory::new(state.pages().unwrap())
            .unwrap()
            .root_hash()
    );
    publish(&mut state, p(2), "test", "r1");
    let published = CertifiedDirectory::new(state.pages().unwrap())
        .unwrap()
        .root_hash();
    assert_ne!(empty, published);
    let mut altered = state.pages().unwrap();
    altered.get_mut("/apps-v2.json").unwrap().push(b' ');
    assert_ne!(
        published,
        CertifiedDirectory::new(altered).unwrap().root_hash()
    );
}
#[test]
fn certified_http_has_public_cors_no_credentials_and_rejects_wrong_routes_methods_and_query() {
    let directory = CertifiedDirectory::new(registry(false).pages().unwrap()).unwrap();
    // A dummy certificate tests witness construction only, not a real subnet signature.
    let response = directory
        .serve(
            &HttpRequest::get("/apps-v2.json").build(),
            b"test-certificate",
        )
        .unwrap();
    assert_eq!(response.status_code().as_u16(), 200);
    assert!(response
        .headers()
        .iter()
        .any(|(key, value)| key.eq_ignore_ascii_case("IC-Certificate")
            && value.contains("version=2")));
    assert!(response
        .headers()
        .iter()
        .any(|(key, value)| key == "access-control-allow-origin" && value == "*"));
    assert!(!response
        .headers()
        .iter()
        .any(|(key, _)| key == "access-control-allow-credentials"));
    for path in ["/", "/pages/99/1.json", "/Apps-v2.json", "/apps-v2.json/"] {
        assert_eq!(
            directory
                .serve(&HttpRequest::get(path).build(), b"test")
                .unwrap()
                .status_code()
                .as_u16(),
            404
        );
    }
    for path in [
        "/apps-v2.json?token=x",
        "/apps-v2.json#x",
        "https://registry.example/apps-v2.json",
    ] {
        assert_eq!(
            directory
                .serve(&HttpRequest::get(path).build(), b"test")
                .unwrap()
                .status_code()
                .as_u16(),
            400
        );
    }
    assert_eq!(
        directory
            .serve(&HttpRequest::post("/apps-v2.json").build(), b"test")
            .unwrap()
            .status_code()
            .as_u16(),
        405
    );
}
#[test]
fn candid_exposes_only_scoped_registry_management_and_http() {
    let interface = super::candid_interface();
    for method in [
        "register_app",
        "get_pending",
        "get_my_apps",
        "publish_app",
        "unpublish_app",
        "registry_status",
        "http_request",
    ] {
        assert!(interface.contains(method), "missing {method}");
    }
    for forbidden in [
        "http_request_update",
        "identity",
        "send_message",
        "create_user",
    ] {
        assert!(!interface.contains(forbidden));
    }
    let generated = interface
        .lines()
        .filter(|line| !line.trim_start().starts_with("//") && !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let committed = include_str!("../app_registry.did")
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(
        generated.trim(),
        committed.trim(),
        "Regenerate and review the interface when endpoints change"
    );
}
