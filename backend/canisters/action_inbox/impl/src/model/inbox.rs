use crate::memory::{
    Memory, get_action_expiry_memory, get_action_key_stats_memory, get_actions_memory, get_idempotency_tombstone_expiry_memory,
    get_idempotency_tombstones_memory,
};
use action_inbox_canister::actions::{
    MAX_QUERY_RESPONSE_ENCODED_BYTES, Response as ActionsResponse, StoredAction, SuccessResult as ActionsSuccessResult,
};
use ic_stable_structures::storable::Bound;
use ic_stable_structures::{StableBTreeMap, Storable};
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use std::borrow::Cow;
use std::collections::{BTreeMap, HashSet};
use std::io::{self, Write};
use types::TimestampMillis;

pub const ACTION_RETENTION_MILLIS: TimestampMillis = 30 * 24 * 60 * 60 * 1000;
pub const MAX_ACTIONS_PER_KEY: usize = 1_000;
pub const MAX_TOTAL_ACTIONS: usize = 100_000;
pub const MAX_CIPHERTEXT_BYTES: usize = 64 * 1024;
pub const MAX_BYTES_PER_KEY: u64 = 4 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_SEEN_IDEMPOTENCY_KEYS: usize = 200_000;
pub const MAX_EXPIRED_TOMBSTONES_PRUNED_PER_CALL: usize = 1_000;
pub const MAX_EXPIRED_ACTIONS_PRUNED_PER_CALL: usize = 1_000;
pub const MAX_MIGRATION_ITEMS_PER_STEP: usize = 500;
const MAX_STABLE_ACTION_BYTES: u32 = (MAX_CIPHERTEXT_BYTES + 1024) as u32;
const CURRENT_INDEX_SCHEMA_VERSION: u8 = 1;

#[derive(Serialize, Deserialize, Clone)]
struct StableActionValue {
    action: StoredAction,
    received_at: TimestampMillis,
}

/// Exact committed pre-PR2 heap record. It cannot be promoted to a v4 record because the old
/// schema did not carry the app/revision, full card identity, payload/context commitments,
/// signature version/key id, or acknowledgement capability.
#[derive(Deserialize)]
struct LegacyHeapAction {
    #[allow(dead_code)]
    id: u64,
    #[allow(dead_code)]
    ephemeral_public_key: ByteBuf,
    #[allow(dead_code)]
    ciphertext: ByteBuf,
    #[allow(dead_code)]
    oc_signature: ByteBuf,
    #[allow(dead_code)]
    created_at: TimestampMillis,
}

impl Storable for StableActionValue {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(msgpack::serialize_to_vec(self).unwrap())
    }

    fn into_bytes(self) -> Vec<u8> {
        msgpack::serialize_to_vec(&self).unwrap()
    }

    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        msgpack::deserialize_then_unwrap(bytes.as_ref())
    }

    const BOUND: Bound = Bound::Bounded {
        max_size: MAX_STABLE_ACTION_BYTES,
        is_fixed_size: false,
    };
}

#[derive(Clone, Copy, Eq, Ord, PartialEq, PartialOrd)]
struct StableActionKey([u8; 40]);

impl StableActionKey {
    fn new(fingerprint: &[u8], id: u64) -> Self {
        let mut bytes = [0; 40];
        bytes[..32].copy_from_slice(fingerprint);
        bytes[32..].copy_from_slice(&id.to_be_bytes());
        Self(bytes)
    }

    fn id(&self) -> u64 {
        u64::from_be_bytes(self.0[32..].try_into().unwrap())
    }
}

impl Storable for StableActionKey {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Borrowed(&self.0)
    }

    fn into_bytes(self) -> Vec<u8> {
        self.0.to_vec()
    }

    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        Self(bytes.as_ref().try_into().expect("stable action key must be 40 bytes"))
    }

    const BOUND: Bound = Bound::Bounded {
        max_size: 40,
        is_fixed_size: true,
    };
}

#[derive(Clone, Copy, Eq, Ord, PartialEq, PartialOrd)]
struct StableActionExpiryKey([u8; 48]);

impl StableActionExpiryKey {
    fn new(received_at: TimestampMillis, action: StableActionKey) -> Self {
        let mut bytes = [0; 48];
        bytes[..8].copy_from_slice(&received_at.to_be_bytes());
        bytes[8..].copy_from_slice(&action.0);
        Self(bytes)
    }

    fn received_at(&self) -> TimestampMillis {
        u64::from_be_bytes(self.0[..8].try_into().unwrap())
    }

    fn action(&self) -> StableActionKey {
        StableActionKey(self.0[8..].try_into().unwrap())
    }
}

impl Storable for StableActionExpiryKey {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Borrowed(&self.0)
    }

    fn into_bytes(self) -> Vec<u8> {
        self.0.to_vec()
    }

    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        Self(bytes.as_ref().try_into().expect("stable action expiry key must be 48 bytes"))
    }

    const BOUND: Bound = Bound::Bounded {
        max_size: 48,
        is_fixed_size: true,
    };
}

#[derive(Clone, Copy, Default, Eq, PartialEq)]
struct StableKeyStats {
    count: u64,
    bytes: u64,
}

impl Storable for StableKeyStats {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let mut bytes = [0; 16];
        bytes[..8].copy_from_slice(&self.count.to_be_bytes());
        bytes[8..].copy_from_slice(&self.bytes.to_be_bytes());
        Cow::Owned(bytes.to_vec())
    }

    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }

    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        let bytes: [u8; 16] = bytes.as_ref().try_into().expect("stable action key stats must be 16 bytes");
        Self {
            count: u64::from_be_bytes(bytes[..8].try_into().unwrap()),
            bytes: u64::from_be_bytes(bytes[8..].try_into().unwrap()),
        }
    }

    const BOUND: Bound = Bound::Bounded {
        max_size: 16,
        is_fixed_size: true,
    };
}

#[derive(Clone, Copy, Eq, Hash, Ord, PartialEq, PartialOrd)]
struct StableTombstoneKey([u8; 64]);

impl StableTombstoneKey {
    fn new(fingerprint: &[u8], idempotency_key: &[u8]) -> Self {
        let mut bytes = [0; 64];
        bytes[..32].copy_from_slice(fingerprint);
        bytes[32..].copy_from_slice(idempotency_key);
        Self(bytes)
    }
}

impl Storable for StableTombstoneKey {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Borrowed(&self.0)
    }

    fn into_bytes(self) -> Vec<u8> {
        self.0.to_vec()
    }

    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        Self(bytes.as_ref().try_into().expect("stable tombstone key must be 64 bytes"))
    }

    const BOUND: Bound = Bound::Bounded {
        max_size: 64,
        is_fixed_size: true,
    };
}

#[derive(Clone, Copy, Eq, PartialEq)]
struct StableTombstoneValue {
    seen_at: TimestampMillis,
    semantic_commitment: [u8; 32],
}

impl Storable for StableTombstoneValue {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let mut bytes = [0u8; 40];
        bytes[..8].copy_from_slice(&self.seen_at.to_be_bytes());
        bytes[8..].copy_from_slice(&self.semantic_commitment);
        Cow::Owned(bytes.to_vec())
    }

    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }

    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        let bytes: [u8; 40] = bytes.as_ref().try_into().expect("stable tombstone value must be 40 bytes");
        Self {
            seen_at: u64::from_be_bytes(bytes[..8].try_into().unwrap()),
            semantic_commitment: bytes[8..].try_into().unwrap(),
        }
    }

    const BOUND: Bound = Bound::Bounded {
        max_size: 40,
        is_fixed_size: true,
    };
}

#[derive(Clone, Copy, Eq, Ord, PartialEq, PartialOrd)]
struct StableTombstoneExpiryKey([u8; 72]);

impl StableTombstoneExpiryKey {
    fn new(seen_at: TimestampMillis, tombstone: StableTombstoneKey) -> Self {
        let mut bytes = [0; 72];
        bytes[..8].copy_from_slice(&seen_at.to_be_bytes());
        bytes[8..].copy_from_slice(&tombstone.0);
        Self(bytes)
    }

    fn seen_at(&self) -> TimestampMillis {
        u64::from_be_bytes(self.0[..8].try_into().unwrap())
    }

    fn tombstone(&self) -> StableTombstoneKey {
        StableTombstoneKey(self.0[8..].try_into().unwrap())
    }
}

impl Storable for StableTombstoneExpiryKey {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Borrowed(&self.0)
    }

    fn into_bytes(self) -> Vec<u8> {
        self.0.to_vec()
    }

    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        Self(
            bytes
                .as_ref()
                .try_into()
                .expect("stable tombstone expiry key must be 72 bytes"),
        )
    }

    const BOUND: Bound = Bound::Bounded {
        max_size: 72,
        is_fixed_size: true,
    };
}

#[derive(Clone, Copy)]
struct InboxLimits {
    max_actions_per_key: usize,
    max_total_actions: usize,
    max_bytes_per_key: u64,
    max_total_bytes: u64,
    max_seen_idempotency_keys: usize,
    max_expired_tombstones_pruned_per_call: usize,
    max_expired_actions_pruned_per_call: usize,
    max_migration_items_per_step: usize,
}

