use p256::PublicKey;
use p256::pkcs8::{DecodePublicKey, EncodePublicKey, LineEnding};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use types::{AiAppId, AiAppMemberKey, AiAppUserKey, UserId};

pub const MAX_PUBLIC_KEY_BYTES: usize = 2_000;
pub const MAX_KEYS_PER_USER: usize = 64;
pub const MAX_KEY_BYTES_PER_USER: usize = 16 * 1024;
pub const MAX_KEYS_PER_APP: usize = 50_000;
pub const MAX_KEY_BYTES_PER_APP: usize = 16 * 1024 * 1024;
pub const MAX_KEYS_GLOBAL: usize = 200_000;
pub const MAX_KEY_BYTES_GLOBAL: usize = 64 * 1024 * 1024;
const MAX_BINDINGS_PER_PUBLIC_KEY: usize = 32;
const INDEX_VERSION: u8 = 1;
pub const MIGRATION_BATCH_SIZE: usize = 100;
pub const APP_CLEANUP_BATCH_SIZE: usize = 100;

/// Parse an untrusted key as a P-256 SubjectPublicKeyInfo document and return one canonical PEM
/// representation. The byte bound is checked before ASN.1/base64 work.
pub(crate) fn canonicalize_p256_public_key(public_key: &str) -> Result<String, String> {
    let key_bytes = public_key.len();
    if key_bytes == 0 || key_bytes > MAX_PUBLIC_KEY_BYTES {
        return Err(format!("public key must be between 1 and {MAX_PUBLIC_KEY_BYTES} bytes"));
    }
    let parsed = PublicKey::from_public_key_pem(public_key)
        .map_err(|_| "public key must be a valid P-256 SPKI PEM public key".to_string())?;
    parsed
        .to_public_key_pem(LineEnding::LF)
        .map(|pem| pem.to_string())
        .map_err(|_| "public key could not be canonicalized".to_string())
}

/// Per-(user, app) delivery keys. `keys` remains the serialized source of truth. The other fields
/// are serialized, versioned indexes so ordinary reads, revocation, quota checks and app deletion
/// never scan the global map. Older states rebuild once, deterministically, on their first mutation.
#[derive(Serialize, Deserialize)]
pub struct AiAppUserKeys {
    keys: BTreeMap<(UserId, AiAppId), String>,
    #[serde(default)]
    by_public_key: HashMap<String, HashSet<(UserId, AiAppId)>>,
    #[serde(default)]
    by_app: HashMap<AiAppId, BTreeSet<UserId>>,
    #[serde(default)]
    by_user: HashMap<UserId, HashSet<AiAppId>>,
    #[serde(default)]
    key_bytes_by_app: HashMap<AiAppId, usize>,
    #[serde(default)]
    key_bytes_by_user: HashMap<UserId, usize>,
    #[serde(default)]
    total_key_bytes: usize,
    #[serde(default)]
    index_version: u8,
    #[serde(default)]
    legacy_keys_pending: Option<BTreeMap<(UserId, AiAppId), String>>,
    #[serde(default)]
    migration_dropped_keys: usize,
    #[serde(default)]
    pending_app_deletions: BTreeSet<AiAppId>,
    #[serde(default)]
    pending_app_cleanup_keys: usize,
    /// Monotonic per-tuple binding epochs. Removal retains the last epoch so a signed revoke cannot
    /// be replayed after the user links the same tuple again.
    #[serde(default)]
    binding_versions: BTreeMap<(UserId, AiAppId), u64>,
    /// Users deleted while a legacy migration is in progress. Their not-yet-indexed keys are
    /// discarded in bounded migration batches, with one epoch tombstone retained per tuple.
    #[serde(default)]
    revoked_users_during_migration: HashSet<UserId>,
}

impl Default for AiAppUserKeys {
    fn default() -> Self {
        Self {
            keys: BTreeMap::new(),
            by_public_key: HashMap::new(),
            by_app: HashMap::new(),
            by_user: HashMap::new(),
            key_bytes_by_app: HashMap::new(),
            key_bytes_by_user: HashMap::new(),
            total_key_bytes: 0,
            index_version: INDEX_VERSION,
            legacy_keys_pending: None,
            migration_dropped_keys: 0,
            pending_app_deletions: BTreeSet::new(),
            pending_app_cleanup_keys: 0,
            binding_versions: BTreeMap::new(),
            revoked_users_during_migration: HashSet::new(),
        }
    }
}

#[derive(Debug, Eq, PartialEq, Serialize)]
pub struct AiAppUserKeyMetrics {
    pub key_count: usize,
    pub canonical_key_bytes: usize,
    pub migration_remaining: usize,
    pub migration_dropped_keys: usize,
    pub pending_app_deletions: usize,
    pub pending_app_cleanup_keys: usize,
}

#[derive(Debug, Eq, PartialEq)]
pub enum SetAiAppUserKeyError {
    InvalidPublicKey(String),
    PublicKeyBindingLimitReached,
    UserCountLimitReached,
    UserByteLimitReached,
    AppCountLimitReached,
    AppByteLimitReached,
    GlobalCountLimitReached,
    GlobalByteLimitReached,
    MigrationInProgress,
    AppDeletionInProgress,
    BindingVersionExhausted,
}

