use search::weighted::{Document as SearchDocument, Query};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use types::{AiAppId, AiAppManifest, AiAppRegistration, TimestampMillis, UserId};

/// On-chain directory of "AI apps" — each a single manifest covering the app's identity, delivery key
/// and every action it offers. Heap state, serialized across upgrades like the other models.
#[derive(Serialize, Deserialize, Default)]
pub struct AiAppRegistry {
    apps: HashMap<AiAppId, AiAppRegistration>,
    next_id: AiAppId,
}

/// The manifest's `name` is already registered by a different owner (and re-owning wasn't allowed).
pub struct NameTakenByAnotherOwner;

impl AiAppRegistry {
    /// An app's name is globally unique. Re-registering a name the caller already owns upserts the
    /// existing entry — keeping its id and created timestamp — rather than accumulating duplicates;
    /// the stable id is what per-chat enablement stores, so it must survive re-deploys. A name owned
    /// by ANOTHER owner is an error unless `allow_reown` is set (the endpoint passes test_mode — a
    /// dev convenience so local re-deploys under a fresh identity keep the app's id and enablement),
    /// in which case the entry is re-owned in place: id and created preserved, owner and manifest
    /// replaced, updated bumped.
    pub fn register(
        &mut self,
        owner: UserId,
        manifest: AiAppManifest,
        now: TimestampMillis,
        allow_reown: bool,
    ) -> Result<AiAppRegistration, NameTakenByAnotherOwner> {
        // Prefer the caller's own entry if entries with this name somehow exist for several owners
        // (possible from before names were globally unique), then the oldest — deterministically,
        // since HashMap iteration order is arbitrary.
        let existing_id = self
            .apps
            .values()
            .filter(|r| r.manifest.name == manifest.name)
            .min_by_key(|r| (r.owner != owner, r.id))
            .map(|r| r.id);

        if let Some(existing) = existing_id.and_then(|id| self.apps.get_mut(&id)) {
            if existing.owner != owner && !allow_reown {
                return Err(NameTakenByAnotherOwner);
            }
            existing.owner = owner;
            existing.manifest = manifest;
            existing.updated = now;
            return Ok(existing.clone());
        }

        self.next_id += 1;
        let registration = AiAppRegistration {
            id: self.next_id,
            owner,
            manifest,
            created: now,
            updated: now,
            // Private until published (the upsert branch above leaves `published` untouched, so a
            // re-registered app keeps its directory visibility — like bots keep theirs on update).
            published: false,
        };
        self.apps.insert(registration.id, registration.clone());
        Ok(registration)
    }

    /// Makes the app visible in the public directory/explorer. Returns false for an unknown id.
    pub fn publish(&mut self, id: AiAppId, now: TimestampMillis) -> bool {
        if let Some(app) = self.apps.get_mut(&id) {
            app.published = true;
            app.updated = now;
            true
        } else {
            false
        }
    }

    pub fn delete(&mut self, owner: UserId, name: &str) -> bool {
        if let Some(id) = self
            .apps
            .values()
            .find(|r| r.owner == owner && r.manifest.name == name)
            .map(|r| r.id)
        {
            self.apps.remove(&id);
            true
        } else {
            false
        }
    }

    pub fn contains(&self, id: AiAppId) -> bool {
        self.apps.contains_key(&id)
    }

    pub fn get(&self, id: AiAppId) -> Option<&AiAppRegistration> {
        self.apps.get(&id)
    }

    /// The directory as one caller sees it: every PUBLISHED app, plus the caller's own unpublished
    /// ones (a registrant must be able to see and manage an app before it is published).
    /// Deterministic (oldest-first) ordering — HashMap iteration order is arbitrary and clients
    /// present these to users.
    pub fn list_visible(&self, caller: Option<UserId>) -> Vec<AiAppRegistration> {
        let mut apps: Vec<_> = self
            .apps
            .values()
            .filter(|r| r.published || Some(r.owner) == caller)
            .cloned()
            .collect();
        apps.sort_unstable_by_key(|r| r.id);
        apps
    }

