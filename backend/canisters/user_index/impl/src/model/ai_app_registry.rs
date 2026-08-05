use constants::DAY_IN_MS;
use search::weighted::{Document as SearchDocument, Query};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use types::{AiAppId, AiAppManifest, AiAppRegistration, Milliseconds, TimestampMillis, UserId};

/// An unverified manifest is a short-lived development reservation, not a permanent namespace
/// claim. Five parallel drafts are enough for ordinary app development while making one-account
/// namespace/storage exhaustion uneconomical. Published (governance-approved and canister-vouched)
/// apps do not consume this draft quota.
pub const MAX_UNPUBLISHED_APPS_PER_OWNER: usize = 5;
pub const MAX_AI_APPS: usize = 10_000;
pub const MAX_AI_APP_QUERY_PAGE_SIZE: u8 = 8;
pub const MAX_AI_APP_QUERY_RESPONSE_BYTES: usize = 1_200_000;
pub const UNPUBLISHED_RESERVATION_TTL: Milliseconds = 30 * DAY_IN_MS;

/// On-chain directory of "AI apps" — each a single manifest covering the app's identity, delivery key
/// and every action it offers. Heap state, serialized across upgrades like the other models.
#[derive(Serialize, Deserialize)]
pub struct AiAppRegistry {
    apps: HashMap<AiAppId, AiAppRegistration>,
    next_id: AiAppId,
    /// Missing from legacy stable state, which means every previously published row was approved
    /// by the V1 name-only verifier. Post-upgrade migrates 0 -> 2 exactly once and requires those
    /// rows to be explicitly republished through the exact-manifest V2 gate.
    #[serde(default)]
    publication_verifier_version: u8,
}

const PUBLICATION_VERIFIER_VERSION_V2: u8 = 2;