impl SetAiAppUserKeyError {
    pub fn message(&self) -> String {
        match self {
            Self::InvalidPublicKey(message) => message.clone(),
            Self::PublicKeyBindingLimitReached => "public key has reached its app-binding limit".to_string(),
            Self::UserCountLimitReached => format!("a user may register at most {MAX_KEYS_PER_USER} AI-app keys"),
            Self::UserByteLimitReached => {
                format!("a user's AI-app keys may use at most {MAX_KEY_BYTES_PER_USER} bytes")
            }
            Self::AppCountLimitReached => format!("an app may have at most {MAX_KEYS_PER_APP} user keys"),
            Self::AppByteLimitReached => {
                format!("an app's user keys may use at most {MAX_KEY_BYTES_PER_APP} bytes")
            }
            Self::GlobalCountLimitReached => format!("AI-app key storage is at its {MAX_KEYS_GLOBAL}-key capacity"),
            Self::GlobalByteLimitReached => {
                format!("AI-app key storage is at its {MAX_KEY_BYTES_GLOBAL}-byte capacity")
            }
            Self::MigrationInProgress => "AI-app key storage migration is in progress; retry shortly".to_string(),
            Self::AppDeletionInProgress => "AI-app key deletion is in progress".to_string(),
            Self::BindingVersionExhausted => {
                "AI-app key binding version is exhausted; the connection cannot be renewed".to_string()
            }
        }
    }
}

impl AiAppUserKeys {
    /// Validate, canonicalize and upsert the key for one (user, app) pair.
    pub fn set(&mut self, user_id: UserId, app_id: AiAppId, public_key: String) -> Result<(), SetAiAppUserKeyError> {
        let canonical = canonicalize_p256_public_key(&public_key).map_err(SetAiAppUserKeyError::InvalidPublicKey)?;
        self.set_canonical(user_id, app_id, canonical)
    }

    /// Used after an ingress path has already parsed and canonicalized the key before consuming a
    /// one-time capability. Keeping this separate makes claim failure atomic without parsing twice.
    pub(crate) fn set_canonical(
        &mut self,
        user_id: UserId,
        app_id: AiAppId,
        public_key: String,
    ) -> Result<(), SetAiAppUserKeyError> {
        self.ensure_ready()?;
        if self.pending_app_deletions.contains(&app_id) {
            return Err(SetAiAppUserKeyError::AppDeletionInProgress);
        }
        self.insert_canonical(user_id, app_id, public_key)
    }

    /// Claiming a fresh app-authenticated link code is a new consent event, even if the app keeps
    /// the same durable PEM. Advance the tuple's authoritative epoch so the client can distinguish
    /// an explicitly completed reconnect from the already-present binding without timing guesses.
    pub(crate) fn claim_canonical(
        &mut self,
        user_id: UserId,
        app_id: AiAppId,
        public_key: String,
    ) -> Result<(), SetAiAppUserKeyError> {
        self.ensure_ready()?;
        if self.pending_app_deletions.contains(&app_id) {
            return Err(SetAiAppUserKeyError::AppDeletionInProgress);
        }
        let location = (user_id, app_id);
        let current_version = self.binding_versions.get(&location).copied().unwrap_or_default();
        let next_version = current_version
            .checked_add(1)
            .ok_or(SetAiAppUserKeyError::BindingVersionExhausted)?;
        if self.keys.get(&location) == Some(&public_key) {
            self.binding_versions.insert(location, next_version);
            return Ok(());
        }
        self.insert_canonical(user_id, app_id, public_key)
    }

    fn insert_canonical(&mut self, user_id: UserId, app_id: AiAppId, public_key: String) -> Result<(), SetAiAppUserKeyError> {
        let location = (user_id, app_id);
        let previous = self.keys.get(&location).cloned();
        if previous.as_ref() == Some(&public_key) {
            return Ok(());
        }

        if self
            .by_public_key
            .get(&public_key)
            .is_some_and(|bindings| !bindings.contains(&location) && bindings.len() >= MAX_BINDINGS_PER_PUBLIC_KEY)
        {
            return Err(SetAiAppUserKeyError::PublicKeyBindingLimitReached);
        }

        let is_new = previous.is_none();
        if is_new && self.by_user.get(&user_id).map_or(0, HashSet::len) >= MAX_KEYS_PER_USER {
            return Err(SetAiAppUserKeyError::UserCountLimitReached);
        }
        if is_new && self.by_app.get(&app_id).map_or(0, BTreeSet::len) >= MAX_KEYS_PER_APP {
            return Err(SetAiAppUserKeyError::AppCountLimitReached);
        }
        if is_new && self.keys.len() >= MAX_KEYS_GLOBAL {
            return Err(SetAiAppUserKeyError::GlobalCountLimitReached);
        }

        let old_bytes = previous.as_ref().map_or(0, String::len);
        let new_bytes = public_key.len();
        let user_bytes = replacement_size(
            self.key_bytes_by_user.get(&user_id).copied().unwrap_or_default(),
            old_bytes,
            new_bytes,
        );
        let app_bytes = replacement_size(
            self.key_bytes_by_app.get(&app_id).copied().unwrap_or_default(),
            old_bytes,
            new_bytes,
        );
        let total_bytes = replacement_size(self.total_key_bytes, old_bytes, new_bytes);
        if user_bytes > MAX_KEY_BYTES_PER_USER {
            return Err(SetAiAppUserKeyError::UserByteLimitReached);
        }
        if app_bytes > MAX_KEY_BYTES_PER_APP {
            return Err(SetAiAppUserKeyError::AppByteLimitReached);
        }
        if total_bytes > MAX_KEY_BYTES_GLOBAL {
            return Err(SetAiAppUserKeyError::GlobalByteLimitReached);
        }

        if let Some(previous) = previous {
            remove_public_key_binding(&mut self.by_public_key, &previous, location);
        } else {
            self.by_user.entry(user_id).or_default().insert(app_id);
            self.by_app.entry(app_id).or_default().insert(user_id);
        }
        self.keys.insert(location, public_key.clone());
        let next_version = self
            .binding_versions
            .get(&location)
            .copied()
            .unwrap_or_default()
            .saturating_add(1);
        self.binding_versions.insert(location, next_version);
        self.by_public_key.entry(public_key).or_default().insert(location);
        self.key_bytes_by_user.insert(user_id, user_bytes);
        self.key_bytes_by_app.insert(app_id, app_bytes);
        self.total_key_bytes = total_bytes;
        Ok(())
    }