    /// Paginated, scored search over PUBLISHED apps only (the explorer surface). Mirrors
    /// UserMap::search_bots: name weighted 5x over description when a term is given; with no
    /// term, oldest-first (registration order — apps have no installation count to rank by).
    /// Returns (page, total-before-pagination).
    pub fn search(&self, search_term: Option<String>, page_index: u32, page_size: u8) -> (Vec<AiAppRegistration>, u32) {
        let query = search_term.map(Query::parse);

        let mut matches: Vec<_> = self
            .apps
            .values()
            .filter(|r| r.published)
            .map(|r| {
                let score = if let Some(query) = &query {
                    SearchDocument::default()
                        .add_field(r.manifest.name.clone(), 5.0, true)
                        .add_field(r.manifest.description.clone(), 1.0, true)
                        .calculate_score(query)
                } else {
                    // ids ascend from 1, so this ranks oldest registrations first.
                    u32::MAX - r.id
                };
                (score, r)
            })
            .collect();

        let total = matches.len() as u32;

        matches.sort_by_key(|(score, _)| *score);

        let matches = matches
            .into_iter()
            .rev()
            .filter(|&(s, _)| s > 0)
            .map(|(_, r)| r.clone())
            .skip(page_index as usize * page_size as usize)
            .take(page_size as usize)
            .collect();

        (matches, total)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use candid::Principal;

    fn user(byte: u8) -> UserId {
        Principal::from_slice(&[byte]).into()
    }

    fn manifest(name: &str) -> AiAppManifest {
        AiAppManifest {
            name: name.to_string(),
            description: "d".to_string(),
            icon_url: None,
            app_canister_id: None,
            inbox_canister_id: None,
            consumer_public_key: String::new(),
            per_user_keys: true,
            actions: vec![],
            surfaces: vec![],
        }
    }

    // PRODUCTION path (allow_reown=false — what the endpoint passes when test_mode is off): a name
    // owned by ANOTHER owner is rejected and the existing entry is left completely untouched.
    #[test]
    fn register_rejects_name_taken_by_another_owner_when_reown_disallowed() {
        let mut registry = AiAppRegistry::default();
        let owner_a = user(1);
        let owner_b = user(2);

        let id = registry.register(owner_a, manifest("X"), 1, false).ok().unwrap().id;

        assert!(
            registry.register(owner_b, manifest("X"), 2, false).is_err(),
            "a different owner must not take over 'X' in production"
        );

        let entry = registry.get(id).unwrap();
        assert_eq!(entry.owner, owner_a, "ownership must be unchanged");
        assert_eq!(entry.updated, 1, "a rejected registration must not touch the entry");
        assert_eq!(entry.manifest.description, "d", "the manifest must be unchanged");
    }

    // The upsert branch must leave `published` untouched: a published app that re-registers (e.g. a
    // redeploy re-syncing its manifest) stays published; only manifest + updated change.
    #[test]
    fn re_register_upsert_preserves_published_flag() {
        let mut registry = AiAppRegistry::default();
        let owner = user(1);

        let id = registry.register(owner, manifest("X"), 1, false).ok().unwrap().id;
        assert!(registry.publish(id, 2), "publish of a known id must succeed");

        let mut v2 = manifest("X");
        v2.description = "v2".to_string();
        let re = registry.register(owner, v2, 3, false).ok().unwrap();

        assert_eq!(re.id, id, "upsert keeps the id");
        assert!(re.published, "re-registering must NOT un-publish the app");

        let entry = registry.get(id).unwrap();
        assert!(entry.published, "stored entry stays published");
        assert_eq!(entry.manifest.description, "v2", "manifest is replaced");
        assert_eq!(entry.updated, 3, "updated is bumped");
        assert_eq!(entry.created, 1, "created survives the upsert");
    }

    // Visibility boundary: an unpublished app is absent from search (the explorer surface) and from
    // other users' list_visible, while the owner still sees it; publish() flips it public.
    #[test]
    fn search_hides_unpublished_and_reveals_after_publish() {
        let mut registry = AiAppRegistry::default();
        let owner = user(1);
        let other = user(2);

        let app = registry.register(owner, manifest("findme"), 1, false).ok().unwrap();

        // Before publish: invisible to search and to non-owners; owner still sees it.
        let (page, total) = registry.search(Some("findme".to_string()), 0, 10);
        assert!(page.is_empty(), "unpublished app must not match search: {page:?}");
        assert_eq!(total, 0);
        assert!(registry.list_visible(Some(owner)).iter().any(|r| r.id == app.id));
        assert!(!registry.list_visible(Some(other)).iter().any(|r| r.id == app.id));
        assert!(!registry.list_visible(None).iter().any(|r| r.id == app.id));

        // Publish -> present in search and visible to everyone.
        assert!(registry.publish(app.id, 2));
        let (page, total) = registry.search(Some("findme".to_string()), 0, 10);
        assert_eq!(total, 1);
        assert!(page.iter().any(|r| r.id == app.id), "published app must match search");
        assert!(registry.list_visible(Some(other)).iter().any(|r| r.id == app.id));

        // Unknown id never publishes.
        assert!(!registry.publish(9999, 3));
    }
}