impl Default for AiAppRegistry {
    fn default() -> Self {
        Self {
            apps: HashMap::new(),
            next_id: 0,
            publication_verifier_version: PUBLICATION_VERIFIER_VERSION_V2,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum RegisterAiAppError {
    InvalidName,
    NameTakenByPublishedApp,
    UnpublishedOwnerQuotaExceeded,
    RegistryFull,
}

/// Canonical namespace key used for collisions and deletion. New names are deliberately ASCII-only:
/// accepting arbitrary Unicode without a complete, version-pinned confusable-skeleton algorithm
/// permits visually indistinguishable namespace claims. Case and the common visual separators are
/// ignored, so `Acme App`, `acme-app`, `acme_app`, and `acme.app` share one verified namespace key.
pub fn canonical_app_name(name: &str) -> Option<String> {
    ai_app_verifier_canister::c2c_verify_ai_app_v2::canonical_app_name(name)
}

impl AiAppRegistry {
    /// Invalidates every publication made before the exact-manifest V2 verifier existed.
    ///
    /// Advancing `updated` prevents a cached V1 decision from naming the new draft revision, and
    /// touching it at `now` grants the normal draft TTL so owners have time to upgrade their app
    /// canister, configure its V2 binding and republish. The stable version marker makes this
    /// idempotent and ensures later upgrades do not unpublish genuine V2 approvals.
    pub fn require_v2_republication(&mut self, now: TimestampMillis) -> usize {
        if self.publication_verifier_version >= PUBLICATION_VERIFIER_VERSION_V2 {
            return 0;
        }

        let mut unpublished = 0;
        for app in self.apps.values_mut().filter(|app| app.published) {
            app.published = false;
            app.updated = now.max(app.updated.saturating_add(1));
            unpublished += 1;
        }
        self.publication_verifier_version = PUBLICATION_VERIFIER_VERSION_V2;
        unpublished
    }

    /// Re-registering a canonical name the caller already owns upserts its stable id. In production,
    /// another owner's UNPUBLISHED draft is not exclusive: both owners may prepare a manifest and the
    /// first revision that passes canister vouch + governance publication wins the namespace. Only a
    /// PUBLISHED name blocks new owners. The final argument is retained for wire/call-site
    /// compatibility, but test mode never transfers ownership: chat enablement is keyed by stable id,
    /// so reusing another owner's id would also inherit that app's enabled chats.
    pub fn register(
        &mut self,
        owner: UserId,
        manifest: AiAppManifest,
        now: TimestampMillis,
        _allow_reown: bool,
    ) -> Result<AiAppRegistration, RegisterAiAppError> {
        let name_key = canonical_app_name(&manifest.name).ok_or(RegisterAiAppError::InvalidName)?;
        self.prune_expired_unpublished(now);

        // Multiple unverified owners may intentionally have the same key, so ownership is part of
        // the lookup and the oldest id wins deterministically for legacy duplicate rows.
        let own_existing_id = self
            .apps
            .values()
            .filter(|r| r.owner == owner && canonical_app_name(&r.manifest.name).is_some_and(|key| key == name_key))
            .min_by_key(|r| r.id)
            .map(|r| r.id);

        if let Some(existing) = own_existing_id.and_then(|id| self.apps.get_mut(&id)) {
            return Ok(Self::upsert(existing, owner, manifest, now));
        }

        // Drafts cannot squat. A verified/published app owns its canonical key until its owner
        // deletes it or governance removes it after owner loss/abandonment.
        if self.apps.values().any(|registration| {
            registration.published && canonical_app_name(&registration.manifest.name).is_some_and(|key| key == name_key)
        }) {
            return Err(RegisterAiAppError::NameTakenByPublishedApp);
        }

        let unpublished_for_owner = self
            .apps
            .values()
            .filter(|registration| registration.owner == owner && !registration.published)
            .count();
        if unpublished_for_owner >= MAX_UNPUBLISHED_APPS_PER_OWNER {
            return Err(RegisterAiAppError::UnpublishedOwnerQuotaExceeded);
        }
        if self.apps.len() >= MAX_AI_APPS {
            return Err(RegisterAiAppError::RegistryFull);
        }

        self.next_id = self.next_id.checked_add(1).ok_or(RegisterAiAppError::RegistryFull)?;
        let registration = AiAppRegistration {
            id: self.next_id,
            owner,
            manifest,
            created: now,
            updated: now,
            // Private until an asynchronous verifier and governance vouch for this exact revision.
            published: false,
        };
        self.apps.insert(registration.id, registration.clone());
        Ok(registration)
    }

    fn upsert(
        existing: &mut AiAppRegistration,
        owner: UserId,
        manifest: AiAppManifest,
        now: TimestampMillis,
    ) -> AiAppRegistration {
        // Registration is commonly re-run by deploy/sync scripts. A byte-identical resync by the
        // same owner is not a new reviewed revision and must not hide an already-published app.
        // Treat serialization failure conservatively as a change (both values are serializable in
        // practice because they have already crossed the API boundary).
        let manifest_unchanged = existing.owner == owner
            && msgpack::serialize_to_vec(&existing.manifest)
                .ok()
                .zip(msgpack::serialize_to_vec(&manifest).ok())
                .is_some_and(|(current, incoming)| current == incoming);
        if manifest_unchanged {
            // An unpublished draft must be touched at least once per TTL to remain in storage.
            // Published apps are permanent until explicit owner/governance removal.
            if !existing.published {
                existing.updated = now.max(existing.updated);
            }
            return existing.clone();
        }
        // A re-registration that changes the app's SURFACES or its verified `app_canister_id` must
        // NOT keep the published (vouched) status: `publish_ai_app` vouches the app_canister_id, and
        // the surfaces (e.g. the in-bubble "card" renderer OpenChat embeds) are the origin clients
        // then trust. Silently swapping a card surface to a new origin AFTER publishing would bypass
        // that authority — so un-publish, forcing publish_ai_app to re-run the vouch. An unchanged
        // manifest (a plain re-sync redeploy) keeps its published status, exactly as before.
        existing.owner = owner;
        existing.manifest = manifest;
        // `updated` is the public manifest-revision token. It must change even when two updates
        // execute in the same millisecond, otherwise an approval for the first can publish the second.
        existing.updated = now.max(existing.updated.saturating_add(1));
        // Every field belongs to the reviewed manifest. Delivery keys, actions, schemas, labels and
        // surfaces must all receive a fresh verifier decision after any write.
        existing.published = false;
        existing.clone()
    }

    /// Lazy expiry keeps the stable heap bounded without introducing a timer or second source of
    /// truth. It runs before every registration, so expired drafts never consume a quota/global slot.
    fn prune_expired_unpublished(&mut self, now: TimestampMillis) {
        self.apps
            .retain(|_, registration| !Self::unpublished_reservation_expired(registration, now));
    }

    fn unpublished_reservation_expired(registration: &AiAppRegistration, now: TimestampMillis) -> bool {
        !registration.published && now.saturating_sub(registration.updated) >= UNPUBLISHED_RESERVATION_TTL
    }

    /// Makes the app visible in the public directory/explorer. Returns false for an unknown id.
    #[cfg(test)]
    pub fn publish(&mut self, id: AiAppId, now: TimestampMillis) -> bool {
        let Some(revision) = self.apps.get(&id).map(|app| app.updated) else {
            return false;
        };
        self.publish_if_current(id, revision, now)
    }

    /// Publishes only the exact revision sent to the asynchronous verifier.
    pub fn publish_if_current(&mut self, id: AiAppId, verified_revision: TimestampMillis, now: TimestampMillis) -> bool {
        let Some(app) = self.apps.get(&id) else {
            return false;
        };
        if app.updated != verified_revision || app.published {
            return false;
        }
        if Self::unpublished_reservation_expired(app, now) {
            return false;
        }
        let Some(name_key) = canonical_app_name(&app.manifest.name) else {
            return false;
        };
        // Update calls are serialized, so exactly one vouched contender can cross this check and
        // publish. Later contenders for the same canonical key fail closed.
        if self.apps.values().any(|registration| {
            registration.id != id
                && registration.published
                && canonical_app_name(&registration.manifest.name).is_some_and(|key| key == name_key)
        }) {
            return false;
        }

        let app = self
            .apps
            .get_mut(&id)
            .expect("app existed before the non-awaiting collision check");
        app.published = true;
        true
    }

    pub fn delete(&mut self, owner: UserId, name: &str) -> bool {
        if let Some(id) = self.owned_app_id(owner, name) {
            self.apps.remove(&id);
            true
        } else {
            false
        }
    }

    pub fn owned_app_id(&self, owner: UserId, name: &str) -> Option<AiAppId> {
        let name_key = canonical_app_name(name)?;
        self.apps
            .values()
            .filter(|r| r.owner == owner && canonical_app_name(&r.manifest.name).is_some_and(|key| key == name_key))
            .min_by_key(|r| r.id)
            .map(|r| r.id)
    }

    /// Governance recovery for a verified app whose owner is lost or abandoned. The caller guard is
    /// enforced by the update endpoint; the model operation itself is deterministic and idempotent.
    pub fn remove(&mut self, id: AiAppId) -> bool {
        self.apps.remove(&id).is_some()
    }

    pub fn contains(&self, id: AiAppId) -> bool {
        self.apps.contains_key(&id)
    }

    pub fn get(&self, id: AiAppId) -> Option<&AiAppRegistration> {
        self.apps.get(&id)
    }

    pub fn get_visible(&self, id: AiAppId, caller: Option<UserId>, now: TimestampMillis) -> Option<&AiAppRegistration> {
        self.apps.get(&id).filter(|registration| {
            registration.published
                || (Some(registration.owner) == caller && !Self::unpublished_reservation_expired(registration, now))
        })
    }

    pub fn list_owned_page(
        &self,
        owner: UserId,
        now: TimestampMillis,
        page_index: u32,
        page_size: u8,
    ) -> (Vec<AiAppRegistration>, u32) {
        // Sort references, then clone only the requested page. A single owner may eventually have
        // many published apps, so cloning the owner's entire registry before pagination recreates
        // the same allocation/encoding DoS as the deprecated full-list query.
        let mut apps: Vec<_> = self
            .apps
            .values()
            .filter(|registration| {
                registration.owner == owner
                    && (registration.published || !Self::unpublished_reservation_expired(registration, now))
            })
            .collect();
        apps.sort_unstable_by_key(|registration| registration.id);
        let total = u32::try_from(apps.len()).unwrap_or(u32::MAX);
        let offset = (page_index as usize).saturating_mul(page_size as usize);
        (
            apps.into_iter().skip(offset).take(page_size as usize).cloned().collect(),
            total,
        )
    }

    /// Bounded compatibility page for the legacy `ai_apps` wire method. This intentionally sorts
    /// references and clones only one small page; new callers must use exact-id lookup, explorer
    /// pagination, or caller-owned pagination instead.
    pub fn list_visible_page(
        &self,
        caller: Option<UserId>,
        now: TimestampMillis,
        page_index: u32,
        page_size: u8,
    ) -> (Vec<AiAppRegistration>, u32) {
        let mut apps: Vec<_> = self
            .apps
            .values()
            .filter(|registration| {
                registration.published
                    || (Some(registration.owner) == caller && !Self::unpublished_reservation_expired(registration, now))
            })
            .collect();
        apps.sort_unstable_by_key(|registration| registration.id);
        let total = u32::try_from(apps.len()).unwrap_or(u32::MAX);
        let offset = (page_index as usize).saturating_mul(page_size as usize);
        (
            apps.into_iter().skip(offset).take(page_size as usize).cloned().collect(),
            total,
        )
    }

    /// The directory as one caller sees it: every PUBLISHED app, plus the caller's own unpublished
    /// ones (a registrant must be able to see and manage an app before it is published).
    /// Deterministic (oldest-first) ordering — HashMap iteration order is arbitrary and clients
    /// present these to users.
    #[cfg(test)]
    pub fn list_visible(&self, caller: Option<UserId>, now: TimestampMillis) -> Vec<AiAppRegistration> {
        let mut apps: Vec<_> = self
            .apps
            .values()
            .filter(|r| r.published || (Some(r.owner) == caller && !Self::unpublished_reservation_expired(r, now)))
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

        if query.is_some() {
            matches.retain(|(score, _)| *score > 0);
        }

        let total = u32::try_from(matches.len()).unwrap_or(u32::MAX);

        matches.sort_by_key(|(score, _)| *score);

        let matches = matches
            .into_iter()
            .rev()
            .map(|(_, r)| r.clone())
            .skip((page_index as usize).saturating_mul(page_size as usize))
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

    // PRODUCTION path (allow_reown=false): a PUBLISHED name is exclusive and a rejected
    // registration leaves the verified entry completely untouched.
    #[test]
    fn register_rejects_published_name_taken_by_another_owner() {
        let mut registry = AiAppRegistry::default();
        let owner_a = user(1);
        let owner_b = user(2);

        let id = registry.register(owner_a, manifest("X"), 1, false).ok().unwrap().id;
        assert!(registry.publish(id, 2));

        assert!(
            registry.register(owner_b, manifest("X"), 2, false).is_err(),
            "a different owner must not take over 'X' in production"
        );

        let entry = registry.get(id).unwrap();
        assert_eq!(entry.owner, owner_a, "ownership must be unchanged");
        assert_eq!(
            entry.updated, 1,
            "a rejected registration must not touch the published revision"
        );
        assert_eq!(entry.manifest.description, "d", "the manifest must be unchanged");
    }

    // Every manifest write invalidates the previous verifier decision. Even presentation-only fields
    // are security relevant once OpenChat renders the app's provenance and surfaces.
    #[test]
    fn re_register_upsert_requires_republication() {
        let mut registry = AiAppRegistry::default();
        let owner = user(1);

        let id = registry.register(owner, manifest("X"), 1, false).ok().unwrap().id;
        assert!(registry.publish(id, 2), "publish of a known id must succeed");

        let mut v2 = manifest("X");
        v2.description = "v2".to_string();
        let re = registry.register(owner, v2, 3, false).ok().unwrap();

        assert_eq!(re.id, id, "upsert keeps the id");
        assert!(!re.published, "re-registering must un-publish the app");

        let entry = registry.get(id).unwrap();
        assert!(!entry.published, "stored entry must require a fresh verifier decision");
        assert_eq!(entry.manifest.description, "v2", "manifest is replaced");
        assert_eq!(entry.updated, 3, "updated is bumped");
        assert_eq!(entry.created, 1, "created survives the upsert");
    }

    #[test]
    fn identical_resync_preserves_publication_and_revision() {
        let mut registry = AiAppRegistry::default();
        let owner = user(1);

        let original = manifest("X");
        let id = registry.register(owner, original.clone(), 1, false).ok().unwrap().id;
        assert!(registry.publish(id, 2));
        let published_revision = registry.get(id).unwrap().updated;

        let resynced = registry.register(owner, original, 2, false).ok().unwrap();
        assert!(resynced.published, "an identical deploy-time sync must keep the app visible");
        assert_eq!(
            resynced.updated, published_revision,
            "an identical manifest is the same revision"
        );
    }

    #[test]
    fn publication_preserves_the_exact_vouched_manifest_revision() {
        let mut registry = AiAppRegistry::default();
        let owner = user(1);
        let draft = registry.register(owner, manifest("X"), 10, false).unwrap();

        assert!(registry.publish_if_current(draft.id, draft.updated, 999));
        let published = registry.get(draft.id).unwrap();
        assert!(published.published);
        assert_eq!(
            published.updated, draft.updated,
            "the published revision must equal the revision sent to the verifier"
        );
    }

    #[test]
    fn stale_publication_revision_cannot_publish_new_manifest() {
        let mut registry = AiAppRegistry::default();
        let owner = user(1);
        let app = registry.register(owner, manifest("X"), 10, false).ok().unwrap();
        let verified_revision = app.updated;

        let mut changed = manifest("X");
        changed.description = "changed while verifier was awaiting".to_string();
        let changed = registry.register(owner, changed, 10, false).ok().unwrap();

        assert!(
            changed.updated > verified_revision,
            "manifest revisions must be monotonic even in one millisecond"
        );
        assert!(!registry.publish_if_current(app.id, verified_revision, 11));
        assert!(!registry.get(app.id).unwrap().published);
        assert!(registry.publish_if_current(app.id, changed.updated, 12));
    }

    fn card_surface(url: &str) -> types::AiAppSurface {
        types::AiAppSurface {
            kind: "card".to_string(),
            url: url.to_string(),
            display: types::SurfaceDisplay::Sheet,
        }
    }

    // A re-registration that CHANGES the surface set must drop the published (vouched) status, so the
    // app has to re-run publish_ai_app (and its anti-squat vouch) before the new surface is trusted.
    // Otherwise a published app could silently swap its embedded "card" surface to an attacker origin.
    #[test]
    fn re_register_changing_surfaces_unpublishes() {
        let mut registry = AiAppRegistry::default();
        let owner = user(1);

        let id = registry.register(owner, manifest("X"), 1, false).ok().unwrap().id;
        assert!(registry.publish(id, 2));

        let mut v2 = manifest("X");
        v2.surfaces = vec![card_surface("https://evil.example/openchat/card")];
        let re = registry.register(owner, v2, 3, false).ok().unwrap();

        assert_eq!(re.id, id, "upsert keeps the id");
        assert!(!re.published, "changing surfaces must un-publish (force a re-vouch)");
        assert!(!registry.get(id).unwrap().published, "stored entry is un-published");
    }

    // The same applies to a change of the verified `app_canister_id` — that IS the vouch target, so a
    // new value must be re-vouched before the app is trusted again.
    #[test]
    fn re_register_changing_app_canister_id_unpublishes() {
        let mut registry = AiAppRegistry::default();
        let owner = user(1);

        let id = registry.register(owner, manifest("X"), 1, false).ok().unwrap().id;
        assert!(registry.publish(id, 2));

        let mut v2 = manifest("X");
        v2.app_canister_id = Some(Principal::from_slice(&[9, 9, 9]));
        let re = registry.register(owner, v2, 3, false).ok().unwrap();
        assert!(!re.published, "changing app_canister_id must un-publish (force a re-vouch)");
    }

    // An unchanged surface cannot exempt a changed description from re-verification: users still
    // attribute the changed manifest to the verifier's approval.
    #[test]
    fn re_register_same_surfaces_but_changed_manifest_unpublishes() {
        let mut registry = AiAppRegistry::default();
        let owner = user(1);

        let mut v1 = manifest("X");
        v1.surfaces = vec![card_surface("https://app.example/chat/card")];
        let id = registry.register(owner, v1, 1, false).ok().unwrap().id;
        assert!(registry.publish(id, 2));

        let mut v2 = manifest("X");
        v2.surfaces = vec![card_surface("https://app.example/chat/card")];
        v2.description = "changed".to_string();
        let re = registry.register(owner, v2, 3, false).ok().unwrap();
        assert!(!re.published, "a changed manifest must require a fresh verifier decision");
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
        assert!(registry.list_visible(Some(owner), 1).iter().any(|r| r.id == app.id));
        assert!(!registry.list_visible(Some(other), 1).iter().any(|r| r.id == app.id));
        assert!(!registry.list_visible(None, 1).iter().any(|r| r.id == app.id));

        // Publish -> present in search and visible to everyone.
        assert!(registry.publish(app.id, 2));
        let (page, total) = registry.search(Some("findme".to_string()), 0, 10);
        assert_eq!(total, 1);
        assert!(page.iter().any(|r| r.id == app.id), "published app must match search");
        assert!(registry.list_visible(Some(other), 2).iter().any(|r| r.id == app.id));

        // Unknown id never publishes.
        assert!(!registry.publish(9999, 3));
    }

    #[test]
    fn search_total_counts_only_matching_published_apps() {
        let mut registry = AiAppRegistry::default();
        let owner = user(1);
        let needle = registry.register(owner, manifest("needle"), 1, false).unwrap();
        assert!(registry.publish(needle.id, 1));
        let unrelated = registry.register(owner, manifest("unrelated"), 2, false).unwrap();
        assert!(registry.publish(unrelated.id, 2));

        let (page, total) = registry.search(Some("needle".to_string()), 0, 8);
        assert_eq!(total, 1);
        assert_eq!(page.iter().map(|app| app.id).collect::<Vec<_>>(), vec![needle.id]);
    }

    #[test]
    fn near_capacity_registry_clones_only_the_requested_page() {
        let mut registry = AiAppRegistry::default();
        let owner = user(1);
        for id in 1..=MAX_AI_APPS as AiAppId {
            let mut app_manifest = manifest(&format!("app-{id}"));
            // Keep the fixture inexpensive while placing near-maximum encoded rows on the page
            // actually returned. If pagination cloned the full registry, this test's 10,000-row
            // shape would instead exercise the original global allocation path.
            if id <= MAX_AI_APP_QUERY_PAGE_SIZE as AiAppId {
                app_manifest.description = "x".repeat(127 * 1024);
            }
            registry.apps.insert(
                id,
                AiAppRegistration {
                    id,
                    owner,
                    manifest: app_manifest,
                    created: id as u64,
                    updated: id as u64,
                    published: true,
                },
            );
        }
        registry.next_id = MAX_AI_APPS as AiAppId;

        let (page, total) = registry.list_visible_page(None, 0, 0, MAX_AI_APP_QUERY_PAGE_SIZE);
        assert_eq!(total, MAX_AI_APPS as u32);
        assert_eq!(page.len(), MAX_AI_APP_QUERY_PAGE_SIZE as usize);
        assert!(msgpack::serialize_to_vec(&page).unwrap().len() < MAX_AI_APP_QUERY_RESPONSE_BYTES);
    }

    #[test]
    fn unpublished_reservation_does_not_exclude_another_owner() {
        let mut registry = AiAppRegistry::default();
        let owner_a = user(1);
        let owner_b = user(2);

        registry.register(owner_a, manifest("Acme App"), 1, false).ok().unwrap();

        assert!(
            registry.register(owner_b, manifest("Acme App"), 2, false).is_ok(),
            "an unverified reservation must not be globally exclusive"
        );
    }

    #[test]
    fn one_owner_cannot_accumulate_unbounded_unpublished_reservations() {
        let mut registry = AiAppRegistry::default();
        let owner = user(1);

        for index in 0..5 {
            registry
                .register(owner, manifest(&format!("app-{index}")), index, false)
                .ok()
                .unwrap();
        }

        assert!(
            registry.register(owner, manifest("app-5"), 6, false).is_err(),
            "the sixth unverified reservation must exceed the owner quota"
        );
    }

    #[test]
    fn published_name_blocks_normalized_lookalikes() {
        let mut registry = AiAppRegistry::default();
        let owner_a = user(1);
        let owner_b = user(2);

        let app = registry.register(owner_a, manifest("Acme App"), 1, false).ok().unwrap();
        assert!(registry.publish(app.id, 2));

        assert!(
            registry.register(owner_b, manifest("acme-app"), 3, false).is_err(),
            "case and separator variants of a verified name must collide"
        );
    }

    #[test]
    fn deleting_by_normalized_name_releases_the_owner_slot() {
        let mut registry = AiAppRegistry::default();
        let owner = user(1);

        for index in 0..5 {
            registry
                .register(owner, manifest(&format!("app-{index}")), index, false)
                .ok()
                .unwrap();
        }

        assert!(registry.delete(owner, "APP 0"));
        assert!(registry.register(owner, manifest("replacement"), 10, false).is_ok());
    }

    #[test]
    fn canonical_names_collapse_case_and_separators_and_reject_unicode_confusables() {
        let expected = canonical_app_name("Acme App").unwrap();
        assert_eq!(canonical_app_name("acme-app").as_deref(), Some(expected.as_str()));
        assert_eq!(canonical_app_name("ACME_app").as_deref(), Some(expected.as_str()));
        assert_eq!(canonical_app_name("acme.app").as_deref(), Some(expected.as_str()));

        // Greek alpha, Cyrillic a, and full-width Latin A are visually confusable with ASCII.
        assert!(canonical_app_name("Αcme").is_none());
        assert!(canonical_app_name("аcme").is_none());
        assert!(canonical_app_name("Ａcme").is_none());
        assert!(canonical_app_name("-acme").is_none());
        assert!(canonical_app_name("acme-").is_none());
    }

    #[test]
    fn expired_drafts_are_pruned_before_quota_is_checked() {
        let mut registry = AiAppRegistry::default();
        let owner = user(1);

        for index in 0..MAX_UNPUBLISHED_APPS_PER_OWNER {
            registry
                .register(owner, manifest(&format!("draft-{index}")), 1, false)
                .ok()
                .unwrap();
        }
        assert!(matches!(
            registry.register(owner, manifest("blocked"), 2, false),
            Err(RegisterAiAppError::UnpublishedOwnerQuotaExceeded)
        ));

        let replacement = registry
            .register(owner, manifest("replacement"), 1 + UNPUBLISHED_RESERVATION_TTL, false)
            .ok()
            .unwrap();
        let visible = registry.list_visible(Some(owner), 1 + UNPUBLISHED_RESERVATION_TTL);
        assert_eq!(visible.len(), 1, "all five expired drafts must be reclaimed");
        assert_eq!(visible[0].id, replacement.id);
    }

    #[test]
    fn first_vouched_revision_wins_and_governance_removal_recovers_the_name() {
        let mut registry = AiAppRegistry::default();
        let owner_a = user(1);
        let owner_b = user(2);

        let first = registry.register(owner_a, manifest("Acme App"), 1, false).ok().unwrap();
        let second = registry.register(owner_b, manifest("acme-app"), 1, false).ok().unwrap();
        assert_ne!(first.id, second.id, "unverified contenders retain separate ownership");

        assert!(registry.publish_if_current(first.id, first.updated, 2));
        assert!(
            !registry.publish_if_current(second.id, second.updated, 2),
            "serialized publication permits exactly one verified owner"
        );

        assert!(registry.remove(first.id), "governance can recover a name after owner loss");
        assert!(registry.publish_if_current(second.id, second.updated, 3));
        assert!(!registry.remove(first.id), "governance removal is idempotent");
    }

    #[test]
    fn expired_draft_is_hidden_and_cannot_be_published() {
        let mut registry = AiAppRegistry::default();
        let owner = user(1);
        let draft = registry.register(owner, manifest("stale"), 1, false).ok().unwrap();
        let expired_at = 1 + UNPUBLISHED_RESERVATION_TTL;

        assert!(registry.list_visible(Some(owner), expired_at).is_empty());
        assert!(!registry.publish_if_current(draft.id, draft.updated, expired_at));
        assert!(!registry.get(draft.id).unwrap().published);
    }

    #[test]
    fn stable_round_trip_preserves_draft_quota_and_expiration() {
        let owner = user(1);
        let mut registry = AiAppRegistry::default();
        for index in 0..MAX_UNPUBLISHED_APPS_PER_OWNER {
            registry
                .register(owner, manifest(&format!("draft-{index}")), 1, false)
                .ok()
                .unwrap();
        }

        let bytes = msgpack::serialize_to_vec(&registry).unwrap();
        let mut restored: AiAppRegistry = msgpack::deserialize_then_unwrap(&bytes);
        assert!(matches!(
            restored.register(owner, manifest("blocked"), 2, false),
            Err(RegisterAiAppError::UnpublishedOwnerQuotaExceeded)
        ));
        assert!(
            restored
                .register(owner, manifest("after-expiry"), 1 + UNPUBLISHED_RESERVATION_TTL, false)
                .is_ok()
        );
    }

    #[test]
    fn test_mode_never_reassigns_an_app_id_between_local_accounts() {
        let mut registry = AiAppRegistry::default();
        let accounts = [user(1), user(2), user(3), user(4)]; // accounts A-D
        let registrations: Vec<_> = accounts
            .iter()
            .enumerate()
            .map(|(index, owner)| {
                registry
                    .register(*owner, manifest("Shared Local Name"), index as u64 + 1, true)
                    .unwrap()
            })
            .collect();

        for (registration, owner) in registrations.iter().zip(accounts) {
            assert_eq!(registration.owner, owner);
            assert_eq!(registry.get(registration.id).unwrap().owner, owner);
        }
        let mut ids: Vec<_> = registrations.iter().map(|registration| registration.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), accounts.len(), "no account may inherit another app's stable id");
    }

    #[test]
    fn publication_keeps_the_exact_verifier_approved_revision() {
        let mut registry = AiAppRegistry::default();
        let app = registry.register(user(1), manifest("X"), 10, false).unwrap();
        assert!(registry.publish_if_current(app.id, app.updated, 11));
        assert_eq!(registry.get(app.id).unwrap().updated, app.updated);
    }

    #[test]
    fn legacy_v1_publications_are_unpublished_once_and_can_be_v2_republished() {
        #[derive(Serialize)]
        struct LegacyRegistry {
            apps: HashMap<AiAppId, AiAppRegistration>,
            next_id: AiAppId,
        }

        let owner = user(1);
        let mut source = AiAppRegistry::default();
        let app = source.register(owner, manifest("legacy"), 1, false).unwrap();
        assert!(source.publish(app.id, 2));

        // Model stable state written before `publication_verifier_version` existed.
        let legacy = LegacyRegistry {
            apps: source.apps.clone(),
            next_id: source.next_id,
        };
        let bytes = msgpack::serialize_to_vec(&legacy).unwrap();
        let mut restored: AiAppRegistry = msgpack::deserialize_then_unwrap(&bytes);
        assert_eq!(restored.publication_verifier_version, 0);
        assert!(restored.get(app.id).unwrap().published);

        assert_eq!(restored.require_v2_republication(100), 1);
        let migrated = restored.get(app.id).unwrap();
        assert!(!migrated.published);
        assert_eq!(migrated.updated, 100, "migration grants a fresh draft TTL/revision");

        // Republish models a successful V2 decision. Later migrations/upgrades must not revoke it.
        assert!(restored.publish_if_current(app.id, migrated.updated, 101));
        assert_eq!(restored.require_v2_republication(200), 0);
        assert!(restored.get(app.id).unwrap().published);

        let bytes = msgpack::serialize_to_vec(&restored).unwrap();
        let mut upgraded_again: AiAppRegistry = msgpack::deserialize_then_unwrap(&bytes);
        assert_eq!(upgraded_again.require_v2_republication(300), 0);
        assert!(upgraded_again.get(app.id).unwrap().published);
    }

    #[test]
    fn global_registry_size_and_id_space_are_fail_closed() {
        let mut registry = AiAppRegistry::default();
        let owner = user(1);
        for id in 1..=MAX_AI_APPS as AiAppId {
            let mut registration_manifest = manifest(&format!("published-{id}"));
            registration_manifest.name = format!("published-{id}");
            registry.apps.insert(
                id,
                AiAppRegistration {
                    id,
                    owner,
                    manifest: registration_manifest,
                    created: 1,
                    updated: 1,
                    published: true,
                },
            );
        }
        registry.next_id = MAX_AI_APPS as AiAppId;
        assert!(matches!(
            registry.register(user(2), manifest("one-more"), 2, false),
            Err(RegisterAiAppError::RegistryFull)
        ));

        registry.apps.clear();
        registry.next_id = AiAppId::MAX;
        assert!(matches!(
            registry.register(owner, manifest("id-overflow"), 3, false),
            Err(RegisterAiAppError::RegistryFull)
        ));
    }
}