fn production_limits() -> InboxLimits {
    InboxLimits {
        max_actions_per_key: MAX_ACTIONS_PER_KEY,
        max_total_actions: MAX_TOTAL_ACTIONS,
        max_bytes_per_key: MAX_BYTES_PER_KEY,
        max_total_bytes: MAX_TOTAL_BYTES,
        max_seen_idempotency_keys: MAX_SEEN_IDEMPOTENCY_KEYS,
        max_expired_tombstones_pruned_per_call: MAX_EXPIRED_TOMBSTONES_PRUNED_PER_CALL,
        max_expired_actions_pruned_per_call: MAX_EXPIRED_ACTIONS_PRUNED_PER_CALL,
        max_migration_items_per_step: MAX_MIGRATION_ITEMS_PER_STEP,
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
enum MigrationPhase {
    #[default]
    StableActions,
    Complete,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
struct MigrationState {
    phase: MigrationPhase,
    stable_action_cursor: Option<Vec<u8>>,
    stable_actions_indexed: u64,
    items_processed: u64,
    steps: u64,
    last_step_items: u32,
    last_step_saturated: bool,
}

#[derive(Clone)]
pub struct PendingAction {
    pub fingerprint: Vec<u8>,
    pub idempotency_key: ByteBuf,
    pub payload_hash: ByteBuf,
    pub card_context_hash: ByteBuf,
    pub app_id: types::AiAppId,
    pub app_revision: TimestampMillis,
    pub action_id: String,
    pub acknowledgement_secret_hash: ByteBuf,
    pub ephemeral_public_key: ByteBuf,
    pub ciphertext: ByteBuf,
    pub signature_version: u16,
    pub signing_key_id: ByteBuf,
    pub oc_signature: ByteBuf,
    pub created_at: TimestampMillis,
}

#[derive(Debug, Eq, PartialEq)]
pub enum DepositBatchError {
    MigrationInProgress,
    IdempotencyConflict,
    TombstoneCapacity {
        required: usize,
        available: usize,
    },
    ActionCountCapacity {
        scope: ActionCapacityScope,
        required: usize,
        available: usize,
    },
    ActionByteCapacity {
        scope: ActionCapacityScope,
        required: u64,
        available: u64,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActionCapacityScope {
    ConsumerKey,
    App,
}

/// Ciphertext lives in stable memory 1. Tombstone membership and expiry order live in stable
/// memories 2 and 3; action expiry and per-key accounting live in memories 4 and 5. The tombstone
/// itself is keyed by the full 32-byte identity and stores the signed 32-byte card-context
/// commitment. That commitment binds actor, app/revision/action, payload, content, and immutable
/// reservation generation while allowing ciphertext re-encryption. Memory 0 contains only
/// serialized control state. Stable-action index rebuilding is the sole forward migration supported
/// by this unshipped PR2 schema.
#[derive(Serialize, Deserialize)]
pub struct Inbox {
    // Read the exact committed heap schema solely so post-upgrade can reject a non-empty source
    // instead of silently dropping pending actions or replay history. New snapshots never write
    // these fields.
    #[serde(default, rename = "actions", skip_serializing)]
    legacy_heap_actions: BTreeMap<Vec<u8>, Vec<LegacyHeapAction>>,
    #[serde(default, rename = "seen", skip_serializing)]
    legacy_heap_seen: HashSet<(Vec<u8>, u64)>,
    #[serde(skip, default = "init_stable_actions")]
    stable_actions: StableBTreeMap<StableActionKey, StableActionValue, Memory>,
    #[serde(skip, default = "init_stable_tombstones")]
    stable_tombstones: StableBTreeMap<StableTombstoneKey, StableTombstoneValue, Memory>,
    #[serde(skip, default = "init_stable_tombstone_expiry")]
    stable_tombstone_expiry: StableBTreeMap<StableTombstoneExpiryKey, u8, Memory>,
    #[serde(skip, default = "init_stable_action_expiry")]
    stable_action_expiry: StableBTreeMap<StableActionExpiryKey, u8, Memory>,
    #[serde(skip, default = "init_stable_key_stats")]
    stable_key_stats: StableBTreeMap<[u8; 32], StableKeyStats, Memory>,
    #[serde(skip, default = "production_limits")]
    limits: InboxLimits,
    #[serde(default)]
    index_schema_version: u8,
    #[serde(default)]
    migration: MigrationState,
    #[serde(default)]
    total_action_count: u64,
    #[serde(default)]
    total_action_bytes: u64,
    #[serde(default)]
    keys_at_action_count_capacity: u64,
    #[serde(default)]
    keys_at_action_byte_capacity: u64,
    next_id: u64,
}

impl Default for Inbox {
    fn default() -> Self {
        Self::with_stable_storage(
            StableBTreeMap::init(get_actions_memory()),
            StableBTreeMap::init(get_idempotency_tombstones_memory()),
            StableBTreeMap::init(get_idempotency_tombstone_expiry_memory()),
            StableBTreeMap::init(get_action_expiry_memory()),
            StableBTreeMap::init(get_action_key_stats_memory()),
            production_limits(),
        )
    }
}

fn init_stable_actions() -> StableBTreeMap<StableActionKey, StableActionValue, Memory> {
    StableBTreeMap::init(get_actions_memory())
}

fn init_stable_tombstones() -> StableBTreeMap<StableTombstoneKey, StableTombstoneValue, Memory> {
    StableBTreeMap::init(get_idempotency_tombstones_memory())
}

fn init_stable_tombstone_expiry() -> StableBTreeMap<StableTombstoneExpiryKey, u8, Memory> {
    StableBTreeMap::init(get_idempotency_tombstone_expiry_memory())
}

fn init_stable_action_expiry() -> StableBTreeMap<StableActionExpiryKey, u8, Memory> {
    StableBTreeMap::init(get_action_expiry_memory())
}

fn init_stable_key_stats() -> StableBTreeMap<[u8; 32], StableKeyStats, Memory> {
    StableBTreeMap::init(get_action_key_stats_memory())
}

pub struct AcknowledgeResult {
    pub removed: usize,
    pub remaining: usize,
}

impl Inbox {
    fn with_stable_storage(
        stable_actions: StableBTreeMap<StableActionKey, StableActionValue, Memory>,
        stable_tombstones: StableBTreeMap<StableTombstoneKey, StableTombstoneValue, Memory>,
        stable_tombstone_expiry: StableBTreeMap<StableTombstoneExpiryKey, u8, Memory>,
        stable_action_expiry: StableBTreeMap<StableActionExpiryKey, u8, Memory>,
        stable_key_stats: StableBTreeMap<[u8; 32], StableKeyStats, Memory>,
        limits: InboxLimits,
    ) -> Self {
        Self {
            legacy_heap_actions: BTreeMap::new(),
            legacy_heap_seen: HashSet::new(),
            stable_actions,
            stable_tombstones,
            stable_tombstone_expiry,
            stable_action_expiry,
            stable_key_stats,
            limits,
            index_schema_version: CURRENT_INDEX_SCHEMA_VERSION,
            migration: MigrationState {
                phase: MigrationPhase::Complete,
                ..Default::default()
            },
            total_action_count: 0,
            total_action_bytes: 0,
            keys_at_action_count_capacity: 0,
            keys_at_action_byte_capacity: 0,
            next_id: 0,
        }
    }

    pub fn deposit_batch(
        &mut self,
        deposits: Vec<PendingAction>,
        received_at: TimestampMillis,
    ) -> Result<usize, DepositBatchError> {
        assert!(
            deposits.iter().all(|deposit| {
                deposit.fingerprint.len() == 32
                    && deposit.idempotency_key.len() == 32
                    && deposit.payload_hash.len() == 32
                    && deposit.card_context_hash.len() == 32
            }),
            "consumer fingerprint, idempotency key, payload hash, and card context hash must be 32 bytes"
        );
        if self.migration_in_progress() {
            self.run_migration_step(received_at);
            return Err(DepositBatchError::MigrationInProgress);
        }
        self.prune(received_at);

        let mut distinct_unseen = HashSet::new();
        let mut batch_commitments: BTreeMap<StableTombstoneKey, [u8; 32]> = BTreeMap::new();
        let mut pending_by_key: BTreeMap<Vec<u8>, (usize, u64)> = BTreeMap::new();
        for deposit in &deposits {
            let tombstone = StableTombstoneKey::new(&deposit.fingerprint, &deposit.idempotency_key);
            let supplied_commitment: [u8; 32] = deposit.card_context_hash.as_ref().try_into().unwrap();
            if let Some(existing) = self.stable_tombstones.get(&tombstone) {
                if existing.semantic_commitment == supplied_commitment {
                    continue;
                }
                return Err(DepositBatchError::IdempotencyConflict);
            }
            if let Some(existing) = batch_commitments.insert(tombstone, supplied_commitment)
                && existing != supplied_commitment
            {
                return Err(DepositBatchError::IdempotencyConflict);
            }
            if distinct_unseen.insert(tombstone) {
                let entry = pending_by_key.entry(deposit.fingerprint.clone()).or_default();
                entry.0 += 1;
                entry.1 = entry.1.saturating_add(pending_action_storage_bytes(deposit));
            }
        }
        let required = distinct_unseen.len();
        let available = self.remaining_tombstone_capacity();
        if required > available {
            return Err(DepositBatchError::TombstoneCapacity { required, available });
        }

        for (fingerprint, (required_count, required_bytes)) in &pending_by_key {
            let available_count = self.remaining_action_count_capacity_for_key(fingerprint);
            if *required_count > available_count {
                return Err(DepositBatchError::ActionCountCapacity {
                    scope: ActionCapacityScope::ConsumerKey,
                    required: *required_count,
                    available: available_count,
                });
            }
            let available_bytes = self.remaining_action_byte_capacity_for_key(fingerprint);
            if *required_bytes > available_bytes {
                return Err(DepositBatchError::ActionByteCapacity {
                    scope: ActionCapacityScope::ConsumerKey,
                    required: *required_bytes,
                    available: available_bytes,
                });
            }
        }
        let required_count = distinct_unseen.len();
        let available_count = self.remaining_action_count_capacity();
        if required_count > available_count {
            return Err(DepositBatchError::ActionCountCapacity {
                scope: ActionCapacityScope::App,
                required: required_count,
                available: available_count,
            });
        }
        let required_bytes = pending_by_key.values().map(|(_, bytes)| *bytes).sum::<u64>();
        let available_bytes = self.remaining_action_byte_capacity();
        if required_bytes > available_bytes {
            return Err(DepositBatchError::ActionByteCapacity {
                scope: ActionCapacityScope::App,
                required: required_bytes,
                available: available_bytes,
            });
        }

        let mut inserted = 0;
        for deposit in deposits {
            let tombstone = StableTombstoneKey::new(&deposit.fingerprint, &deposit.idempotency_key);
            let semantic_commitment: [u8; 32] = deposit.card_context_hash.as_ref().try_into().unwrap();
            if !self.insert_tombstone(tombstone, received_at, semantic_commitment) {
                continue;
            }
            self.next_id = self.next_id.checked_add(1).expect("action inbox id space exhausted");
            let action = StoredAction {
                id: self.next_id,
                app_id: deposit.app_id,
                app_revision: deposit.app_revision,
                action_id: deposit.action_id,
                consumer_key_fingerprint: ByteBuf::from(deposit.fingerprint.clone()),
                idempotency_key: deposit.idempotency_key,
                payload_hash: deposit.payload_hash,
                card_context_hash: deposit.card_context_hash,
                acknowledgement_secret_hash: deposit.acknowledgement_secret_hash,
                ephemeral_public_key: deposit.ephemeral_public_key,
                ciphertext: deposit.ciphertext,
                signature_version: deposit.signature_version,
                signing_key_id: deposit.signing_key_id,
                oc_signature: deposit.oc_signature,
                created_at: deposit.created_at,
            };
            let bytes = action_storage_bytes(&action);
            let value = StableActionValue {
                action: action.clone(),
                received_at,
            };
            assert!(
                self.stable_actions
                    .insert(StableActionKey::new(&deposit.fingerprint, action.id), value)
                    .is_none(),
                "action id already exists in stable storage"
            );
            self.index_stable_action(StableActionKey::new(&deposit.fingerprint, action.id), received_at, bytes);
            inserted += 1;
        }
        Ok(inserted)
    }

    pub fn query(&self, fingerprint: &[u8], since_id: u64, max_results: usize, now: TimestampMillis) -> Vec<StoredAction> {
        if self.migration_in_progress() || since_id == u64::MAX {
            return Vec::new();
        }
        let mut result = Vec::new();
        let mut encoded_bytes = msgpack_encoded_size(&ActionsResponse::Success(ActionsSuccessResult { actions: Vec::new() }));
        let start = StableActionKey::new(fingerprint, since_id + 1);
        let end = StableActionKey::new(fingerprint, u64::MAX);
        for entry in self.stable_actions.range(start..=end).take(self.limits.max_actions_per_key) {
            if result.len() >= max_results {
                break;
            }
            let (_, value) = entry.into_pair();
            if now.saturating_sub(value.received_at) > ACTION_RETENTION_MILLIS {
                continue;
            }
            let action = value.action;
            let next_encoded_bytes = encoded_query_response_size_with_action(encoded_bytes, result.len(), &action);
            if next_encoded_bytes > MAX_QUERY_RESPONSE_ENCODED_BYTES {
                break;
            }
            result.push(action);
            encoded_bytes = next_encoded_bytes;
        }
        result
    }

    pub fn acknowledge_exact(&mut self, fingerprint: &[u8], action_id: u64) -> AcknowledgeResult {
        if self.migration_in_progress() {
            return AcknowledgeResult {
                removed: 0,
                remaining: 0,
            };
        }
        let removed = usize::from(self.remove_stable_action(StableActionKey::new(fingerprint, action_id)));
        let remaining = self.key_stats(fingerprint).count.min(usize::MAX as u64) as usize;
        AcknowledgeResult { removed, remaining }
    }

    /// Returns the current queue length only when this exact action is absent. This is a
    /// cheap index lookup used before acknowledgement-secret validation and hashing on the public
    /// endpoint, preventing empty/random queues from doing unnecessary capability work.
    pub fn remaining_if_action_missing(&self, fingerprint: &[u8], action_id: u64) -> Option<usize> {
        if self.migration_in_progress() {
            return None;
        }
        self.stable_actions
            .get(&StableActionKey::new(fingerprint, action_id))
            .is_none()
            .then(|| self.key_stats(fingerprint).count.min(usize::MAX as u64) as usize)
    }

    /// Returns the fixed-size secret hash for one exact live action. A missing action, a legacy
    /// record without a hash, or a partial migration all fail closed.
    pub fn acknowledgement_secret_hash(&self, fingerprint: &[u8], action_id: u64) -> Option<[u8; 32]> {
        if self.migration_in_progress() {
            return None;
        }
        let value = self.stable_actions.get(&StableActionKey::new(fingerprint, action_id))?;
        value.action.acknowledgement_secret_hash.as_ref().try_into().ok()
    }

    pub fn prune(&mut self, now: TimestampMillis) {
        if self.migration_in_progress() {
            self.run_migration_step(now);
            return;
        }
        self.prune_expired_actions(now, self.limits.max_expired_actions_pruned_per_call);
        self.prune_expired_tombstones(now, self.limits.max_expired_tombstones_pruned_per_call);
    }

    /// Post-upgrade setup is O(1). Stable indexes survive once schema version 1 has completed; older
    /// states retain a durable phase/cursor and are advanced only by bounded update/timer work.
    pub fn prepare_after_upgrade(&mut self) -> Result<(), String> {
        if !self.legacy_heap_actions.is_empty() || !self.legacy_heap_seen.is_empty() {
            return Err(format!(
                "refusing ActionInbox upgrade with {} legacy heap action buckets and {} legacy replay entries; drain or explicitly export/replace the pre-v4 inbox first",
                self.legacy_heap_actions.len(),
                self.legacy_heap_seen.len(),
            ));
        }
        if self.index_schema_version < CURRENT_INDEX_SCHEMA_VERSION && self.migration.phase == MigrationPhase::Complete {
            self.migration = MigrationState::default();
        }
        Ok(())
    }

    pub fn run_migration_step(&mut self, _now: TimestampMillis) -> usize {
        if !self.migration_in_progress() {
            return 0;
        }
        let budget = self.limits.max_migration_items_per_step;
        let mut processed = 0usize;
        while processed < budget && self.migration_in_progress() {
            match self.migration.phase {
                MigrationPhase::StableActions => {
                    let next = if let Some(cursor) = self.migration.stable_action_cursor.as_deref() {
                        let cursor = StableActionKey(cursor.try_into().expect("migration cursor must be 40 bytes"));
                        self.stable_actions.range(cursor..).nth(1).map(|entry| entry.into_pair())
                    } else {
                        self.stable_actions.first_key_value()
                    };
                    let Some((key, value)) = next else {
                        self.migration.phase = MigrationPhase::Complete;
                        self.migration.stable_action_cursor = None;
                        self.index_schema_version = CURRENT_INDEX_SCHEMA_VERSION;
                        continue;
                    };
                    self.next_id = self.next_id.max(key.id());
                    if self.index_stable_action(key, value.received_at, action_storage_bytes(&value.action)) {
                        self.migration.stable_actions_indexed = self.migration.stable_actions_indexed.saturating_add(1);
                    }
                    self.migration.stable_action_cursor = Some(key.0.to_vec());
                    processed += 1;
                }
                MigrationPhase::Complete => break,
            }
        }
        self.migration.steps = self.migration.steps.saturating_add(1);
        self.migration.items_processed = self.migration.items_processed.saturating_add(processed as u64);
        self.migration.last_step_items = processed.min(u32::MAX as usize) as u32;
        self.migration.last_step_saturated = processed == budget && self.migration_in_progress();
        processed
    }

    pub fn migration_in_progress(&self) -> bool {
        self.index_schema_version < CURRENT_INDEX_SCHEMA_VERSION || self.migration.phase != MigrationPhase::Complete
    }

    pub fn migration_phase(&self) -> &'static str {
        match self.migration.phase {
            MigrationPhase::StableActions => "stable_actions",
            MigrationPhase::Complete => "complete",
        }
    }

    pub fn migration_items_processed(&self) -> u64 {
        self.migration.items_processed
    }

    pub fn migration_steps(&self) -> u64 {
        self.migration.steps
    }

    pub fn migration_last_step_items(&self) -> u32 {
        self.migration.last_step_items
    }

    pub fn migration_last_step_saturated(&self) -> bool {
        self.migration.last_step_saturated
    }

    pub fn migration_stable_actions_indexed(&self) -> u64 {
        self.migration.stable_actions_indexed
    }

    pub fn stable_action_count(&self) -> u64 {
        self.stable_actions.len()
    }

    pub fn action_count(&self) -> usize {
        self.total_action_count.min(usize::MAX as u64) as usize
    }

    pub fn total_bytes(&self) -> u64 {
        self.total_action_bytes
    }

    pub fn bytes_for_key(&self, fingerprint: &[u8]) -> u64 {
        self.key_stats(fingerprint).bytes
    }

    pub fn key_count(&self) -> usize {
        self.stable_key_stats.len().min(usize::MAX as u64) as usize
    }

    pub fn remaining_action_count_capacity(&self) -> usize {
        self.limits.max_total_actions.saturating_sub(self.action_count())
    }

    pub fn remaining_action_byte_capacity(&self) -> u64 {
        self.limits.max_total_bytes.saturating_sub(self.total_bytes())
    }

    pub fn action_count_capacity_saturated(&self) -> bool {
        self.remaining_action_count_capacity() == 0
    }

    pub fn action_byte_capacity_saturated(&self) -> bool {
        self.remaining_action_byte_capacity() == 0
    }

    pub fn keys_at_action_count_capacity(&self) -> usize {
        self.keys_at_action_count_capacity.min(usize::MAX as u64) as usize
    }

    pub fn keys_at_action_byte_capacity(&self) -> usize {
        self.keys_at_action_byte_capacity.min(usize::MAX as u64) as usize
    }

    pub fn seen_count(&self) -> usize {
        self.stable_tombstones.len() as usize
    }

    pub fn remaining_tombstone_capacity(&self) -> usize {
        self.limits.max_seen_idempotency_keys.saturating_sub(self.seen_count())
    }

    pub fn tombstone_capacity_saturated(&self) -> bool {
        self.remaining_tombstone_capacity() == 0
    }

    fn remaining_action_count_capacity_for_key(&self, fingerprint: &[u8]) -> usize {
        self.limits
            .max_actions_per_key
            .saturating_sub(self.key_stats(fingerprint).count.min(usize::MAX as u64) as usize)
    }

    fn remaining_action_byte_capacity_for_key(&self, fingerprint: &[u8]) -> u64 {
        self.limits.max_bytes_per_key.saturating_sub(self.bytes_for_key(fingerprint))
    }

    fn insert_tombstone(&mut self, key: StableTombstoneKey, seen_at: TimestampMillis, semantic_commitment: [u8; 32]) -> bool {
        if self.stable_tombstones.get(&key).is_some() {
            return false;
        }
        assert!(
            self.stable_tombstones
                .insert(
                    key,
                    StableTombstoneValue {
                        seen_at,
                        semantic_commitment,
                    },
                )
                .is_none(),
            "new tombstone unexpectedly replaced an existing entry"
        );
        assert!(
            self.stable_tombstone_expiry
                .insert(StableTombstoneExpiryKey::new(seen_at, key), 0)
                .is_none(),
            "tombstone expiry index already contains a new tombstone"
        );
        true
    }

    fn prune_expired_tombstones(&mut self, now: TimestampMillis, max_to_prune: usize) -> usize {
        let mut pruned = 0;
        while pruned < max_to_prune {
            let Some(expiry_key) = self.stable_tombstone_expiry.first_key_value().map(|(key, _)| key) else {
                break;
            };
            let seen_at = expiry_key.seen_at();
            if now.saturating_sub(seen_at) <= ACTION_RETENTION_MILLIS {
                break;
            }
            self.stable_tombstone_expiry.remove(&expiry_key);
            let tombstone = expiry_key.tombstone();
            if self
                .stable_tombstones
                .get(&tombstone)
                .is_some_and(|value| value.seen_at == seen_at)
            {
                self.stable_tombstones.remove(&tombstone);
            }
            pruned += 1;
        }
        pruned
    }

    fn prune_expired_actions(&mut self, now: TimestampMillis, max_to_prune: usize) -> usize {
        let mut pruned = 0;
        while pruned < max_to_prune {
            let Some(expiry_key) = self.stable_action_expiry.first_key_value().map(|(key, _)| key) else {
                break;
            };
            if now.saturating_sub(expiry_key.received_at()) <= ACTION_RETENTION_MILLIS {
                break;
            }
            let action_key = expiry_key.action();
            if self
                .stable_actions
                .get(&action_key)
                .is_some_and(|value| value.received_at == expiry_key.received_at())
            {
                self.remove_stable_action(action_key);
            } else {
                self.stable_action_expiry.remove(&expiry_key);
            }
            pruned += 1;
        }
        pruned
    }

    fn index_stable_action(&mut self, key: StableActionKey, received_at: TimestampMillis, bytes: u64) -> bool {
        let expiry_key = StableActionExpiryKey::new(received_at, key);
        if self.stable_action_expiry.get(&expiry_key).is_some() {
            return false;
        }
        self.stable_action_expiry.insert(expiry_key, 0);
        let fingerprint: [u8; 32] = key.0[..32].try_into().unwrap();
        let mut stats = self.stable_key_stats.get(&fingerprint).unwrap_or_default();
        stats.count = stats.count.saturating_add(1);
        stats.bytes = stats.bytes.saturating_add(bytes);
        self.set_key_stats(fingerprint, stats);
        self.total_action_count = self.total_action_count.saturating_add(1);
        self.total_action_bytes = self.total_action_bytes.saturating_add(bytes);
        true
    }

    fn remove_stable_action(&mut self, key: StableActionKey) -> bool {
        let Some(value) = self.stable_actions.remove(&key) else {
            return false;
        };
        let bytes = action_storage_bytes(&value.action);
        self.stable_action_expiry
            .remove(&StableActionExpiryKey::new(value.received_at, key));
        let fingerprint: [u8; 32] = key.0[..32].try_into().unwrap();
        let mut stats = self.stable_key_stats.get(&fingerprint).unwrap_or_default();
        stats.count = stats.count.saturating_sub(1);
        stats.bytes = stats.bytes.saturating_sub(bytes);
        self.set_key_stats(fingerprint, stats);
        self.total_action_count = self.total_action_count.saturating_sub(1);
        self.total_action_bytes = self.total_action_bytes.saturating_sub(bytes);
        true
    }

    fn key_stats(&self, fingerprint: &[u8]) -> StableKeyStats {
        let Ok(fingerprint) = <[u8; 32]>::try_from(fingerprint) else {
            return StableKeyStats::default();
        };
        self.stable_key_stats.get(&fingerprint).unwrap_or_default()
    }

    fn set_key_stats(&mut self, fingerprint: [u8; 32], stats: StableKeyStats) {
        let previous = self.stable_key_stats.get(&fingerprint).unwrap_or_default();
        adjust_saturation_counter(
            &mut self.keys_at_action_count_capacity,
            previous.count >= self.limits.max_actions_per_key as u64,
            stats.count >= self.limits.max_actions_per_key as u64,
        );
        adjust_saturation_counter(
            &mut self.keys_at_action_byte_capacity,
            previous.bytes >= self.limits.max_bytes_per_key,
            stats.bytes >= self.limits.max_bytes_per_key,
        );
        if stats.count == 0 {
            self.stable_key_stats.remove(&fingerprint);
        } else {
            self.stable_key_stats.insert(fingerprint, stats);
        }
    }

    #[cfg(test)]
    pub(crate) fn new_for_test() -> Self {
        Self::new_for_test_with_limits(production_limits())
    }

    #[cfg(test)]
    pub(crate) fn force_incomplete_migration_for_test(&mut self) {
        self.index_schema_version = 0;
        self.migration = MigrationState::default();
        self.limits.max_migration_items_per_step = 0;
    }

    #[cfg(test)]
    pub(crate) fn force_empty_migration_for_test(&mut self) {
        self.index_schema_version = 0;
        self.migration = MigrationState::default();
    }

    #[cfg(test)]
    pub(crate) fn new_for_test_with_tombstone_limits(max_tombstones: usize, max_pruned_per_call: usize) -> Self {
        let mut limits = production_limits();
        limits.max_seen_idempotency_keys = max_tombstones;
        limits.max_expired_tombstones_pruned_per_call = max_pruned_per_call;
        Self::new_for_test_with_limits(limits)
    }

    #[cfg(test)]
    pub(crate) fn new_for_test_with_action_limits(
        max_actions_per_key: usize,
        max_total_actions: usize,
        max_bytes_per_key: u64,
        max_total_bytes: u64,
    ) -> Self {
        let mut limits = production_limits();
        limits.max_actions_per_key = max_actions_per_key;
        limits.max_total_actions = max_total_actions;
        limits.max_bytes_per_key = max_bytes_per_key;
        limits.max_total_bytes = max_total_bytes;
        Self::new_for_test_with_limits(limits)
    }

    #[cfg(test)]
    fn new_for_test_with_limits(limits: InboxLimits) -> Self {
        use ic_stable_structures::DefaultMemoryImpl;
        use ic_stable_structures::memory_manager::{MemoryId, MemoryManager};
        let manager = MemoryManager::init(DefaultMemoryImpl::default());
        Self::with_stable_storage(
            StableBTreeMap::init(manager.get(MemoryId::new(1))),
            StableBTreeMap::init(manager.get(MemoryId::new(2))),
            StableBTreeMap::init(manager.get(MemoryId::new(3))),
            StableBTreeMap::init(manager.get(MemoryId::new(4))),
            StableBTreeMap::init(manager.get(MemoryId::new(5))),
            limits,
        )
    }
}

fn adjust_saturation_counter(counter: &mut u64, was_saturated: bool, is_saturated: bool) {
    match (was_saturated, is_saturated) {
        (false, true) => *counter = counter.saturating_add(1),
        (true, false) => *counter = counter.saturating_sub(1),
        _ => {}
    }
}

fn action_storage_bytes(action: &StoredAction) -> u64 {
    (action.action_id.len()
        + action.consumer_key_fingerprint.len()
        + action.idempotency_key.len()
        + action.payload_hash.len()
        + action.card_context_hash.len()
        + action.acknowledgement_secret_hash.len()
        + action.ephemeral_public_key.len()
        + action.ciphertext.len()
        + action.signing_key_id.len()
        + action.oc_signature.len()
        + 30) as u64
}

fn pending_action_storage_bytes(action: &PendingAction) -> u64 {
    (action.action_id.len()
        + action.fingerprint.len()
        + action.idempotency_key.len()
        + action.payload_hash.len()
        + action.card_context_hash.len()
        + action.ephemeral_public_key.len()
        + action.ciphertext.len()
        + action.signing_key_id.len()
        + action.oc_signature.len()
        + action.acknowledgement_secret_hash.len()
        + 30) as u64
}

struct ByteCounter(usize);

impl Write for ByteCounter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = self.0.saturating_add(bytes.len());
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn msgpack_encoded_size<T: Serialize>(value: &T) -> usize {
    let mut counter = ByteCounter(0);
    msgpack::serialize(value, &mut counter).expect("counting MessagePack bytes must succeed");
    counter.0
}

fn msgpack_array_header_bytes(len: usize) -> usize {
    if len < 16 {
        1
    } else if len <= u16::MAX as usize {
        3
    } else {
        5
    }
}

fn encoded_query_response_size_with_action(
    current_encoded_bytes: usize,
    current_action_count: usize,
    action: &StoredAction,
) -> usize {
    current_encoded_bytes - msgpack_array_header_bytes(current_action_count)
        + msgpack_array_header_bytes(current_action_count + 1)
        + msgpack_encoded_size(action)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(value: u8) -> ByteBuf {
        ByteBuf::from(vec![value; 65])
    }

    fn identity(id: u64) -> ByteBuf {
        let mut value = [0u8; 32];
        value[..8].copy_from_slice(&id.to_be_bytes());
        ByteBuf::from(value.to_vec())
    }

    fn stored_action(id: u64, ciphertext_bytes: usize) -> StoredAction {
        StoredAction {
            id,
            app_id: 1,
            app_revision: 2,
            action_id: "sample.action".to_string(),
            consumer_key_fingerprint: ByteBuf::from(vec![4; 32]),
            idempotency_key: identity(id),
            payload_hash: ByteBuf::from(vec![7; 32]),
            card_context_hash: ByteBuf::from(vec![8; 32]),
            acknowledgement_secret_hash: ByteBuf::from(vec![5; 32]),
            ephemeral_public_key: bytes(1),
            ciphertext: ByteBuf::from(vec![2; ciphertext_bytes]),
            signature_version: ecies_payload::ACTION_INBOX_SIGNATURE_VERSION_V4,
            signing_key_id: ByteBuf::from(vec![9; 32]),
            oc_signature: ByteBuf::from(vec![3; 64]),
            created_at: id,
        }
    }

    fn pending(fingerprint: Vec<u8>, idempotency_id: u64, now: u64, ciphertext_bytes: usize) -> PendingAction {
        PendingAction {
            fingerprint,
            idempotency_key: identity(idempotency_id),
            payload_hash: ByteBuf::from(vec![7; 32]),
            card_context_hash: ByteBuf::from(vec![8; 32]),
            app_id: 1,
            app_revision: 2,
            action_id: "sample.action".to_string(),
            acknowledgement_secret_hash: ByteBuf::from(vec![5; 32]),
            ephemeral_public_key: bytes(1),
            ciphertext: ByteBuf::from(vec![2; ciphertext_bytes]),
            signature_version: ecies_payload::ACTION_INBOX_SIGNATURE_VERSION_V4,
            signing_key_id: ByteBuf::from(vec![9; 32]),
            oc_signature: ByteBuf::from(vec![3; 64]),
            created_at: now,
        }
    }

    fn committed_pending(fingerprint: Vec<u8>, idempotency_id: u64, identity: u8, payload: u8) -> PendingAction {
        let mut action = pending(fingerprint, idempotency_id, 1, 1);
        action.idempotency_key = ByteBuf::from(vec![identity; 32]);
        action.payload_hash = ByteBuf::from(vec![payload; 32]);
        action.card_context_hash = ByteBuf::from(vec![payload; 32]);
        action
    }

    fn deposit(inbox: &mut Inbox, fingerprint: Vec<u8>, idempotency_id: u64, now: u64) -> bool {
        deposit_with_ciphertext(inbox, fingerprint, idempotency_id, now, 1)
    }

    fn deposit_with_ciphertext(
        inbox: &mut Inbox,
        fingerprint: Vec<u8>,
        idempotency_id: u64,
        now: u64,
        ciphertext_bytes: usize,
    ) -> bool {
        try_deposit_with_ciphertext(inbox, fingerprint, idempotency_id, now, ciphertext_bytes).unwrap() == 1
    }

    fn try_deposit_with_ciphertext(
        inbox: &mut Inbox,
        fingerprint: Vec<u8>,
        idempotency_id: u64,
        now: u64,
        ciphertext_bytes: usize,
    ) -> Result<usize, DepositBatchError> {
        inbox.deposit_batch(vec![pending(fingerprint, idempotency_id, now, ciphertext_bytes)], now)
    }

    fn begin_stable_index_migration(inbox: &mut Inbox, budget: usize) {
        while let Some((key, _)) = inbox.stable_action_expiry.first_key_value() {
            inbox.stable_action_expiry.remove(&key);
        }
        while let Some((key, _)) = inbox.stable_key_stats.first_key_value() {
            inbox.stable_key_stats.remove(&key);
        }
        inbox.total_action_count = 0;
        inbox.total_action_bytes = 0;
        inbox.keys_at_action_count_capacity = 0;
        inbox.keys_at_action_byte_capacity = 0;
        inbox.index_schema_version = 0;
        inbox.migration = MigrationState {
            phase: MigrationPhase::StableActions,
            ..Default::default()
        };
        inbox.limits.max_migration_items_per_step = budget;
    }

    #[test]
    fn acknowledgement_removes_only_the_selected_key_and_does_not_resurrect_on_retry() {
        let mut inbox = Inbox::new_for_test();
        let old_key = vec![1; 32];
        let new_key = vec![2; 32];
        assert!(deposit(&mut inbox, old_key.clone(), 10, 1));
        assert!(deposit(&mut inbox, old_key.clone(), 11, 2));
        assert!(deposit(&mut inbox, new_key.clone(), 12, 3));

        let result = inbox.acknowledge_exact(&old_key, 1);
        assert_eq!(result.removed, 1);
        assert_eq!(result.remaining, 1);
        assert_eq!(inbox.query(&old_key, 0, 100, 3).len(), 1);
        assert_eq!(inbox.query(&new_key, 0, 100, 3).len(), 1);
        assert!(
            !deposit(&mut inbox, old_key.clone(), 10, 4),
            "an acknowledged retry stays deduped"
        );

        let result = inbox.acknowledge_exact(&old_key, 2);
        assert_eq!(result.removed, 1);
        assert_eq!(result.remaining, 0);
        assert!(inbox.query(&old_key, 0, 100, 4).is_empty());
        assert_eq!(inbox.query(&new_key, 0, 100, 4).len(), 1);
    }

    #[test]
    fn per_key_count_exact_capacity_succeeds_and_one_over_retains_every_action() {
        let mut inbox = Inbox::new_for_test();
        let key = vec![7; 32];
        for id in 0..MAX_ACTIONS_PER_KEY as u64 {
            assert!(deposit(&mut inbox, key.clone(), id, id));
        }

        assert_eq!(
            try_deposit_with_ciphertext(
                &mut inbox,
                key.clone(),
                MAX_ACTIONS_PER_KEY as u64,
                MAX_ACTIONS_PER_KEY as u64,
                1,
            ),
            Err(DepositBatchError::ActionCountCapacity {
                scope: ActionCapacityScope::ConsumerKey,
                required: 1,
                available: 0,
            })
        );
        let mut actions = Vec::new();
        let mut since_id = 0;
        loop {
            let page = inbox.query(&key, since_id, usize::MAX, MAX_ACTIONS_PER_KEY as u64);
            let Some(last) = page.last() else {
                break;
            };
            since_id = last.id;
            actions.extend(page);
        }
        assert_eq!(actions.len(), MAX_ACTIONS_PER_KEY);
        assert_eq!(actions.first().unwrap().id, 1);
        assert_eq!(actions.last().unwrap().id, MAX_ACTIONS_PER_KEY as u64);
    }

    #[test]
    fn expired_actions_are_hidden_and_cleaned_while_dedupe_tombstones_remain_bounded() {
        let mut inbox = Inbox::new_for_test();
        let key = vec![9; 32];
        assert!(deposit(&mut inbox, key.clone(), 99, 1));
        let after_retention = ACTION_RETENTION_MILLIS + 2;
        inbox.prune(after_retention);

        assert!(inbox.query(&key, 0, 100, after_retention).is_empty());
        assert!(inbox.action_count() <= MAX_TOTAL_ACTIONS);
        assert!(inbox.seen_count() <= MAX_SEEN_IDEMPOTENCY_KEYS);
    }

    #[test]
    fn action_expiry_cleanup_is_bounded_across_mixed_keys_and_keeps_the_exact_boundary() {
        let mut limits = production_limits();
        limits.max_expired_actions_pruned_per_call = 2;
        let mut inbox = Inbox::new_for_test_with_limits(limits);
        let keys = [vec![21; 32], vec![22; 32], vec![23; 32]];
        for (index, key) in keys.iter().cloned().enumerate() {
            assert!(deposit(&mut inbox, key, index as u64 + 1, 1));
        }
        let exact_boundary_key = vec![24; 32];
        assert!(deposit(&mut inbox, exact_boundary_key.clone(), 4, 2));
        let now = ACTION_RETENTION_MILLIS + 2;

        inbox.prune(now);
        assert_eq!(
            inbox.action_count(),
            2,
            "one expired action and the exact-boundary action remain"
        );
        assert_eq!(inbox.stable_action_expiry.len(), 2);
        assert_eq!(inbox.query(&exact_boundary_key, 0, 100, now).len(), 1);

        inbox.prune(now);
        assert_eq!(
            inbox.action_count(),
            1,
            "the second bounded call removes the last expired action"
        );
        assert_eq!(inbox.stable_action_expiry.len(), 1);

        inbox.prune(now);
        assert_eq!(inbox.action_count(), 1, "a call with no expired actions is a no-op");
        assert_eq!(inbox.query(&exact_boundary_key, 0, 100, now).len(), 1);
        assert!(keys.iter().all(|key| inbox.query(key, 0, 100, now).is_empty()));
    }

    #[test]
    fn over_capacity_query_scan_is_bounded_by_the_current_per_key_ceiling() {
        let mut limits = production_limits();
        limits.max_actions_per_key = 2;
        let mut inbox = Inbox::new_for_test_with_limits(limits);
        let key = vec![25; 32];
        for id in 1..=3 {
            let action = stored_action(id, 1);
            let action_key = StableActionKey::new(&key, id);
            let bytes = action_storage_bytes(&action);
            inbox
                .stable_actions
                .insert(action_key, StableActionValue { action, received_at: id });
            inbox.index_stable_action(action_key, id, bytes);
        }

        let actions = inbox.query(&key, 0, 100, 3);
        assert_eq!(actions.iter().map(|action| action.id).collect::<Vec<_>>(), vec![1, 2]);
    }

    #[test]
    fn forward_index_migration_is_bounded_and_fails_closed_until_complete() {
        let mut inbox = Inbox::new_for_test();
        let key = vec![31; 32];
        for id in 1..=5 {
            assert!(deposit(&mut inbox, key.clone(), id, id));
        }
        begin_stable_index_migration(&mut inbox, 2);

        assert!(inbox.query(&key, 0, 100, 5).is_empty());
        assert!(inbox.remaining_if_action_missing(&key, 1).is_none());
        assert_eq!(inbox.run_migration_step(5), 2);
        assert!(inbox.migration_in_progress());
        assert_eq!(inbox.run_migration_step(5), 2);
        assert_eq!(inbox.run_migration_step(5), 1);
        assert!(!inbox.migration_in_progress());
        assert_eq!(inbox.migration_stable_actions_indexed(), 5);
        assert_eq!(inbox.query(&key, 0, 100, 5).len(), 5);
    }

    #[test]
    fn stable_action_cursor_resumes_after_serialized_upgrade_without_duplicate_accounting() {
        use ic_stable_structures::DefaultMemoryImpl;
        use ic_stable_structures::memory_manager::{MemoryId, MemoryManager};

        let manager = MemoryManager::init(DefaultMemoryImpl::default());
        let actions_memory = manager.get(MemoryId::new(1));
        let tombstones_memory = manager.get(MemoryId::new(2));
        let tombstone_expiry_memory = manager.get(MemoryId::new(3));
        let action_expiry_memory = manager.get(MemoryId::new(4));
        let key_stats_memory = manager.get(MemoryId::new(5));
        let mut limits = production_limits();
        limits.max_migration_items_per_step = 2;
        let key = vec![33; 32];
        let mut before = Inbox::with_stable_storage(
            StableBTreeMap::init(actions_memory.clone()),
            StableBTreeMap::init(tombstones_memory.clone()),
            StableBTreeMap::init(tombstone_expiry_memory.clone()),
            StableBTreeMap::init(action_expiry_memory.clone()),
            StableBTreeMap::init(key_stats_memory.clone()),
            limits,
        );
        for id in 1..=5 {
            assert!(deposit(&mut before, key.clone(), id, id));
        }
        begin_stable_index_migration(&mut before, 2);

        assert_eq!(
            before.run_migration_step(5),
            2,
            "the exact budget is consumed, never exceeded"
        );
        assert_eq!(before.action_count(), 2);
        assert_eq!(before.migration_stable_actions_indexed(), 2);
        assert!(before.migration_last_step_saturated());
        let encoded = msgpack::serialize_to_vec(&before).unwrap();
        drop(before);

        let mut after: Inbox = msgpack::deserialize(encoded.as_slice()).unwrap();
        after.stable_actions = StableBTreeMap::init(actions_memory);
        after.stable_tombstones = StableBTreeMap::init(tombstones_memory);
        after.stable_tombstone_expiry = StableBTreeMap::init(tombstone_expiry_memory);
        after.stable_action_expiry = StableBTreeMap::init(action_expiry_memory);
        after.stable_key_stats = StableBTreeMap::init(key_stats_memory);
        after.limits = limits;
        after.prepare_after_upgrade().unwrap();

        assert_eq!(after.migration_phase(), "stable_actions");
        assert_eq!(after.run_migration_step(5), 2);
        assert_eq!(after.action_count(), 4);
        assert_eq!(after.run_migration_step(5), 1);
        assert!(!after.migration_in_progress());
        assert_eq!(after.migration_stable_actions_indexed(), 5);
        assert_eq!(after.action_count(), 5);
        assert_eq!(after.key_stats(&key).count, 5);
        assert_eq!(after.query(&key, 0, 100, 5).len(), 5);
    }

    #[test]
    fn empty_legacy_store_completes_without_consuming_a_migration_item() {
        let mut inbox = Inbox::new_for_test();
        inbox.index_schema_version = 0;
        inbox.migration = MigrationState::default();
        assert_eq!(inbox.run_migration_step(1), 0);
        assert!(!inbox.migration_in_progress());
        assert_eq!(inbox.migration_phase(), "complete");
    }

    #[test]
    fn committed_legacy_heap_schema_is_detected_and_rejected_instead_of_silently_dropped() {
        #[derive(Serialize)]
        struct LegacyAction {
            id: u64,
            ephemeral_public_key: ByteBuf,
            ciphertext: ByteBuf,
            oc_signature: ByteBuf,
            created_at: TimestampMillis,
        }

        #[derive(Serialize)]
        struct LegacyInbox {
            actions: BTreeMap<Vec<u8>, Vec<LegacyAction>>,
            seen: HashSet<(Vec<u8>, u64)>,
            next_id: u64,
        }

        let fingerprint = vec![91; 32];
        let encoded = msgpack::serialize_to_vec(LegacyInbox {
            actions: BTreeMap::from([(
                fingerprint.clone(),
                vec![LegacyAction {
                    id: 7,
                    ephemeral_public_key: ByteBuf::from(vec![1; 65]),
                    ciphertext: ByteBuf::from(vec![2; 32]),
                    oc_signature: ByteBuf::from(vec![3; 64]),
                    created_at: 4,
                }],
            )]),
            seen: HashSet::from([(fingerprint, 99)]),
            next_id: 7,
        })
        .unwrap();

        let mut inbox: Inbox = msgpack::deserialize(encoded.as_slice()).unwrap();
        assert_eq!(inbox.next_id, 7);
        let error = inbox.prepare_after_upgrade().unwrap_err();
        assert!(error.contains("1 legacy heap action buckets"));
        assert!(error.contains("1 legacy replay entries"));

        let mut actions_only = Inbox::new_for_test();
        actions_only.legacy_heap_actions.insert(
            vec![1; 1],
            vec![LegacyHeapAction {
                id: 1,
                ephemeral_public_key: ByteBuf::new(),
                ciphertext: ByteBuf::new(),
                oc_signature: ByteBuf::new(),
                created_at: 1,
            }],
        );
        assert!(actions_only.prepare_after_upgrade().is_err());

        let mut seen_only = Inbox::new_for_test();
        seen_only.legacy_heap_seen.insert((vec![2; 1], 2));
        assert!(seen_only.prepare_after_upgrade().is_err());
    }

    #[test]
    fn empty_committed_legacy_heap_schema_can_upgrade_without_fabricating_v4_records() {
        #[derive(Serialize)]
        struct EmptyLegacyInbox {
            actions: BTreeMap<Vec<u8>, Vec<u8>>,
            seen: HashSet<(Vec<u8>, u64)>,
            next_id: u64,
        }

        let encoded = msgpack::serialize_to_vec(EmptyLegacyInbox {
            actions: BTreeMap::new(),
            seen: HashSet::new(),
            next_id: 41,
        })
        .unwrap();
        let mut inbox: Inbox = msgpack::deserialize(encoded.as_slice()).unwrap();

        assert_eq!(inbox.prepare_after_upgrade(), Ok(()));
        assert_eq!(inbox.run_migration_step(1), 0);
        assert!(deposit(&mut inbox, vec![92; 32], 1, 1));
        assert_eq!(inbox.query(&[92; 32], 0, 100, 1)[0].id, 42);
        assert_eq!(inbox.action_count(), 1);
        assert_eq!(inbox.seen_count(), 1);
    }

    #[test]
    fn stable_v4_action_without_acknowledgement_hash_decodes_readable_but_not_deletable() {
        #[derive(Serialize)]
        struct StoredActionBeforeAcknowledgement {
            id: u64,
            app_id: types::AiAppId,
            app_revision: TimestampMillis,
            action_id: String,
            consumer_key_fingerprint: ByteBuf,
            idempotency_key: ByteBuf,
            payload_hash: ByteBuf,
            card_context_hash: ByteBuf,
            ephemeral_public_key: ByteBuf,
            ciphertext: ByteBuf,
            signature_version: u16,
            signing_key_id: ByteBuf,
            oc_signature: ByteBuf,
            created_at: TimestampMillis,
        }

        #[derive(Serialize)]
        struct StableValueBeforeAcknowledgement {
            action: StoredActionBeforeAcknowledgement,
            received_at: TimestampMillis,
        }

        let current = stored_action(42, 16);
        let encoded = msgpack::serialize_to_vec(StableValueBeforeAcknowledgement {
            action: StoredActionBeforeAcknowledgement {
                id: current.id,
                app_id: current.app_id,
                app_revision: current.app_revision,
                action_id: current.action_id,
                consumer_key_fingerprint: current.consumer_key_fingerprint,
                idempotency_key: current.idempotency_key,
                payload_hash: current.payload_hash,
                card_context_hash: current.card_context_hash,
                ephemeral_public_key: current.ephemeral_public_key,
                ciphertext: current.ciphertext,
                signature_version: current.signature_version,
                signing_key_id: current.signing_key_id,
                oc_signature: current.oc_signature,
                created_at: current.created_at,
            },
            received_at: 43,
        })
        .unwrap();

        let decoded = StableActionValue::from_bytes(Cow::Owned(encoded));
        assert_eq!(decoded.action.id, 42);
        assert_eq!(decoded.received_at, 43);
        assert!(decoded.action.acknowledgement_secret_hash.is_empty());

        let fingerprint = decoded.action.consumer_key_fingerprint.clone().into_vec();
        let key = StableActionKey::new(&fingerprint, decoded.action.id);
        let mut inbox = Inbox::new_for_test();
        let bytes = action_storage_bytes(&decoded.action);
        inbox.stable_actions.insert(key, decoded);
        inbox.index_stable_action(key, 43, bytes);
        assert_eq!(inbox.query(&fingerprint, 0, 100, 43).len(), 1);
        assert_eq!(inbox.acknowledgement_secret_hash(&fingerprint, 42), None);
        inbox.prune(43 + ACTION_RETENTION_MILLIS + 1);
        assert!(inbox.query(&fingerprint, 0, 100, 43 + ACTION_RETENTION_MILLIS + 1).is_empty());
    }

    #[test]
    fn deposit_that_finishes_migration_still_retries_before_running_normal_maintenance() {
        let mut inbox = Inbox::new_for_test();
        inbox.index_schema_version = 0;
        inbox.migration = MigrationState::default();
        assert_eq!(
            inbox.deposit_batch(vec![pending(vec![35; 32], 1, 1, 1)], 1),
            Err(DepositBatchError::MigrationInProgress)
        );
        assert!(!inbox.migration_in_progress());
        assert_eq!(inbox.action_count(), 0);
        assert_eq!(inbox.seen_count(), 0);
        assert_eq!(inbox.deposit_batch(vec![pending(vec![35; 32], 1, 1, 1)], 1), Ok(1));
    }

    #[test]
    fn per_key_byte_exact_capacity_succeeds_and_one_over_retains_every_action() {
        let bytes_per_action = action_storage_bytes(&stored_action(0, 100));
        let limits = InboxLimits {
            max_actions_per_key: 100,
            max_total_actions: 100,
            max_bytes_per_key: bytes_per_action * 2,
            max_total_bytes: bytes_per_action * 10,
            max_seen_idempotency_keys: 100,
            max_expired_tombstones_pruned_per_call: 10,
            ..production_limits()
        };
        let mut inbox = Inbox::new_for_test_with_limits(limits);
        let key = vec![5; 32];
        let other_key = vec![6; 32];

        assert!(deposit_with_ciphertext(&mut inbox, key.clone(), 1, 1, 100));
        assert!(deposit_with_ciphertext(&mut inbox, key.clone(), 2, 2, 100));
        assert_eq!(inbox.query(&key, 0, 100, 2).len(), 2, "the exact byte limit is accepted");
        assert!(deposit_with_ciphertext(&mut inbox, other_key.clone(), 3, 3, 100));
        assert_eq!(
            try_deposit_with_ciphertext(&mut inbox, key.clone(), 4, 4, 100),
            Err(DepositBatchError::ActionByteCapacity {
                scope: ActionCapacityScope::ConsumerKey,
                required: bytes_per_action,
                available: 0,
            })
        );

        let retained = inbox.query(&key, 0, 100, 4);
        assert_eq!(retained.iter().map(|action| action.id).collect::<Vec<_>>(), vec![1, 2]);
        assert_eq!(inbox.query(&other_key, 0, 100, 4).len(), 1);
        assert_eq!(inbox.bytes_for_key(&key), bytes_per_action * 2);
    }

    #[test]
    fn app_byte_exact_capacity_succeeds_and_one_over_retains_every_key() {
        let bytes_per_action = action_storage_bytes(&stored_action(0, 100));
        let limits = InboxLimits {
            max_actions_per_key: 100,
            max_total_actions: 100,
            max_bytes_per_key: bytes_per_action * 10,
            max_total_bytes: bytes_per_action * 3,
            max_seen_idempotency_keys: 100,
            max_expired_tombstones_pruned_per_call: 10,
            ..production_limits()
        };
        let mut inbox = Inbox::new_for_test_with_limits(limits);
        let oldest_key = vec![7; 32];

        assert!(deposit_with_ciphertext(&mut inbox, oldest_key.clone(), 1, 1, 100));
        for value in 8..=9 {
            assert!(deposit_with_ciphertext(
                &mut inbox,
                vec![value; 32],
                value as u64,
                value as u64,
                100
            ));
        }
        assert_eq!(
            try_deposit_with_ciphertext(&mut inbox, vec![10; 32], 10, 10, 100),
            Err(DepositBatchError::ActionByteCapacity {
                scope: ActionCapacityScope::App,
                required: bytes_per_action,
                available: 0,
            })
        );

        assert_eq!(inbox.query(&oldest_key, 0, 100, 10).len(), 1);
        assert_eq!(inbox.action_count(), 3);
        assert_eq!(inbox.total_bytes(), bytes_per_action * 3);
    }

    #[test]
    fn silent_capacity_eviction_per_key_count_fails_closed() {
        let mut limits = production_limits();
        limits.max_actions_per_key = 2;
        let mut inbox = Inbox::new_for_test_with_limits(limits);
        let key = vec![81; 32];
        assert!(deposit(&mut inbox, key.clone(), 1, 1));
        assert!(deposit(&mut inbox, key.clone(), 2, 2));

        assert_eq!(
            try_deposit_with_ciphertext(&mut inbox, key.clone(), 3, 3, 1),
            Err(DepositBatchError::ActionCountCapacity {
                scope: ActionCapacityScope::ConsumerKey,
                required: 1,
                available: 0,
            })
        );
        assert_eq!(
            inbox
                .query(&key, 0, 100, 3)
                .iter()
                .map(|action| action.id)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
    }

    #[test]
    fn silent_capacity_eviction_global_count_cannot_delete_another_key() {
        let mut limits = production_limits();
        limits.max_total_actions = 2;
        let mut inbox = Inbox::new_for_test_with_limits(limits);
        let protected_key = vec![82; 32];
        assert!(deposit(&mut inbox, protected_key.clone(), 1, 1));
        assert!(deposit(&mut inbox, vec![83; 32], 2, 2));

        assert_eq!(
            try_deposit_with_ciphertext(&mut inbox, vec![84; 32], 3, 3, 1),
            Err(DepositBatchError::ActionCountCapacity {
                scope: ActionCapacityScope::App,
                required: 1,
                available: 0,
            })
        );
        assert_eq!(inbox.query(&protected_key, 0, 100, 3).len(), 1);
        assert_eq!(inbox.action_count(), 2);
    }

    #[test]
    fn silent_capacity_eviction_per_key_bytes_fails_closed() {
        let bytes_per_action = action_storage_bytes(&stored_action(0, 100));
        let mut limits = production_limits();
        limits.max_bytes_per_key = bytes_per_action * 2;
        let mut inbox = Inbox::new_for_test_with_limits(limits);
        let key = vec![85; 32];
        assert!(deposit_with_ciphertext(&mut inbox, key.clone(), 1, 1, 100));
        assert!(deposit_with_ciphertext(&mut inbox, key.clone(), 2, 2, 100));

        assert_eq!(
            try_deposit_with_ciphertext(&mut inbox, key.clone(), 3, 3, 100),
            Err(DepositBatchError::ActionByteCapacity {
                scope: ActionCapacityScope::ConsumerKey,
                required: bytes_per_action,
                available: 0,
            })
        );
        assert_eq!(inbox.bytes_for_key(&key), bytes_per_action * 2);
        assert_eq!(inbox.query(&key, 0, 100, 3)[0].id, 1);
    }

    #[test]
    fn silent_capacity_eviction_global_bytes_cannot_delete_another_key() {
        let bytes_per_action = action_storage_bytes(&stored_action(0, 100));
        let mut limits = production_limits();
        limits.max_total_bytes = bytes_per_action * 2;
        let mut inbox = Inbox::new_for_test_with_limits(limits);
        let protected_key = vec![86; 32];
        assert!(deposit_with_ciphertext(&mut inbox, protected_key.clone(), 1, 1, 100));
        assert!(deposit_with_ciphertext(&mut inbox, vec![87; 32], 2, 2, 100));

        assert_eq!(
            try_deposit_with_ciphertext(&mut inbox, vec![88; 32], 3, 3, 100),
            Err(DepositBatchError::ActionByteCapacity {
                scope: ActionCapacityScope::App,
                required: bytes_per_action,
                available: 0,
            })
        );
        assert_eq!(inbox.query(&protected_key, 0, 100, 3).len(), 1);
        assert_eq!(inbox.total_bytes(), bytes_per_action * 2);
    }

    #[test]
    fn multi_recipient_count_batch_is_atomic_when_only_part_would_fit_and_duplicates_cost_nothing() {
        let mut limits = production_limits();
        limits.max_total_actions = 2;
        let mut inbox = Inbox::new_for_test_with_limits(limits);
        let existing_key = vec![91; 32];
        assert!(deposit(&mut inbox, existing_key.clone(), 1, 1));

        assert_eq!(
            inbox.deposit_batch(
                vec![
                    pending(existing_key.clone(), 1, 2, 1),
                    pending(vec![92; 32], 2, 2, 1),
                    pending(vec![93; 32], 3, 2, 1),
                ],
                2,
            ),
            Err(DepositBatchError::ActionCountCapacity {
                scope: ActionCapacityScope::App,
                required: 2,
                available: 1,
            })
        );
        assert_eq!(inbox.action_count(), 1);
        assert_eq!(inbox.seen_count(), 1);
        assert!(inbox.query(&[92; 32], 0, 100, 2).is_empty());
        assert_eq!(
            inbox.deposit_batch(vec![pending(existing_key, 1, 3, 1)], 3),
            Ok(0),
            "a duplicate-only retry consumes no action or tombstone capacity"
        );
    }

    #[test]
    fn multi_recipient_byte_batch_is_atomic_when_only_part_would_fit() {
        let bytes_per_action = action_storage_bytes(&stored_action(0, 100));
        let mut limits = production_limits();
        limits.max_total_bytes = bytes_per_action * 2;
        let mut inbox = Inbox::new_for_test_with_limits(limits);
        assert!(deposit_with_ciphertext(&mut inbox, vec![94; 32], 1, 1, 100));

        assert_eq!(
            inbox.deposit_batch(vec![pending(vec![95; 32], 2, 2, 100), pending(vec![96; 32], 3, 2, 100)], 2,),
            Err(DepositBatchError::ActionByteCapacity {
                scope: ActionCapacityScope::App,
                required: bytes_per_action * 2,
                available: bytes_per_action,
            })
        );
        assert_eq!(inbox.action_count(), 1);
        assert_eq!(inbox.seen_count(), 1);
        assert_eq!(inbox.total_bytes(), bytes_per_action);
    }

    #[test]
    fn acknowledgement_and_expiry_release_action_capacity_without_evicting_live_records() {
        let mut limits = production_limits();
        limits.max_total_actions = 1;

        let mut acknowledged = Inbox::new_for_test_with_limits(limits);
        let first_key = vec![97; 32];
        assert!(deposit(&mut acknowledged, first_key.clone(), 1, 1));
        assert!(acknowledged.action_count_capacity_saturated());
        acknowledged.acknowledge_exact(&first_key, 1);
        assert_eq!(acknowledged.remaining_action_count_capacity(), 1);
        assert!(deposit(&mut acknowledged, vec![98; 32], 2, 2));

        let mut expired = Inbox::new_for_test_with_limits(limits);
        let expired_key = vec![99; 32];
        assert!(deposit(&mut expired, expired_key.clone(), 1, 1));
        let after_expiry = ACTION_RETENTION_MILLIS + 2;
        assert!(deposit(&mut expired, vec![100; 32], 2, after_expiry));
        assert!(expired.query(&expired_key, 0, 100, after_expiry).is_empty());
        assert_eq!(expired.action_count(), 1);
    }

    #[test]
    fn acknowledgement_churn_does_not_grow_the_heap_ordering_index() {
        let mut inbox = Inbox::new_for_test();
        let persistent_key = vec![11; 32];
        let churn_key = vec![12; 32];
        assert!(deposit(&mut inbox, persistent_key, 1, 1));

        for idempotency_id in 2..=500 {
            assert!(deposit(&mut inbox, churn_key.clone(), idempotency_id, idempotency_id));
            inbox.acknowledge_exact(&churn_key, inbox.next_id);
        }

        assert_eq!(inbox.action_count(), 1);
        assert_eq!(inbox.stable_action_expiry.len(), 1);
    }

    #[test]
    fn non_expired_cross_key_churn_cannot_resurrect_an_acknowledged_action() {
        let mut limits = production_limits();
        limits.max_seen_idempotency_keys = 3;
        let mut inbox = Inbox::new_for_test_with_limits(limits);
        let protected_key = vec![21; 32];
        assert!(deposit(&mut inbox, protected_key.clone(), 1, 1));
        inbox.acknowledge_exact(&protected_key, 1);

        for value in 22..=23 {
            assert!(deposit(&mut inbox, vec![value; 32], value as u64, value as u64));
        }
        assert_eq!(inbox.seen_count(), 3);
        let before_actions = inbox.action_count();
        assert_eq!(
            inbox.deposit_batch(vec![pending(vec![24; 32], 24, 24, 1)], 24),
            Err(DepositBatchError::TombstoneCapacity {
                required: 1,
                available: 0
            })
        );
        assert_eq!(inbox.action_count(), before_actions);
        assert_eq!(inbox.seen_count(), 3);

        assert!(
            !deposit(&mut inbox, protected_key, 1, 25),
            "a non-expired acknowledged tombstone must never be evicted by unrelated keys"
        );
    }

    #[test]
    fn non_expired_cross_key_churn_cannot_duplicate_an_active_action() {
        let mut limits = production_limits();
        limits.max_seen_idempotency_keys = 2;
        let mut inbox = Inbox::new_for_test_with_limits(limits);
        let protected_key = vec![31; 32];
        assert!(deposit(&mut inbox, protected_key.clone(), 1, 1));
        assert!(deposit(&mut inbox, vec![32; 32], 2, 2));

        assert_eq!(
            inbox.deposit_batch(vec![pending(vec![33; 32], 3, 3, 1)], 3),
            Err(DepositBatchError::TombstoneCapacity {
                required: 1,
                available: 0
            })
        );
        assert!(!deposit(&mut inbox, protected_key.clone(), 1, 4));
        assert_eq!(inbox.query(&protected_key, 0, 100, 4).len(), 1);
    }

    #[test]
    fn exact_capacity_succeeds_and_one_over_batch_has_no_partial_writes() {
        let mut limits = production_limits();
        limits.max_seen_idempotency_keys = 3;
        let mut exact = Inbox::new_for_test_with_limits(limits);
        assert_eq!(
            exact.deposit_batch(
                vec![
                    pending(vec![41; 32], 1, 1, 1),
                    pending(vec![41; 32], 1, 1, 1),
                    pending(vec![42; 32], 2, 1, 1),
                    pending(vec![43; 32], 3, 1, 1),
                ],
                1,
            ),
            Ok(3)
        );
        assert_eq!(exact.seen_count(), 3);
        assert_eq!(exact.action_count(), 3);
        assert_eq!(
            exact.deposit_batch(vec![pending(vec![41; 32], 1, 2, 1)], 2),
            Ok(0),
            "a duplicate retry remains idempotent success even at capacity"
        );

        let mut one_over = Inbox::new_for_test_with_limits(limits);
        let error = one_over.deposit_batch(
            vec![
                pending(vec![44; 32], 4, 1, 1),
                pending(vec![45; 32], 5, 1, 1),
                pending(vec![46; 32], 6, 1, 1),
                pending(vec![47; 32], 7, 1, 1),
            ],
            1,
        );
        assert_eq!(
            error,
            Err(DepositBatchError::TombstoneCapacity {
                required: 4,
                available: 3
            })
        );
        assert_eq!(one_over.seen_count(), 0);
        assert_eq!(one_over.action_count(), 0);
        assert!(one_over.query(&[44; 32], 0, 100, 1).is_empty());
    }

    #[test]
    fn full_width_identity_is_primary_and_changed_payload_fails_closed() {
        let mut inbox = Inbox::new_for_test();
        let fingerprint = vec![48; 32];
        let original = committed_pending(fingerprint.clone(), 7, 1, 2);
        assert_eq!(inbox.deposit_batch(vec![original.clone()], 1), Ok(1));
        assert_eq!(inbox.deposit_batch(vec![original], 2), Ok(0), "an exact retry is idempotent");

        assert_eq!(
            inbox.deposit_batch(vec![committed_pending(fingerprint.clone(), 7, 3, 2)], 3),
            Ok(1),
            "a different full card identity never collides through a projected u64"
        );
        assert_eq!(
            inbox.deposit_batch(vec![committed_pending(fingerprint.clone(), 7, 1, 4)], 4),
            Err(DepositBatchError::IdempotencyConflict),
            "the same card identity cannot be retried with a different final payload"
        );
        assert_eq!(inbox.action_count(), 2);
        assert_eq!(inbox.seen_count(), 2);
    }

    #[test]
    fn semantic_attempt_tombstone_allows_reencryption_but_rejects_a_different_actor() {
        let mut inbox = Inbox::new_for_test();
        let fingerprint = vec![52; 32];
        let original = committed_pending(fingerprint.clone(), 10, 1, 2);
        assert_eq!(inbox.deposit_batch(vec![original.clone()], 1), Ok(1));

        let mut reencrypted = original.clone();
        reencrypted.ephemeral_public_key = ByteBuf::from(vec![7; 65]);
        reencrypted.ciphertext = ByteBuf::from(vec![8; 32]);
        reencrypted.acknowledgement_secret_hash = ByteBuf::from(vec![9; 32]);
        reencrypted.oc_signature = ByteBuf::from(vec![10; 64]);
        assert_eq!(
            inbox.deposit_batch(vec![reencrypted], 2),
            Ok(0),
            "the same signed semantic attempt may be re-encrypted on retry"
        );

        let mut different_actor = original;
        different_actor.card_context_hash = ByteBuf::from(vec![3; 32]);
        assert_eq!(
            inbox.deposit_batch(vec![different_actor], 3),
            Err(DepositBatchError::IdempotencyConflict),
            "the same card and payload cannot be accepted for a different actor/context"
        );
        assert_eq!(inbox.action_count(), 1);
        assert_eq!(inbox.seen_count(), 1);
    }

    #[test]
    fn identities_sharing_their_first_eight_bytes_are_both_accepted() {
        let mut inbox = Inbox::new_for_test();
        let fingerprint = vec![47; 32];
        let mut first = committed_pending(fingerprint.clone(), 6, 1, 2);
        let mut second = committed_pending(fingerprint, 6, 1, 2);
        first.idempotency_key[..8].copy_from_slice(&[9; 8]);
        second.idempotency_key[..8].copy_from_slice(&[9; 8]);
        first.idempotency_key[31] = 1;
        second.idempotency_key[31] = 2;
        assert_eq!(inbox.deposit_batch(vec![first, second], 1), Ok(2));
        assert_eq!(inbox.action_count(), 2);
        assert_eq!(inbox.seen_count(), 2);
    }

    #[test]
    fn same_full_identity_with_conflicting_payloads_is_rejected_without_partial_writes() {
        let mut inbox = Inbox::new_for_test();
        let fingerprint = vec![49; 32];
        assert_eq!(
            inbox.deposit_batch(
                vec![
                    committed_pending(fingerprint.clone(), 8, 1, 2),
                    committed_pending(fingerprint.clone(), 8, 1, 3),
                ],
                1,
            ),
            Err(DepositBatchError::IdempotencyConflict)
        );
        assert_eq!(inbox.action_count(), 0);
        assert_eq!(inbox.seen_count(), 0);
    }

    #[test]
    fn commitment_expires_with_its_tombstone_and_allows_safe_identity_reuse() {
        let mut inbox = Inbox::new_for_test();
        let fingerprint = vec![50; 32];
        assert_eq!(
            inbox.deposit_batch(vec![committed_pending(fingerprint.clone(), 9, 1, 2)], 1),
            Ok(1)
        );
        let after_expiry = ACTION_RETENTION_MILLIS + 2;
        assert_eq!(
            inbox.deposit_batch(vec![committed_pending(fingerprint, 9, 3, 4)], after_expiry),
            Ok(1)
        );
        assert_eq!(
            inbox.action_count(),
            1,
            "the expired action and commitment were pruned together"
        );
    }

    #[test]
    fn expired_capacity_is_recovered_in_bounded_work_units() {
        let mut limits = production_limits();
        limits.max_seen_idempotency_keys = 2;
        limits.max_expired_tombstones_pruned_per_call = 1;
        let mut inbox = Inbox::new_for_test_with_limits(limits);
        assert!(deposit(&mut inbox, vec![51; 32], 1, 1));
        assert!(deposit(&mut inbox, vec![52; 32], 2, 2));

        let after_expiry = ACTION_RETENTION_MILLIS + 3;
        let replacement_batch = || {
            vec![
                pending(vec![53; 32], 3, after_expiry, 1),
                pending(vec![54; 32], 4, after_expiry, 1),
            ]
        };
        assert_eq!(
            inbox.deposit_batch(replacement_batch(), after_expiry),
            Err(DepositBatchError::TombstoneCapacity {
                required: 2,
                available: 1
            })
        );
        assert_eq!(
            inbox.seen_count(),
            1,
            "only the configured one expired entry is pruned per call"
        );
        assert_eq!(inbox.action_count(), 0, "the failed batch writes no replacement actions");

        assert_eq!(inbox.deposit_batch(replacement_batch(), after_expiry), Ok(2));
        assert_eq!(inbox.seen_count(), 2);
        assert_eq!(inbox.action_count(), 2);
    }

    #[test]
    fn stable_reopen_preserves_acknowledged_replay_protection_and_capacity() {
        use ic_stable_structures::DefaultMemoryImpl;
        use ic_stable_structures::memory_manager::{MemoryId, MemoryManager};

        let manager = MemoryManager::init(DefaultMemoryImpl::default());
        let actions_memory = manager.get(MemoryId::new(1));
        let tombstones_memory = manager.get(MemoryId::new(2));
        let expiry_memory = manager.get(MemoryId::new(3));
        let action_expiry_memory = manager.get(MemoryId::new(4));
        let key_stats_memory = manager.get(MemoryId::new(5));
        let mut limits = production_limits();
        limits.max_seen_idempotency_keys = 2;
        let protected_key = vec![61; 32];

        {
            let mut before = Inbox::with_stable_storage(
                StableBTreeMap::init(actions_memory.clone()),
                StableBTreeMap::init(tombstones_memory.clone()),
                StableBTreeMap::init(expiry_memory.clone()),
                StableBTreeMap::init(action_expiry_memory.clone()),
                StableBTreeMap::init(key_stats_memory.clone()),
                limits,
            );
            assert_eq!(
                before.deposit_batch(vec![committed_pending(protected_key.clone(), 1, 7, 8)], 1),
                Ok(1)
            );
            before.acknowledge_exact(&protected_key, 1);
            assert_eq!(before.seen_count(), 1);
        }

        let mut reopened = Inbox::with_stable_storage(
            StableBTreeMap::init(actions_memory),
            StableBTreeMap::init(tombstones_memory),
            StableBTreeMap::init(expiry_memory),
            StableBTreeMap::init(action_expiry_memory),
            StableBTreeMap::init(key_stats_memory),
            limits,
        );
        reopened.total_action_count = 0;
        reopened.total_action_bytes = 0;
        assert_eq!(reopened.seen_count(), 1);
        assert_eq!(
            reopened.deposit_batch(vec![committed_pending(protected_key.clone(), 1, 7, 8)], 2),
            Ok(0),
            "the exact full-width retry stays idempotent after reopen"
        );
        assert_eq!(
            reopened.deposit_batch(vec![committed_pending(protected_key.clone(), 1, 9, 8)], 2),
            Ok(1),
            "a distinct full-width identity survives reopen without a projected collision"
        );
        assert_eq!(
            reopened.deposit_batch(vec![committed_pending(protected_key, 1, 7, 9)], 2),
            Err(DepositBatchError::IdempotencyConflict),
            "the tombstone semantic commitment survives reopen and rejects a changed attempt"
        );
        assert!(reopened.tombstone_capacity_saturated());
        assert_eq!(
            reopened.deposit_batch(vec![committed_pending(vec![63; 32], 3, 12, 13)], 3),
            Err(DepositBatchError::TombstoneCapacity {
                required: 1,
                available: 0
            })
        );
    }

    #[test]
    fn duplicate_tombstone_does_not_extend_or_orphan_its_original_expiry() {
        let mut inbox = Inbox::new_for_test();
        let key = StableTombstoneKey::new(&[71; 32], &[1; 32]);
        assert!(inbox.insert_tombstone(key, 1, [2; 32]));
        assert!(!inbox.insert_tombstone(key, 100, [2; 32]));

        inbox.prune_expired_tombstones(ACTION_RETENTION_MILLIS + 2, 1);
        assert_eq!(inbox.seen_count(), 0);
        assert_eq!(inbox.stable_tombstone_expiry.len(), 0);
    }

    #[test]
    fn query_page_is_bounded_to_512_kib_and_resumes_from_last_returned_id() {
        use action_inbox_canister::actions::{Response, SuccessResult};

        let key = vec![81; 32];
        let response_size = |ciphertext_lengths: &[usize]| {
            let actions = ciphertext_lengths
                .iter()
                .enumerate()
                .map(|(index, ciphertext_bytes)| stored_action(index as u64 + 1, *ciphertext_bytes))
                .collect();
            msgpack::serialize_to_vec(Response::Success(SuccessResult { actions }))
                .unwrap()
                .len()
        };
        let mut ciphertext_lengths = vec![MAX_CIPHERTEXT_BYTES; 7];
        ciphertext_lengths.push(1);
        for _ in 0..8 {
            let current = response_size(&ciphertext_lengths);
            if current == MAX_QUERY_RESPONSE_ENCODED_BYTES {
                break;
            }
            let last = ciphertext_lengths.last_mut().unwrap();
            if current < MAX_QUERY_RESPONSE_ENCODED_BYTES {
                *last += MAX_QUERY_RESPONSE_ENCODED_BYTES - current;
            } else {
                *last -= current - MAX_QUERY_RESPONSE_ENCODED_BYTES;
            }
        }
        assert_eq!(response_size(&ciphertext_lengths), MAX_QUERY_RESPONSE_ENCODED_BYTES);
        assert!(ciphertext_lengths.last().unwrap() <= &MAX_CIPHERTEXT_BYTES);

        let mut exact = Inbox::new_for_test();
        for (index, ciphertext_bytes) in ciphertext_lengths.iter().copied().enumerate() {
            let id = index as u64 + 1;
            assert!(deposit_with_ciphertext(&mut exact, key.clone(), id, id, ciphertext_bytes));
        }
        assert!(deposit_with_ciphertext(&mut exact, key.clone(), 9, 9, 1));
        let first = exact.query(&key, 0, 100, 9);
        let encoded = msgpack::serialize_to_vec(Response::Success(SuccessResult { actions: first.clone() })).unwrap();
        assert_eq!(encoded.len(), MAX_QUERY_RESPONSE_ENCODED_BYTES);
        assert_eq!(
            first.iter().map(|action| action.id).collect::<Vec<_>>(),
            (1..=8).collect::<Vec<_>>()
        );
        let cursor = first.last().unwrap().id;
        let second = exact.query(&key, cursor, 100, 9);
        assert_eq!(first.len() + second.len(), 9);
        assert!(second.iter().all(|action| action.id > cursor));

        let mut one_byte_over = Inbox::new_for_test();
        *ciphertext_lengths.last_mut().unwrap() += 1;
        for (index, ciphertext_bytes) in ciphertext_lengths.iter().copied().enumerate() {
            let id = index as u64 + 1;
            assert!(deposit_with_ciphertext(
                &mut one_byte_over,
                key.clone(),
                id,
                id,
                ciphertext_bytes,
            ));
        }
        assert!(deposit_with_ciphertext(&mut one_byte_over, key.clone(), 9, 9, 1));
        let before_boundary = one_byte_over.query(&key, 0, 100, 9);
        assert_eq!(before_boundary.len(), 7);
        let after_boundary = one_byte_over.query(&key, 7, 100, 9);
        let all_ids: Vec<_> = before_boundary
            .iter()
            .chain(&after_boundary)
            .map(|action| action.id)
            .collect();
        assert_eq!(all_ids, (1..=9).collect::<Vec<_>>());
    }

    #[test]
    fn one_maximum_action_with_max_integer_overhead_always_fits_a_query_page() {
        let action = stored_action(u64::MAX, MAX_CIPHERTEXT_BYTES);
        let encoded =
            msgpack::serialize_to_vec(ActionsResponse::Success(ActionsSuccessResult { actions: vec![action] })).unwrap();
        assert!(encoded.len() < MAX_QUERY_RESPONSE_ENCODED_BYTES);
    }

    #[test]
    fn incremental_query_accounting_matches_actual_encoding_across_array_header_growth() {
        let mut actions = Vec::new();
        let mut accounted = msgpack_encoded_size(&ActionsResponse::Success(ActionsSuccessResult { actions: Vec::new() }));
        for index in 0..17 {
            let action = stored_action(if index == 16 { u64::MAX } else { index as u64 + 1 }, index + 1);
            accounted = encoded_query_response_size_with_action(accounted, actions.len(), &action);
            actions.push(action);
            let actual = msgpack::serialize_to_vec(ActionsResponse::Success(ActionsSuccessResult {
                actions: actions.clone(),
            }))
            .unwrap()
            .len();
            assert_eq!(accounted, actual, "mismatch after {} actions", actions.len());
        }
    }
}
