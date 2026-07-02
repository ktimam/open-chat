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
        };
        self.apps.insert(registration.id, registration.clone());
        Ok(registration)
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

    pub fn list(&self) -> Vec<AiAppRegistration> {
        // Deterministic (oldest-first) ordering — HashMap iteration order is arbitrary and clients
        // present these to users.
        let mut apps: Vec<_> = self.apps.values().cloned().collect();
        apps.sort_unstable_by_key(|r| r.id);
        apps
    }
}