    pub fn binding_version(&self, user_id: UserId, app_id: AiAppId) -> Option<u64> {
        self.readable_key_at((user_id, app_id))
            .map(|_| self.binding_versions.get(&(user_id, app_id)).copied().unwrap_or_default())
    }

    /// Current consent epoch for the exact user/app tuple, including while no key is installed.
    /// Keeping the tombstone makes cancel/remove invalidate authorizations created before it.
    pub fn binding_epoch(&self, user_id: UserId, app_id: AiAppId) -> u64 {
        self.binding_versions.get(&(user_id, app_id)).copied().unwrap_or_default()
    }

    /// Removes one binding. Idempotent.
    pub fn remove(&mut self, user_id: UserId, app_id: AiAppId) -> Result<bool, SetAiAppUserKeyError> {
        self.ensure_ready()?;
        Ok(self.remove_location_and_advance_epoch((user_id, app_id)))
    }

    /// Removes every indexed binding for one deleted account through the same epoch-advancing path
    /// as an explicit disconnect. Work is bounded by `MAX_KEYS_PER_USER`. If a legacy migration is
    /// active, not-yet-indexed rows are quarantined and discarded by subsequent bounded batches.
    pub fn remove_user(&mut self, user_id: UserId) -> usize {
        let app_ids: Vec<_> = self
            .by_user
            .get(&user_id)
            .into_iter()
            .flat_map(|apps| apps.iter().copied())
            .take(MAX_KEYS_PER_USER)
            .collect();
        let removed = app_ids
            .into_iter()
            .filter(|app_id| self.remove_location_and_advance_epoch((user_id, *app_id)))
            .count();
        if self.migration_required() {
            self.revoked_users_during_migration.insert(user_id);
        }
        removed
    }

    /// Marks an app unavailable immediately and schedules its keys for fixed-size cleanup batches.
    pub fn queue_app_cleanup(&mut self, app_id: AiAppId) -> Result<(), SetAiAppUserKeyError> {
        self.ensure_ready()?;
        self.queue_app_cleanup_unchecked(app_id);
        Ok(())
    }

    /// Schedules cleanup after the registry has already quarantined the app. Unlike governance
    /// removal, account deletion cannot be rolled back while a legacy key migration is running.
    /// The migration consults the quarantined registry and drops all not-yet-indexed rows; this
    /// durable marker then removes any indexed rows in bounded timer batches.
    pub fn queue_quarantined_app_cleanup(&mut self, app_id: AiAppId) {
        self.queue_app_cleanup_unchecked(app_id);
    }

    fn queue_app_cleanup_unchecked(&mut self, app_id: AiAppId) {
        if self.pending_app_deletions.insert(app_id) {
            self.pending_app_cleanup_keys = self
                .pending_app_cleanup_keys
                .saturating_add(self.by_app.get(&app_id).map_or(0, BTreeSet::len));
        }
    }

    /// Advances queued app deletion by at most `limit` key-or-empty-app work items.
    pub fn process_app_cleanup_batch(&mut self, limit: usize) -> usize {
        let mut work = 0;
        while work < limit {
            let Some(app_id) = self.pending_app_deletions.first().copied() else {
                break;
            };
            work += 1;
            let user_id = self.by_app.get(&app_id).and_then(BTreeSet::first).copied();
            if let Some(user_id) = user_id {
                if !self.remove_location((user_id, app_id)) {
                    // A stale reverse-index row must not make the timer spin forever. Consume one
                    // work unit and repair the indexes we can identify without a global scan.
                    remove_btree_index_binding(&mut self.by_app, app_id, user_id);
                    remove_index_binding(&mut self.by_user, user_id, app_id);
                    if !self.by_user.contains_key(&user_id) {
                        self.key_bytes_by_user.remove(&user_id);
                    }
                    self.pending_app_cleanup_keys = self.pending_app_cleanup_keys.saturating_sub(1);
                }
            } else {
                self.pending_app_deletions.remove(&app_id);
                // Normally the last real key removal already brought this counter to zero. Drop
                // and account for any stale per-app byte total before retiring a corrupt queue row.
                if let Some(stale_bytes) = self.key_bytes_by_app.remove(&app_id) {
                    self.total_key_bytes = self.total_key_bytes.saturating_sub(stale_bytes);
                }
            }
        }
        self.pending_app_cleanup_keys
    }

    /// Removes every binding for one canonical key. Work is bounded by the key reuse budget.
    pub fn remove_by_key(&mut self, public_key: &str) -> Result<u32, SetAiAppUserKeyError> {
        self.ensure_ready()?;
        let Ok(canonical) = canonicalize_p256_public_key(public_key) else {
            return Ok(0);
        };
        let locations: Vec<_> = self
            .by_public_key
            .get(&canonical)
            .into_iter()
            .flat_map(|locations| locations.iter().copied())
            .collect();
        let mut removed = 0;
        for location in locations {
            removed += u32::from(self.remove_location(location));
        }
        Ok(removed)
    }

    pub fn keys_for_users(&self, app_id: AiAppId, user_ids: &[UserId]) -> Result<Vec<AiAppMemberKey>, SetAiAppUserKeyError> {
        if self.migration_required() {
            return Err(SetAiAppUserKeyError::MigrationInProgress);
        }
        if self.pending_app_deletions.contains(&app_id) {
            return Ok(Vec::new());
        }
        Ok(user_ids
            .iter()
            .filter_map(|user_id| {
                let location = (*user_id, app_id);
                self.readable_key_at(location).map(|public_key| AiAppMemberKey {
                    user_id: *user_id,
                    public_key,
                })
            })
            .collect())
    }

    pub fn keys_for_user(&self, user_id: UserId) -> Result<Vec<AiAppUserKey>, SetAiAppUserKeyError> {
        if self.migration_required() {
            return Err(SetAiAppUserKeyError::MigrationInProgress);
        }
        let mut keys: Vec<_> = self
            .by_user
            .get(&user_id)
            .into_iter()
            .flat_map(|apps| apps.iter())
            .filter(|app_id| !self.pending_app_deletions.contains(app_id))
            .filter_map(|app_id| {
                self.keys.get(&(user_id, *app_id)).map(|public_key| AiAppUserKey {
                    app_id: *app_id,
                    public_key: public_key.clone(),
                    key_version: self.binding_versions.get(&(user_id, *app_id)).copied().unwrap_or_default(),
                })
            })
            .collect();
        keys.sort_unstable_by_key(|key| key.app_id);
        keys.truncate(MAX_KEYS_PER_USER);
        Ok(keys)
    }

    /// Exact reverse-index candidates for an external app proving possession of one canonical key.
    /// The result is bounded by `MAX_BINDINGS_PER_PUBLIC_KEY`; callers must still select the exact
    /// app-scoped subject and app id before mutating a binding.
    pub(crate) fn bindings_for_public_key(&self, public_key: &str) -> Result<Vec<(UserId, AiAppId)>, SetAiAppUserKeyError> {
        if self.migration_required() {
            return Err(SetAiAppUserKeyError::MigrationInProgress);
        }
        let canonical = canonicalize_p256_public_key(public_key).map_err(SetAiAppUserKeyError::InvalidPublicKey)?;
        let mut bindings: Vec<_> = self
            .by_public_key
            .get(&canonical)
            .into_iter()
            .flat_map(|bindings| bindings.iter().copied())
            .collect();
        bindings.sort_unstable();
        bindings.truncate(MAX_BINDINGS_PER_PUBLIC_KEY);
        Ok(bindings)
    }

    fn readable_key_at(&self, location: (UserId, AiAppId)) -> Option<String> {
        if let Some(public_key) = self.keys.get(&location) {
            return if self.index_version == INDEX_VERSION {
                Some(public_key.clone())
            } else {
                canonicalize_p256_public_key(public_key).ok()
            };
        }
        self.legacy_keys_pending
            .as_ref()
            .and_then(|pending| pending.get(&location))
            .and_then(|public_key| canonicalize_p256_public_key(public_key).ok())
    }

    fn remove_location(&mut self, location: (UserId, AiAppId)) -> bool {
        let Some(public_key) = self.keys.remove(&location) else {
            return false;
        };
        let (user_id, app_id) = location;
        let key_bytes = public_key.len();
        if self.pending_app_deletions.contains(&app_id) {
            self.pending_app_cleanup_keys = self.pending_app_cleanup_keys.saturating_sub(1);
        }
        remove_public_key_binding(&mut self.by_public_key, &public_key, location);
        remove_index_binding(&mut self.by_user, user_id, app_id);
        remove_btree_index_binding(&mut self.by_app, app_id, user_id);
        subtract_bytes(&mut self.key_bytes_by_user, user_id, key_bytes);
        subtract_bytes(&mut self.key_bytes_by_app, app_id, key_bytes);
        self.total_key_bytes = self.total_key_bytes.saturating_sub(key_bytes);
        true
    }

    fn remove_location_and_advance_epoch(&mut self, location: (UserId, AiAppId)) -> bool {
        let removed = self.remove_location(location);
        // Removal also represents explicit consent cancellation before a key exists. Always advance
        // the epoch so delayed authority cannot become valid after account recreation.
        let next_version = self
            .binding_versions
            .get(&location)
            .copied()
            .unwrap_or_default()
            .saturating_add(1);
        self.binding_versions.insert(location, next_version);
        removed
    }

    pub fn migration_required(&self) -> bool {
        self.index_version != INDEX_VERSION || self.legacy_keys_pending.is_some()
    }

    /// Advances the durable legacy migration by at most `limit` rows. After ordinary stable-state
    /// deserialization has materialized the legacy map as a BTreeMap, starting migration moves that
    /// allocation into the pending field in O(1); subsequent timer updates never scan it globally.
    /// Stable-state deserialization itself is whole-state work and is not made incremental here.
    pub fn migrate_batch(&mut self, limit: usize, mut app_is_eligible: impl FnMut(AiAppId) -> bool) -> usize {
        if self.index_version != INDEX_VERSION && self.legacy_keys_pending.is_none() {
            self.legacy_keys_pending = Some(std::mem::take(&mut self.keys));
            self.by_public_key.clear();
            self.by_app.clear();
            self.by_user.clear();
            self.key_bytes_by_app.clear();
            self.key_bytes_by_user.clear();
            self.total_key_bytes = 0;
            self.index_version = INDEX_VERSION;
        }

        let mut entries = Vec::with_capacity(limit);
        if let Some(pending) = self.legacy_keys_pending.as_mut() {
            for _ in 0..limit {
                let Some(entry) = pending.pop_first() else {
                    break;
                };
                entries.push(entry);
            }
        }

        for ((user_id, app_id), public_key) in entries {
            let location = (user_id, app_id);
            let revoked = self.revoked_users_during_migration.contains(&user_id);
            let retained = !revoked
                && !self.pending_app_deletions.contains(&app_id)
                && app_is_eligible(app_id)
                && canonicalize_p256_public_key(&public_key)
                    .is_ok_and(|canonical| self.insert_canonical(user_id, app_id, canonical).is_ok());
            if !retained {
                if revoked {
                    self.remove_location_and_advance_epoch(location);
                }
                self.migration_dropped_keys = self.migration_dropped_keys.saturating_add(1);
            }
        }

        if self.legacy_keys_pending.as_ref().is_some_and(BTreeMap::is_empty) {
            self.legacy_keys_pending = None;
            self.revoked_users_during_migration.clear();
        }
        self.legacy_keys_pending.as_ref().map_or(0, BTreeMap::len)
    }

    pub fn maintenance_required(&self) -> bool {
        self.migration_required() || !self.pending_app_deletions.is_empty()
    }

    pub fn metrics(&self) -> AiAppUserKeyMetrics {
        let migration_remaining = self.legacy_keys_pending.as_ref().map_or_else(
            || usize::from(self.index_version != INDEX_VERSION).saturating_mul(self.keys.len()),
            BTreeMap::len,
        );
        let key_count = if self.legacy_keys_pending.is_some() {
            self.keys.len().saturating_add(migration_remaining)
        } else {
            self.keys.len()
        };
        AiAppUserKeyMetrics {
            key_count,
            canonical_key_bytes: self.total_key_bytes,
            migration_remaining,
            migration_dropped_keys: self.migration_dropped_keys,
            pending_app_deletions: self.pending_app_deletions.len(),
            pending_app_cleanup_keys: self.pending_app_cleanup_keys,
        }
    }

    fn ensure_ready(&mut self) -> Result<(), SetAiAppUserKeyError> {
        if self.migration_required() { Err(SetAiAppUserKeyError::MigrationInProgress) } else { Ok(()) }
    }

    #[cfg(test)]
    fn indexed_public_key_count(&self) -> usize {
        self.by_public_key.len()
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.metrics().key_count
    }
}

fn replacement_size(current: usize, old: usize, new: usize) -> usize {
    current.saturating_sub(old).saturating_add(new)
}

fn remove_public_key_binding(
    index: &mut HashMap<String, HashSet<(UserId, AiAppId)>>,
    public_key: &str,
    location: (UserId, AiAppId),
) {
    let remove_entry = if let Some(bindings) = index.get_mut(public_key) {
        bindings.remove(&location);
        bindings.is_empty()
    } else {
        false
    };
    if remove_entry {
        index.remove(public_key);
    }
}

fn remove_index_binding<K: Eq + std::hash::Hash + Copy, V: Eq + std::hash::Hash>(
    index: &mut HashMap<K, HashSet<V>>,
    key: K,
    value: V,
) {
    let remove_entry = if let Some(values) = index.get_mut(&key) {
        values.remove(&value);
        values.is_empty()
    } else {
        false
    };
    if remove_entry {
        index.remove(&key);
    }
}

fn remove_btree_index_binding<K: Eq + std::hash::Hash + Copy, V: Ord>(index: &mut HashMap<K, BTreeSet<V>>, key: K, value: V) {
    let remove_entry = if let Some(values) = index.get_mut(&key) {
        values.remove(&value);
        values.is_empty()
    } else {
        false
    };
    if remove_entry {
        index.remove(&key);
    }
}

fn subtract_bytes<K: Eq + std::hash::Hash + Copy>(bytes: &mut HashMap<K, usize>, key: K, removed: usize) {
    let remove_entry = if let Some(total) = bytes.get_mut(&key) {
        *total = total.saturating_sub(removed);
        *total == 0
    } else {
        false
    };
    if remove_entry {
        bytes.remove(&key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use candid::Principal;
    use p256_key_pair::P256KeyPair;
    use rand::SeedableRng;
    use rand::rngs::StdRng;

    fn user(seed: u32) -> UserId {
        Principal::self_authenticating(&seed.to_le_bytes()).into()
    }

    fn key(seed: u64) -> String {
        P256KeyPair::new(&mut StdRng::seed_from_u64(seed))
            .public_key_pem()
            .to_string()
    }

    #[test]
    fn reverse_indexes_track_replacement_and_exact_removal() {
        let mut keys = AiAppUserKeys::default();
        let key_a = key(1);
        let key_b = key(2);
        keys.set(user(1), 1, key_a.clone()).unwrap();
        keys.set(user(2), 2, key_a.clone()).unwrap();
        keys.set(user(1), 1, key_b.clone()).unwrap();
        assert_eq!(keys.indexed_public_key_count(), 2);
        assert_eq!(keys.remove_by_key(&key_a), Ok(1));
        assert_eq!(keys.remove_by_key(&key_b), Ok(1));
        assert_eq!(keys.indexed_public_key_count(), 0);
    }

    #[test]
    fn reverse_key_candidates_are_bounded_and_keep_exact_user_app_tuples() {
        let mut keys = AiAppUserKeys::default();
        let shared = key(4);
        keys.set(user(2), 8, shared.clone()).unwrap();
        keys.set(user(1), 7, shared.clone()).unwrap();
        keys.set(user(1), 9, key(5)).unwrap();
        assert_eq!(
            keys.bindings_for_public_key(&shared).unwrap(),
            vec![(user(1), 7), (user(2), 8)]
        );
        assert!(keys.bindings_for_public_key("not a key").is_err());
    }

    #[test]
    fn one_public_key_has_a_hard_binding_cap() {
        let mut keys = AiAppUserKeys::default();
        let shared = key(3);
        for app_id in 0..MAX_BINDINGS_PER_PUBLIC_KEY as AiAppId {
            keys.set(user(1), app_id, shared.clone()).unwrap();
        }
        assert_eq!(
            keys.set(user(1), MAX_BINDINGS_PER_PUBLIC_KEY as AiAppId, shared.clone()),
            Err(SetAiAppUserKeyError::PublicKeyBindingLimitReached)
        );
        assert_eq!(keys.remove_by_key(&shared), Ok(MAX_BINDINGS_PER_PUBLIC_KEY as u32));
    }

    #[test]
    fn user_key_count_is_bounded_and_replacement_remains_available_at_capacity() {
        let mut keys = AiAppUserKeys::default();
        for app_id in 0..MAX_KEYS_PER_USER as AiAppId {
            keys.set(user(1), app_id, key(app_id as u64 + 10)).unwrap();
        }
        assert_eq!(
            keys.set(user(1), MAX_KEYS_PER_USER as AiAppId, key(10_000)),
            Err(SetAiAppUserKeyError::UserCountLimitReached)
        );
        assert!(keys.set(user(1), 0, key(10_001)).is_ok());
        assert_eq!(keys.len(), MAX_KEYS_PER_USER);
    }

    #[test]
    fn app_cleanup_uses_the_app_index_and_updates_all_budgets() {
        let mut keys = AiAppUserKeys::default();
        keys.set(user(1), 7, key(21)).unwrap();
        keys.set(user(2), 7, key(22)).unwrap();
        keys.set(user(1), 8, key(23)).unwrap();
        assert_eq!(keys.queue_app_cleanup(7), Ok(()));
        assert_eq!(keys.metrics().pending_app_cleanup_keys, 2);
        assert!(keys.keys_for_users(7, &[user(1), user(2)]).unwrap().is_empty());
        assert_eq!(keys.process_app_cleanup_batch(1), 1);
        assert_eq!(keys.process_app_cleanup_batch(1), 0);
        assert_eq!(keys.len(), 1);
        assert_eq!(keys.keys_for_user(user(1)).unwrap().len(), 1);
        assert!(keys.keys_for_user(user(2)).unwrap().is_empty());
    }

    #[test]
    fn app_cleanup_resumes_after_a_second_upgrade() {
        let mut keys = AiAppUserKeys::default();
        for seed in 0..(APP_CLEANUP_BATCH_SIZE + 1) {
            keys.set(user(seed as u32), 77, key(seed as u64 + 20_000)).unwrap();
        }
        keys.queue_app_cleanup(77).unwrap();
        assert_eq!(keys.process_app_cleanup_batch(APP_CLEANUP_BATCH_SIZE), 1);
        assert_eq!(keys.metrics().pending_app_deletions, 1);

        let checkpoint = msgpack::serialize_to_vec(&keys).unwrap();
        let mut resumed: AiAppUserKeys = msgpack::deserialize_then_unwrap(&checkpoint);
        assert_eq!(resumed.metrics().pending_app_cleanup_keys, 1);
        assert_eq!(resumed.process_app_cleanup_batch(APP_CLEANUP_BATCH_SIZE), 0);
        assert_eq!(resumed.metrics().pending_app_deletions, 0);
        assert_eq!(resumed.len(), 0);
    }

    #[test]
    fn app_cleanup_bounds_work_for_more_than_one_batch_of_empty_apps() {
        let mut keys = AiAppUserKeys::default();
        for app_id in 0..(APP_CLEANUP_BATCH_SIZE as AiAppId + 1) {
            keys.queue_app_cleanup(app_id).unwrap();
        }

        assert_eq!(keys.process_app_cleanup_batch(APP_CLEANUP_BATCH_SIZE), 0);
        assert_eq!(keys.metrics().pending_app_deletions, 1);
        assert_eq!(keys.process_app_cleanup_batch(APP_CLEANUP_BATCH_SIZE), 0);
        assert_eq!(keys.metrics().pending_app_deletions, 0);
    }

    #[test]
    fn app_cleanup_repairs_a_stale_reverse_index_without_spinning() {
        let mut keys = AiAppUserKeys::default();
        let user_id = user(99);
        let app_id = 77;
        keys.by_app.entry(app_id).or_default().insert(user_id);
        keys.by_user.entry(user_id).or_default().insert(app_id);
        keys.key_bytes_by_app.insert(app_id, 123);
        keys.key_bytes_by_user.insert(user_id, 123);
        keys.total_key_bytes = 123;
        keys.pending_app_deletions.insert(app_id);
        keys.pending_app_cleanup_keys = 1;

        assert_eq!(keys.process_app_cleanup_batch(1), 0);
        assert_eq!(keys.metrics().pending_app_deletions, 1);
        assert!(!keys.by_app.contains_key(&app_id));
        assert!(!keys.by_user.contains_key(&user_id));
        assert!(!keys.key_bytes_by_user.contains_key(&user_id));
        assert_eq!(keys.metrics().pending_app_cleanup_keys, 0);

        assert_eq!(keys.process_app_cleanup_batch(1), 0);
        assert_eq!(keys.metrics().pending_app_deletions, 0);
        assert_eq!(keys.metrics().canonical_key_bytes, 0);
    }

    #[test]
    fn legacy_state_lazily_rebuilds_indexes_and_drops_poisoned_keys() {
        #[derive(Serialize)]
        struct Legacy {
            keys: HashMap<(UserId, AiAppId), String>,
        }

        let valid = key(31);
        let mut legacy = HashMap::new();
        legacy.insert((user(1), 1), valid.clone());
        legacy.insert(
            (user(2), 2),
            "-----BEGIN PUBLIC KEY-----\nnot-a-key\n-----END PUBLIC KEY-----\n".to_string(),
        );
        let bytes = msgpack::serialize_to_vec(&Legacy { keys: legacy }).unwrap();
        let mut restored: AiAppUserKeys = msgpack::deserialize_then_unwrap(&bytes);
        assert_eq!(restored.migrate_batch(MIGRATION_BATCH_SIZE, |_| true), 0);
        assert_eq!(restored.remove_by_key(&valid), Ok(1));
        assert_eq!(restored.len(), 0);
        assert_eq!(restored.indexed_public_key_count(), 0);

        let current = msgpack::serialize_to_vec(&restored).unwrap();
        let mut round_tripped: AiAppUserKeys = msgpack::deserialize_then_unwrap(&current);
        assert!(round_tripped.set(user(3), 3, key(32)).is_ok());
        assert_eq!(round_tripped.len(), 1);
    }

    #[test]
    fn legacy_migration_is_bounded_durable_and_fail_closed() {
        #[derive(Serialize)]
        struct Legacy {
            keys: HashMap<(UserId, AiAppId), String>,
        }

        let legacy: HashMap<_, _> = (0..(MIGRATION_BATCH_SIZE * 2 + 1))
            .map(|seed| {
                (
                    (user(seed as u32), seed as AiAppId),
                    format!("-----BEGIN PUBLIC KEY-----\ninvalid-{seed}\n-----END PUBLIC KEY-----\n"),
                )
            })
            .collect();
        let bytes = msgpack::serialize_to_vec(&Legacy { keys: legacy }).unwrap();
        let mut restored: AiAppUserKeys = msgpack::deserialize_then_unwrap(&bytes);

        assert!(restored.migration_required());
        assert!(
            matches!(
                restored.keys_for_users(0, &[user(0)]),
                Err(SetAiAppUserKeyError::MigrationInProgress)
            ),
            "fan-out must fail closed while poisoned legacy keys are isolated"
        );
        assert_eq!(
            restored.migrate_batch(MIGRATION_BATCH_SIZE, |_| true),
            MIGRATION_BATCH_SIZE + 1
        );
        assert_eq!(
            restored.set(user(999), 999, key(999)),
            Err(SetAiAppUserKeyError::MigrationInProgress)
        );
        assert_eq!(restored.metrics().migration_remaining, MIGRATION_BATCH_SIZE + 1);
        assert_eq!(restored.metrics().migration_dropped_keys, MIGRATION_BATCH_SIZE);

        let checkpoint = msgpack::serialize_to_vec(&restored).unwrap();
        let mut resumed: AiAppUserKeys = msgpack::deserialize_then_unwrap(&checkpoint);
        assert_eq!(resumed.metrics().migration_remaining, MIGRATION_BATCH_SIZE + 1);
        assert_eq!(resumed.migrate_batch(MIGRATION_BATCH_SIZE, |_| true), 1);
        assert_eq!(resumed.migrate_batch(MIGRATION_BATCH_SIZE, |_| true), 0);
        assert!(!resumed.migration_required());
        assert_eq!(resumed.metrics().migration_dropped_keys, MIGRATION_BATCH_SIZE * 2 + 1);
        assert!(resumed.set(user(999), 999, key(999)).is_ok());
        let metrics = resumed.metrics();
        assert_eq!(metrics.key_count, 1);
        assert!(metrics.canonical_key_bytes > 0);
    }

    #[test]
    fn legacy_hashmap_migration_drops_keys_for_ineligible_apps() {
        #[derive(Serialize)]
        struct Legacy {
            keys: HashMap<(UserId, AiAppId), String>,
        }

        let legacy = HashMap::from([((user(1), 1), key(30_001)), ((user(2), 2), key(30_002))]);
        let bytes = msgpack::serialize_to_vec(&Legacy { keys: legacy }).unwrap();
        let mut restored: AiAppUserKeys = msgpack::deserialize_then_unwrap(&bytes);
        assert_eq!(restored.migrate_batch(MIGRATION_BATCH_SIZE, |app_id| app_id == 1), 0);
        assert_eq!(restored.metrics().migration_dropped_keys, 1);
        assert_eq!(restored.keys_for_users(1, &[user(1)]).unwrap().len(), 1);
        assert!(restored.keys_for_users(2, &[user(2)]).unwrap().is_empty());
    }

    #[test]
    fn app_claim_rebind_advances_the_epoch_even_when_the_public_key_is_reused() {
        let mut keys = AiAppUserKeys::default();
        let public_key = key(77);
        keys.claim_canonical(user(1), 7, public_key.clone()).unwrap();
        assert_eq!(keys.binding_version(user(1), 7), Some(1));

        keys.claim_canonical(user(1), 7, public_key).unwrap();
        assert_eq!(keys.binding_version(user(1), 7), Some(2));
        assert_eq!(keys.keys_for_user(user(1)).unwrap()[0].key_version, 2);
    }

    #[test]
    fn quarantined_app_cleanup_queued_during_legacy_migration_is_durable_and_bounded() {
        #[derive(Serialize)]
        struct Legacy {
            keys: HashMap<(UserId, AiAppId), String>,
        }

        let quarantined_app = 7;
        let legacy = Legacy {
            keys: HashMap::from([
                ((user(1), quarantined_app), key(35_001)),
                ((user(2), quarantined_app), key(35_002)),
                ((user(3), 8), key(35_003)),
            ]),
        };
        let bytes = msgpack::serialize_to_vec(&legacy).unwrap();
        let mut restored: AiAppUserKeys = msgpack::deserialize_then_unwrap(&bytes);
        restored.queue_quarantined_app_cleanup(quarantined_app);

        let checkpoint = msgpack::serialize_to_vec(&restored).unwrap();
        let mut resumed: AiAppUserKeys = msgpack::deserialize_then_unwrap(&checkpoint);
        assert_eq!(resumed.metrics().pending_app_deletions, 1);
        assert_eq!(resumed.migrate_batch(MIGRATION_BATCH_SIZE, |_| true), 0);
        assert!(
            resumed
                .keys_for_users(quarantined_app, &[user(1), user(2)])
                .unwrap()
                .is_empty(),
            "the durable cleanup marker must hide rows even if a migration callback retained them"
        );
        assert_eq!(resumed.metrics().migration_dropped_keys, 2);
        assert_eq!(resumed.process_app_cleanup_batch(1), 0);
        assert_eq!(resumed.metrics().pending_app_deletions, 0);
        assert_eq!(resumed.keys_for_user(user(3)).unwrap().len(), 1);
    }

    #[test]
    fn account_deleted_before_legacy_migration_cannot_have_keys_revived_after_upgrade() {
        #[derive(Serialize)]
        struct Legacy {
            keys: HashMap<(UserId, AiAppId), String>,
        }

        let deleted = user(1);
        let survivor = user(2);
        let legacy = Legacy {
            keys: HashMap::from([
                ((deleted, 7), key(40_001)),
                ((deleted, 8), key(40_002)),
                ((survivor, 7), key(40_003)),
            ]),
        };
        let bytes = msgpack::serialize_to_vec(&legacy).unwrap();
        let mut restored: AiAppUserKeys = msgpack::deserialize_then_unwrap(&bytes);

        assert_eq!(restored.remove_user(deleted), 0, "legacy keys are not indexed yet");
        let checkpoint = msgpack::serialize_to_vec(&restored).unwrap();
        let mut resumed: AiAppUserKeys = msgpack::deserialize_then_unwrap(&checkpoint);
        assert_eq!(resumed.migrate_batch(MIGRATION_BATCH_SIZE, |_| true), 0);

        assert!(resumed.keys_for_user(deleted).unwrap().is_empty());
        assert_eq!(resumed.binding_epoch(deleted, 7), 1);
        assert_eq!(resumed.binding_epoch(deleted, 8), 1);
        assert_eq!(resumed.keys_for_user(survivor).unwrap().len(), 1);
    }
}
