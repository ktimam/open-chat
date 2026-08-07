use candid::Principal;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::ops::Bound::{Excluded, Unbounded};
use types::{AiAppId, TimestampMillis};

/// A downstream call is bounded to ten seconds. The durable lease deliberately remains three times
/// longer, preventing routine retries at the network-timeout boundary while retaining convergence.
pub const ACTION_DELIVERY_LEASE_MS: u64 = 30_000;
/// A new inbox call is never opened unless its full bounded network window fits before expiry.
pub const ACTION_DELIVERY_NETWORK_BUDGET_MS: u64 = 10_000;
pub const MAX_ACTION_DELIVERY_REQUEST_BYTES: usize = action_inbox_canister::c2c_notify_actions::MAX_DEPOSIT_BATCH_ENCODED_BYTES;

// Pending requests are never evicted. The per-app limits reserve at least seven eighths of the
// count budget and seven eighths of the byte budget for other apps.
const MAX_PENDING_GLOBAL: usize = 128;
const MAX_PENDING_PER_APP: usize = 16;
const MAX_PENDING_BYTES_GLOBAL: usize = 32 * 1024 * 1024;
const MAX_PENDING_BYTES_PER_APP: usize = 4 * 1024 * 1024;

// This is the ActionInbox idempotency/action horizon. An unexpired tombstone is never evicted: new
// work is rejected at the hard attempt caps, and an attempt older than this horizon cannot be
// recreated after its tombstone is pruned.
pub const ACTION_DELIVERY_IDEMPOTENCY_HORIZON_MS: u64 = 30 * 24 * 60 * 60 * 1_000;
// ActionInbox retains up to 200k idempotency tombstones for one app. UserIndex supports that full
// per-app horizon while reserving half of its aggregate terminal capacity for other applications.
pub const MAX_ATTEMPTS_GLOBAL: usize = 400_000;
pub const MAX_ATTEMPTS_PER_APP: usize = 200_000;

// Index maintenance is deliberately split between user-facing calls and the existing outbox timer.
// This bounds confirmation latency while allowing a legacy snapshot to converge quickly in the
// background without one upgrade or update scanning all 400k retained attempts.
const ACTION_DELIVERY_INDEX_VERSION: u8 = 1;
const HOT_PATH_INDEX_REBUILD_BATCH: usize = 64;
const BACKGROUND_INDEX_REBUILD_BATCH: usize = 1_024;
const TERMINAL_PRUNE_BATCH: usize = 64;

pub type ActionDeliverySlotId = [u8; 32];
pub type ActionDeliveryAttemptId = [u8; 32];

#[derive(Serialize, Deserialize)]
pub struct ActionDeliveryOutbox {
    entries: BTreeMap<ActionDeliveryAttemptId, ActionDeliveryEntry>,
    /// Only non-default (currently direct-chat) slots need a second index. Group/channel entries
    /// continue to use their exact attempt id as the slot without duplicating up to 400k hashes.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    logical_slots: BTreeMap<ActionDeliverySlotId, ActionDeliveryAttemptId>,
    #[serde(default)]
    usage: ActionDeliveryUsage,
    /// Time-ordered indexes make terminal cleanup and retry scheduling independent of retained
    /// history size. They are rebuilt incrementally for snapshots written before version 1.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    terminal_expirations: BTreeMap<(TimestampMillis, ActionDeliveryAttemptId), ()>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    retry_schedule: BTreeMap<(TimestampMillis, ActionDeliveryAttemptId), ()>,
    #[serde(default)]
    index_state: ActionDeliveryIndexState,
    #[cfg(test)]
    #[serde(skip)]
    entry_scan_visits: usize,
}

impl Default for ActionDeliveryOutbox {
    fn default() -> Self {
        Self {
            entries: BTreeMap::new(),
            logical_slots: BTreeMap::new(),
            usage: ActionDeliveryUsage::default(),
            terminal_expirations: BTreeMap::new(),
            retry_schedule: BTreeMap::new(),
            index_state: ActionDeliveryIndexState::current(),
            #[cfg(test)]
            entry_scan_visits: 0,
        }
    }
}

#[derive(Serialize, Deserialize, Default)]
struct ActionDeliveryIndexState {
    version: u8,
    #[serde(default)]
    rebuild_phase: ActionDeliveryIndexRebuildPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rebuild_cursor: Option<ActionDeliveryAttemptId>,
    #[serde(default)]
    rebuilt_usage: ActionDeliveryUsage,
    /// Captured once when a legacy migration starts. A missing/partial legacy usage index cannot
    /// authorize fresh capacity until the bounded rebuild completes.
    #[serde(default)]
    active_usage_trusted: bool,
}

impl ActionDeliveryIndexState {
    fn current() -> Self {
        Self {
            version: ACTION_DELIVERY_INDEX_VERSION,
            active_usage_trusted: true,
            ..Self::default()
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
enum ActionDeliveryIndexRebuildPhase {
    #[default]
    Uninitialized,
    Clearing,
    Scanning,
    Failed,
}

#[derive(Serialize, Deserialize, Default)]
struct ActionDeliveryUsage {
    total_attempts: usize,
    attempts_by_app: BTreeMap<AiAppId, usize>,
    pending_count: usize,
    pending_bytes: usize,
    pending_by_app: BTreeMap<AiAppId, PendingUsage>,
    preparing: usize,
    in_flight: usize,
    outcome_unknown: usize,
    delivered: usize,
    rejected: usize,
    attempt_capacity_rejections: u64,
    pending_count_rejections: u64,
    pending_byte_rejections: u64,
    expired_before_dispatch: u64,
}

#[derive(Serialize, Deserialize, Default)]
struct PendingUsage {
    count: usize,
    bytes: usize,
}

#[derive(Serialize, Deserialize)]
struct ActionDeliveryEntry {
    /// Missing only in state written before logical slots existed; such entries use their exact
    /// attempt id as their slot, preserving the legacy non-direct behavior.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    logical_slot_id: Option<ActionDeliverySlotId>,
    app_id: AiAppId,
    attempt_created_at: TimestampMillis,
    /// Exact MessagePack request bytes sent to `c2c_notify_actions_msgpack`. Empty only while a
    /// capacity reservation is being prepared and after a terminal outcome has been recorded.
    request: Vec<u8>,
    destination: Option<Principal>,
    reserved_bytes: usize,
    state: ActionDeliveryState,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Eq, PartialEq)]
enum ActionDeliveryState {
    Preparing { epoch: u64, lease_started_at: TimestampMillis },
    InFlight { epoch: u64, lease_started_at: TimestampMillis },
    OutcomeUnknown { epoch: u64, retry_after: TimestampMillis },
    Delivered { completed_at: TimestampMillis },
    Rejected { completed_at: TimestampMillis },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActionDeliveryDispatch {
    pub attempt_id: ActionDeliveryAttemptId,
    pub epoch: u64,
    pub destination: Principal,
    pub request: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActionDeliveryStart {
    Prepare { epoch: u64 },
    Dispatch,
    Pending,
    Delivered,
    Rejected,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActionDeliveryCompletion {
    Delivered,
    Rejected,
    OutcomeUnknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActionDeliveryRemoteResult {
    Delivered,
    Rejected,
    OutcomeUnknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActionDeliveryOutboxError {
    InvalidRequestSize,
    PendingCapacity,
    PendingByteCapacity,
    IdentityCollision,
    StaleEpoch,
    MissingPreparedRequest,
    AttemptExpired,
    AttemptInFuture,
    IndexRebuilding,
}

impl ActionDeliveryOutboxError {
    pub fn message(self) -> &'static str {
        match self {
            Self::InvalidRequestSize => "action delivery request has an invalid encoded size",
            Self::PendingCapacity => "action delivery outbox pending capacity is exhausted",
            Self::PendingByteCapacity => "action delivery outbox byte capacity is exhausted",
            Self::IdentityCollision => "action delivery attempt identity is inconsistent",
            Self::StaleEpoch => "action delivery attempt was superseded",
            Self::MissingPreparedRequest => "action delivery request was not durably prepared",
            Self::AttemptExpired => "action delivery attempt has no complete network window before idempotency expiry",
            Self::AttemptInFuture => "action delivery attempt timestamp is in the future",
            Self::IndexRebuilding => "action delivery outbox indexes are being rebuilt",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct ActionDeliveryOutboxMetrics {
    pub total_attempts: usize,
    pub attempt_slots_remaining: usize,
    pub pending_entries: usize,
    pub preparing: usize,
    pub in_flight: usize,
    pub outcome_unknown: usize,
    pub pending_bytes: usize,
    pub delivered_tombstones: usize,
    pub rejected_tombstones: usize,
    pub attempt_capacity_rejections: u64,
    pub pending_count_rejections: u64,
    pub pending_byte_rejections: u64,
    pub expired_before_dispatch: u64,
    pub index_rebuilding: bool,
    pub index_rebuild_failed: bool,
}

impl ActionDeliveryUsage {
    fn counters_only(previous: &ActionDeliveryUsage) -> Self {
        Self {
            attempt_capacity_rejections: previous.attempt_capacity_rejections,
            pending_count_rejections: previous.pending_count_rejections,
            pending_byte_rejections: previous.pending_byte_rejections,
            expired_before_dispatch: previous.expired_before_dispatch,
            ..Self::default()
        }
    }

    fn add_entry(&mut self, entry: &ActionDeliveryEntry) {
        self.add_values(entry.app_id, entry.state, entry.reserved_bytes);
    }

    fn add_values(&mut self, app_id: AiAppId, state: ActionDeliveryState, reserved_bytes: usize) {
        self.total_attempts += 1;
        *self.attempts_by_app.entry(app_id).or_default() += 1;
        self.add_state(state);
        if is_pending_state(state) {
            self.pending_count += 1;
            self.pending_bytes = self.pending_bytes.saturating_add(reserved_bytes);
            let app = self.pending_by_app.entry(app_id).or_default();
            app.count += 1;
            app.bytes = app.bytes.saturating_add(reserved_bytes);
        }
    }

    fn remove_entry(&mut self, entry: &ActionDeliveryEntry) {
        self.remove_values(entry.app_id, entry.state, entry.reserved_bytes);
    }

    fn remove_values(&mut self, app_id: AiAppId, state: ActionDeliveryState, reserved_bytes: usize) {
        self.total_attempts = self.total_attempts.saturating_sub(1);
        decrement_map_count(&mut self.attempts_by_app, app_id);
        self.remove_state(state);
        if is_pending_state(state) {
            self.remove_pending(app_id, reserved_bytes);
        }
    }

    fn transition(
        &mut self,
        app_id: AiAppId,
        old_state: ActionDeliveryState,
        new_state: ActionDeliveryState,
        old_bytes: usize,
        new_bytes: usize,
    ) {
        self.remove_state(old_state);
        self.add_state(new_state);
        let was_pending = is_pending_state(old_state);
        let is_pending = is_pending_state(new_state);
        match (was_pending, is_pending) {
            (true, true) => self.replace_pending_bytes(app_id, old_bytes, new_bytes),
            (true, false) => self.remove_pending(app_id, old_bytes),
            (false, true) => {
                self.pending_count += 1;
                self.pending_bytes = self.pending_bytes.saturating_add(new_bytes);
                let app = self.pending_by_app.entry(app_id).or_default();
                app.count += 1;
                app.bytes = app.bytes.saturating_add(new_bytes);
            }
            (false, false) => {}
        }
    }

    fn replace_pending_bytes(&mut self, app_id: AiAppId, old_bytes: usize, new_bytes: usize) {
        self.pending_bytes = self.pending_bytes.saturating_sub(old_bytes).saturating_add(new_bytes);
        let app = self.pending_by_app.entry(app_id).or_default();
        app.bytes = app.bytes.saturating_sub(old_bytes).saturating_add(new_bytes);
    }

    fn remove_pending(&mut self, app_id: AiAppId, bytes: usize) {
        self.pending_count = self.pending_count.saturating_sub(1);
        self.pending_bytes = self.pending_bytes.saturating_sub(bytes);
        if let Some(app) = self.pending_by_app.get_mut(&app_id) {
            app.count = app.count.saturating_sub(1);
            app.bytes = app.bytes.saturating_sub(bytes);
            if app.count == 0 {
                self.pending_by_app.remove(&app_id);
            }
        }
    }

    fn add_state(&mut self, state: ActionDeliveryState) {
        *self.state_count_mut(state) += 1;
    }

    fn remove_state(&mut self, state: ActionDeliveryState) {
        let count = self.state_count_mut(state);
        *count = count.saturating_sub(1);
    }

    fn state_count_mut(&mut self, state: ActionDeliveryState) -> &mut usize {
        match state {
            ActionDeliveryState::Preparing { .. } => &mut self.preparing,
            ActionDeliveryState::InFlight { .. } => &mut self.in_flight,
            ActionDeliveryState::OutcomeUnknown { .. } => &mut self.outcome_unknown,
            ActionDeliveryState::Delivered { .. } => &mut self.delivered,
            ActionDeliveryState::Rejected { .. } => &mut self.rejected,
        }
    }
}

fn decrement_map_count(counts: &mut BTreeMap<AiAppId, usize>, app_id: AiAppId) {
    let remove = if let Some(count) = counts.get_mut(&app_id) {
        *count = count.saturating_sub(1);
        *count == 0
    } else {
        false
    };
    if remove {
        counts.remove(&app_id);
    }
}

impl ActionDeliveryOutbox {
    /// Starts a new immutable attempt, observes its durable result, or acquires the next epoch for
    /// replaying the already stored request. The caller must use `dispatch()` when `Dispatch` is
    /// returned; no caller-supplied route, key, ciphertext, or signature is consulted on that path.
    pub fn start(
        &mut self,
        attempt_id: ActionDeliveryAttemptId,
        app_id: AiAppId,
        reserved_bytes: usize,
        attempt_created_at: TimestampMillis,
        now: TimestampMillis,
    ) -> Result<ActionDeliveryStart, ActionDeliveryOutboxError> {
        self.start_in_slot(attempt_id, attempt_id, app_id, reserved_bytes, attempt_created_at, now)
    }

    /// Starts `attempt_id` after atomically claiming `slot_id`. An exact retry may observe or
    /// replay the winning attempt, but another attempt can never prepare or dispatch from the same
    /// semantic slot during the idempotency horizon.
    pub fn start_in_slot(
        &mut self,
        slot_id: ActionDeliverySlotId,
        attempt_id: ActionDeliveryAttemptId,
        app_id: AiAppId,
        reserved_bytes: usize,
        attempt_created_at: TimestampMillis,
        now: TimestampMillis,
    ) -> Result<ActionDeliveryStart, ActionDeliveryOutboxError> {
        self.advance_index_rebuild(HOT_PATH_INDEX_REBUILD_BATCH)?;
        self.prune_terminal(now);
        validate_request_size(reserved_bytes)?;

        if let Some(entry) = self.entries.get(&attempt_id) {
            let existing_slot_id = entry.logical_slot_id.unwrap_or(attempt_id);
            if existing_slot_id != slot_id {
                return Err(ActionDeliveryOutboxError::IdentityCollision);
            }
            if self.indexes_ready() && slot_id != attempt_id && self.logical_slots.get(&slot_id) != Some(&attempt_id) {
                return Err(ActionDeliveryOutboxError::IdentityCollision);
            }
            return self.start_existing(attempt_id, app_id, reserved_bytes, attempt_created_at, now);
        }

        if slot_id != attempt_id {
            if !self.indexes_ready() {
                return Err(ActionDeliveryOutboxError::IndexRebuilding);
            }
            if self.logical_slots.contains_key(&slot_id) {
                return Err(ActionDeliveryOutboxError::IdentityCollision);
            }
        }
        if !self.index_state.active_usage_trusted {
            return Err(ActionDeliveryOutboxError::IndexRebuilding);
        }

        if attempt_created_at > now {
            return Err(ActionDeliveryOutboxError::AttemptInFuture);
        }
        if !delivery_window_open(attempt_created_at, now) {
            self.increment_expired_before_dispatch();
            return Err(ActionDeliveryOutboxError::AttemptExpired);
        }
        if let Err(error) = self.check_attempt_capacity(app_id) {
            self.increment_attempt_capacity_rejections();
            return Err(error);
        }
        if let Err(error) = self.check_pending_capacity(app_id, reserved_bytes, None) {
            self.increment_pending_capacity_rejection(error);
            return Err(error);
        }
        self.entries.insert(
            attempt_id,
            ActionDeliveryEntry {
                logical_slot_id: (slot_id != attempt_id).then_some(slot_id),
                app_id,
                attempt_created_at,
                request: Vec::new(),
                destination: None,
                reserved_bytes,
                state: ActionDeliveryState::Preparing {
                    epoch: 1,
                    lease_started_at: now,
                },
            },
        );
        if slot_id != attempt_id {
            self.logical_slots.insert(slot_id, attempt_id);
        }
        self.add_inserted_entry_to_usage(attempt_id);
        Ok(ActionDeliveryStart::Prepare { epoch: 1 })
    }

    fn start_existing(
        &mut self,
        attempt_id: ActionDeliveryAttemptId,
        app_id: AiAppId,
        reserved_bytes: usize,
        attempt_created_at: TimestampMillis,
        now: TimestampMillis,
    ) -> Result<ActionDeliveryStart, ActionDeliveryOutboxError> {
        let entry = self.entries.get(&attempt_id).expect("entry existence checked");
        if entry.app_id != app_id || entry.attempt_created_at != attempt_created_at {
            return Err(ActionDeliveryOutboxError::IdentityCollision);
        }
        let state = entry.state;
        match state {
            ActionDeliveryState::Preparing { epoch, lease_started_at } if lease_expired(lease_started_at, now) => {
                if !delivery_window_open(attempt_created_at, now) {
                    self.remove_attempt(&attempt_id);
                    self.increment_expired_before_dispatch();
                    return Err(ActionDeliveryOutboxError::AttemptExpired);
                }
                if !self.index_state.active_usage_trusted {
                    return Err(ActionDeliveryOutboxError::IndexRebuilding);
                }
                if let Err(error) = self.check_pending_capacity(app_id, reserved_bytes, Some(attempt_id)) {
                    self.increment_pending_capacity_rejection(error);
                    return Err(error);
                }
                let next_epoch = epoch.checked_add(1).ok_or(ActionDeliveryOutboxError::StaleEpoch)?;
                let entry = self.entries.get_mut(&attempt_id).unwrap();
                let old_bytes = entry.reserved_bytes;
                entry.request.clear();
                entry.destination = None;
                entry.reserved_bytes = reserved_bytes;
                entry.state = ActionDeliveryState::Preparing {
                    epoch: next_epoch,
                    lease_started_at: now,
                };
                self.usage.replace_pending_bytes(app_id, old_bytes, reserved_bytes);
                if self.rebuild_has_scanned(&attempt_id) {
                    self.index_state
                        .rebuilt_usage
                        .replace_pending_bytes(app_id, old_bytes, reserved_bytes);
                }
                Ok(ActionDeliveryStart::Prepare { epoch: next_epoch })
            }
            ActionDeliveryState::Preparing { .. } => Ok(ActionDeliveryStart::Pending),
            ActionDeliveryState::InFlight { epoch, lease_started_at } if lease_expired(lease_started_at, now) => {
                if !delivery_window_open(attempt_created_at, now) {
                    self.remove_attempt(&attempt_id);
                    self.increment_expired_before_dispatch();
                    return Err(ActionDeliveryOutboxError::AttemptExpired);
                }
                let old_state = self.entries.get(&attempt_id).unwrap().state;
                begin_stored_retry(self.entries.get_mut(&attempt_id).unwrap(), epoch, now)?;
                let new_state = self.entries.get(&attempt_id).unwrap().state;
                self.replace_state_index(attempt_id, old_state, new_state);
                Ok(ActionDeliveryStart::Dispatch)
            }
            ActionDeliveryState::InFlight { .. } => Ok(ActionDeliveryStart::Pending),
            ActionDeliveryState::OutcomeUnknown { epoch, retry_after } if now >= retry_after => {
                if !delivery_window_open(attempt_created_at, now) {
                    self.remove_attempt(&attempt_id);
                    self.increment_expired_before_dispatch();
                    return Err(ActionDeliveryOutboxError::AttemptExpired);
                }
                let entry = self.entries.get_mut(&attempt_id).unwrap();
                let old_state = entry.state;
                begin_stored_retry(entry, epoch, now)?;
                let new_state = entry.state;
                let entry_bytes = entry.reserved_bytes;
                self.usage.transition(app_id, old_state, new_state, entry_bytes, entry_bytes);
                if self.rebuild_has_scanned(&attempt_id) {
                    self.index_state
                        .rebuilt_usage
                        .transition(app_id, old_state, new_state, entry_bytes, entry_bytes);
                }
                self.replace_state_index(attempt_id, old_state, new_state);
                Ok(ActionDeliveryStart::Dispatch)
            }
            ActionDeliveryState::OutcomeUnknown { .. } => Ok(ActionDeliveryStart::Pending),
            ActionDeliveryState::Delivered { .. } => Ok(ActionDeliveryStart::Delivered),
            ActionDeliveryState::Rejected { .. } => Ok(ActionDeliveryStart::Rejected),
        }
    }

    /// Replaces a preparation reservation with the exact immutable downstream request and starts
    /// its first external-call epoch. This transition must occur before the first await to the inbox.
    pub fn store_prepared(
        &mut self,
        attempt_id: ActionDeliveryAttemptId,
        epoch: u64,
        destination: Principal,
        request: Vec<u8>,
        now: TimestampMillis,
    ) -> Result<ActionDeliveryDispatch, ActionDeliveryOutboxError> {
        self.advance_index_rebuild(HOT_PATH_INDEX_REBUILD_BATCH)?;
        validate_request_size(request.len())?;
        let entry = self
            .entries
            .get_mut(&attempt_id)
            .ok_or(ActionDeliveryOutboxError::StaleEpoch)?;
        match entry.state {
            ActionDeliveryState::Preparing { epoch: current, .. } if current == epoch => {}
            _ => return Err(ActionDeliveryOutboxError::StaleEpoch),
        }
        if request.len() != entry.reserved_bytes {
            return Err(ActionDeliveryOutboxError::InvalidRequestSize);
        }
        if !delivery_window_open(entry.attempt_created_at, now) {
            self.increment_expired_before_dispatch();
            return Err(ActionDeliveryOutboxError::AttemptExpired);
        }
        let old_state = entry.state;
        entry.request = request;
        entry.destination = Some(destination);
        entry.state = ActionDeliveryState::InFlight {
            epoch,
            lease_started_at: now,
        };
        let app_id = entry.app_id;
        let new_state = entry.state;
        let entry_bytes = entry.reserved_bytes;
        self.usage.transition(app_id, old_state, new_state, entry_bytes, entry_bytes);
        if self.rebuild_has_scanned(&attempt_id) {
            self.index_state
                .rebuilt_usage
                .transition(app_id, old_state, new_state, entry_bytes, entry_bytes);
        }
        self.replace_state_index(attempt_id, old_state, new_state);
        dispatch_for(attempt_id, self.entries.get(&attempt_id).unwrap())
    }

    pub fn abort_preparation(&mut self, attempt_id: ActionDeliveryAttemptId, epoch: u64) {
        let _ = self.advance_index_rebuild(HOT_PATH_INDEX_REBUILD_BATCH);
        let remove = self.entries.get(&attempt_id).is_some_and(
            |entry| matches!(entry.state, ActionDeliveryState::Preparing { epoch: current, .. } if current == epoch),
        );
        if remove {
            self.remove_attempt(&attempt_id);
        }
    }

    pub fn dispatch(&self, attempt_id: ActionDeliveryAttemptId) -> Result<ActionDeliveryDispatch, ActionDeliveryOutboxError> {
        let entry = self
            .entries
            .get(&attempt_id)
            .ok_or(ActionDeliveryOutboxError::MissingPreparedRequest)?;
        dispatch_for(attempt_id, entry)
    }

    /// Applies one callback without allowing an old timeout/rejection to overwrite a newer epoch.
    /// A success is monotonic and dominates every earlier or later ambiguous/rejected callback.
    pub fn complete(
        &mut self,
        attempt_id: ActionDeliveryAttemptId,
        epoch: u64,
        result: ActionDeliveryRemoteResult,
        now: TimestampMillis,
    ) -> Result<ActionDeliveryCompletion, ActionDeliveryOutboxError> {
        self.advance_index_rebuild(HOT_PATH_INDEX_REBUILD_BATCH)?;
        let state = self
            .entries
            .get(&attempt_id)
            .ok_or(ActionDeliveryOutboxError::MissingPreparedRequest)?
            .state;

        if matches!(result, ActionDeliveryRemoteResult::Delivered) {
            self.make_attempt_terminal(attempt_id, ActionDeliveryState::Delivered { completed_at: now });
            self.prune_terminal(now);
            return Ok(ActionDeliveryCompletion::Delivered);
        }

        let current_epoch = match state {
            ActionDeliveryState::InFlight { epoch, .. } => epoch,
            ActionDeliveryState::Delivered { .. } => return Ok(ActionDeliveryCompletion::Delivered),
            ActionDeliveryState::Rejected { .. } => return Ok(ActionDeliveryCompletion::Rejected),
            ActionDeliveryState::OutcomeUnknown { .. } | ActionDeliveryState::Preparing { .. } => {
                return Ok(ActionDeliveryCompletion::OutcomeUnknown);
            }
        };
        if current_epoch != epoch {
            return Ok(ActionDeliveryCompletion::OutcomeUnknown);
        }

        match result {
            ActionDeliveryRemoteResult::Delivered => unreachable!(),
            ActionDeliveryRemoteResult::Rejected => {
                self.make_attempt_terminal(attempt_id, ActionDeliveryState::Rejected { completed_at: now });
                self.prune_terminal(now);
                Ok(ActionDeliveryCompletion::Rejected)
            }
            ActionDeliveryRemoteResult::OutcomeUnknown => {
                let (app_id, old_state, new_state, entry_bytes) = {
                    let entry = self.entries.get_mut(&attempt_id).unwrap();
                    let old_state = entry.state;
                    entry.state = ActionDeliveryState::OutcomeUnknown {
                        epoch,
                        retry_after: retry_due_at(now),
                    };
                    (entry.app_id, old_state, entry.state, entry.reserved_bytes)
                };
                self.usage.transition(app_id, old_state, new_state, entry_bytes, entry_bytes);
                if self.rebuild_has_scanned(&attempt_id) {
                    self.index_state
                        .rebuilt_usage
                        .transition(app_id, old_state, new_state, entry_bytes, entry_bytes);
                }
                self.replace_state_index(attempt_id, old_state, new_state);
                Ok(ActionDeliveryCompletion::OutcomeUnknown)
            }
        }
    }

    /// Acquires exactly one due stored request for the single-flight background delivery job.
    pub fn begin_due_retry(&mut self, now: TimestampMillis) -> Option<ActionDeliveryDispatch> {
        if !self
            .advance_index_rebuild(BACKGROUND_INDEX_REBUILD_BATCH)
            .ok()
            .unwrap_or(false)
        {
            return None;
        }
        self.prune_terminal(now);
        if !self.indexes_ready() {
            return None;
        }
        loop {
            let ((due_at, attempt_id), _) = self.retry_schedule.first_key_value()?;
            let due_at = *due_at;
            let attempt_id = *attempt_id;
            if due_at > now {
                return None;
            }
            let Some(entry) = self.entries.get(&attempt_id) else {
                self.invalidate_indexes_for_rebuild();
                return None;
            };
            if retry_due_state(entry.state) != Some(due_at) {
                self.invalidate_indexes_for_rebuild();
                return None;
            }
            if !delivery_window_open(entry.attempt_created_at, now) {
                self.remove_attempt(&attempt_id);
                self.increment_expired_before_dispatch();
                continue;
            }
            let epoch = match entry.state {
                ActionDeliveryState::InFlight { epoch, .. } | ActionDeliveryState::OutcomeUnknown { epoch, .. } => epoch,
                _ => return None,
            };
            let (app_id, old_state, new_state, entry_bytes) = {
                let entry = self.entries.get_mut(&attempt_id).unwrap();
                let old_state = entry.state;
                begin_stored_retry(entry, epoch, now).ok()?;
                (entry.app_id, old_state, entry.state, entry.reserved_bytes)
            };
            self.usage.transition(app_id, old_state, new_state, entry_bytes, entry_bytes);
            self.replace_state_index(attempt_id, old_state, new_state);
            return dispatch_for(attempt_id, self.entries.get(&attempt_id).unwrap()).ok();
        }
    }

    pub fn next_retry_at(&self) -> Option<TimestampMillis> {
        if self.index_state.rebuild_phase == ActionDeliveryIndexRebuildPhase::Failed {
            None
        } else if !self.indexes_ready() {
            // The existing zero-delay outbox timer performs the bounded migration batches.
            Some(0)
        } else {
            let retry_due = self.retry_schedule.first_key_value().map(|((due_at, _), _)| *due_at);
            let cleanup_due = self
                .terminal_expirations
                .first_key_value()
                .map(|((expires_at, _), _)| expires_at.saturating_add(1));
            retry_due.into_iter().chain(cleanup_due).min()
        }
    }

    pub fn metrics(&self) -> ActionDeliveryOutboxMetrics {
        let usage = &self.usage;
        ActionDeliveryOutboxMetrics {
            // The map length is exact even while a legacy usage index is being rebuilt.
            total_attempts: self.entries.len(),
            attempt_slots_remaining: MAX_ATTEMPTS_GLOBAL.saturating_sub(self.entries.len()),
            pending_entries: usage.pending_count,
            preparing: usage.preparing,
            in_flight: usage.in_flight,
            outcome_unknown: usage.outcome_unknown,
            pending_bytes: usage.pending_bytes,
            delivered_tombstones: usage.delivered,
            rejected_tombstones: usage.rejected,
            attempt_capacity_rejections: usage.attempt_capacity_rejections,
            pending_count_rejections: usage.pending_count_rejections,
            pending_byte_rejections: usage.pending_byte_rejections,
            expired_before_dispatch: usage.expired_before_dispatch,
            index_rebuilding: !self.indexes_ready()
                && self.index_state.rebuild_phase != ActionDeliveryIndexRebuildPhase::Failed,
            index_rebuild_failed: self.index_state.rebuild_phase == ActionDeliveryIndexRebuildPhase::Failed,
        }
    }

    fn check_pending_capacity(
        &self,
        app_id: AiAppId,
        requested_bytes: usize,
        replacing: Option<ActionDeliveryAttemptId>,
    ) -> Result<(), ActionDeliveryOutboxError> {
        let replaced_bytes = replacing
            .and_then(|attempt_id| self.entries.get(&attempt_id))
            .filter(|entry| is_pending(entry))
            .map(|entry| entry.reserved_bytes)
            .unwrap_or_default();
        let replacing_pending = usize::from(replaced_bytes > 0);
        let app_usage = self.usage.pending_by_app.get(&app_id);
        let global_count = self.usage.pending_count.saturating_sub(replacing_pending);
        let app_count = app_usage.map_or(0, |usage| usage.count).saturating_sub(replacing_pending);
        let global_bytes = self.usage.pending_bytes.saturating_sub(replaced_bytes);
        let app_bytes = app_usage.map_or(0, |usage| usage.bytes).saturating_sub(replaced_bytes);
        if global_count >= MAX_PENDING_GLOBAL || app_count >= MAX_PENDING_PER_APP {
            return Err(ActionDeliveryOutboxError::PendingCapacity);
        }
        if global_bytes.saturating_add(requested_bytes) > MAX_PENDING_BYTES_GLOBAL
            || app_bytes.saturating_add(requested_bytes) > MAX_PENDING_BYTES_PER_APP
        {
            return Err(ActionDeliveryOutboxError::PendingByteCapacity);
        }
        Ok(())
    }

    /// Every pending attempt reserves its future terminal slot. Therefore a terminal transition
    /// cannot overflow and never needs to evict an unexpired semantic outcome.
    fn check_attempt_capacity(&self, app_id: AiAppId) -> Result<(), ActionDeliveryOutboxError> {
        let app_attempts = self.usage.attempts_by_app.get(&app_id).copied().unwrap_or_default();
        if !attempt_capacity_available(self.usage.total_attempts, app_attempts) {
            Err(ActionDeliveryOutboxError::PendingCapacity)
        } else {
            Ok(())
        }
    }

    fn prune_terminal(&mut self, now: TimestampMillis) {
        if !self.indexes_ready() {
            return;
        }
        for _ in 0..TERMINAL_PRUNE_BATCH {
            let Some(((expires_at, attempt_id), _)) = self.terminal_expirations.first_key_value() else {
                break;
            };
            let expires_at = *expires_at;
            let attempt_id = *attempt_id;
            if now <= expires_at {
                break;
            }
            let valid = self
                .entries
                .get(&attempt_id)
                .and_then(|entry| terminal_completed_at_state(entry.state))
                .is_some_and(|completed_at| terminal_expires_at(completed_at) == expires_at);
            if !valid {
                self.invalidate_indexes_for_rebuild();
                break;
            }
            self.remove_attempt(&attempt_id);
        }
    }

    fn indexes_ready(&self) -> bool {
        self.index_state.version == ACTION_DELIVERY_INDEX_VERSION
            && self.index_state.rebuild_phase != ActionDeliveryIndexRebuildPhase::Failed
            && self.index_state.active_usage_trusted
            && self.usage.total_attempts == self.entries.len()
    }

    fn invalidate_indexes_for_rebuild(&mut self) {
        self.index_state.version = 0;
        self.index_state.rebuild_phase = ActionDeliveryIndexRebuildPhase::Uninitialized;
        self.index_state.rebuild_cursor = None;
        self.index_state.active_usage_trusted = false;
    }

    /// Advances a legacy index rebuild by at most `budget` entries (or stale index keys). The
    /// cursor and partial usage aggregate are persisted, so upgrades during migration resume from
    /// the same point. No public hot path performs an unbounded map walk.
    fn advance_index_rebuild(&mut self, budget: usize) -> Result<bool, ActionDeliveryOutboxError> {
        if self.indexes_ready() {
            return Ok(true);
        }
        if self.index_state.version == ACTION_DELIVERY_INDEX_VERSION
            && self.index_state.rebuild_phase != ActionDeliveryIndexRebuildPhase::Failed
        {
            self.index_state.version = 0;
            self.index_state.rebuild_phase = ActionDeliveryIndexRebuildPhase::Uninitialized;
            self.index_state.active_usage_trusted = false;
        }
        if self.index_state.rebuild_phase == ActionDeliveryIndexRebuildPhase::Failed {
            return Err(ActionDeliveryOutboxError::IdentityCollision);
        }
        if self.index_state.rebuild_phase == ActionDeliveryIndexRebuildPhase::Uninitialized {
            self.index_state.active_usage_trusted = self.usage.total_attempts == self.entries.len();
            self.index_state.rebuilt_usage = ActionDeliveryUsage::counters_only(&self.usage);
            self.index_state.rebuild_cursor = None;
            self.index_state.rebuild_phase = ActionDeliveryIndexRebuildPhase::Clearing;
        }

        let mut remaining = budget.max(1);
        if self.index_state.rebuild_phase == ActionDeliveryIndexRebuildPhase::Clearing {
            #[cfg(test)]
            let remaining_before_clear = remaining;
            remove_first_keys(&mut self.logical_slots, &mut remaining);
            remove_first_keys(&mut self.terminal_expirations, &mut remaining);
            remove_first_keys(&mut self.retry_schedule, &mut remaining);
            #[cfg(test)]
            {
                self.entry_scan_visits = self
                    .entry_scan_visits
                    .saturating_add(remaining_before_clear.saturating_sub(remaining));
            }
            if !self.logical_slots.is_empty() || !self.terminal_expirations.is_empty() || !self.retry_schedule.is_empty() {
                return Ok(false);
            }
            self.index_state.rebuild_phase = ActionDeliveryIndexRebuildPhase::Scanning;
            self.index_state.rebuild_cursor = None;
            self.index_state.rebuilt_usage = ActionDeliveryUsage::counters_only(&self.usage);
        }

        if remaining == 0 {
            return Ok(false);
        }
        let start = self.index_state.rebuild_cursor.map_or(Unbounded, Excluded);
        let facts: Vec<_> = self
            .entries
            .range((start, Unbounded))
            .take(remaining)
            .map(|(attempt_id, entry)| {
                (
                    *attempt_id,
                    entry.logical_slot_id,
                    entry.app_id,
                    entry.state,
                    entry.reserved_bytes,
                )
            })
            .collect();
        #[cfg(test)]
        {
            self.entry_scan_visits = self.entry_scan_visits.saturating_add(facts.len());
        }

        for (attempt_id, logical_slot_id, app_id, state, reserved_bytes) in &facts {
            if let Some(slot_id) = logical_slot_id
                && self.logical_slots.insert(*slot_id, *attempt_id).is_some()
            {
                self.index_state.rebuild_phase = ActionDeliveryIndexRebuildPhase::Failed;
                return Err(ActionDeliveryOutboxError::IdentityCollision);
            }
            add_state_to_index(&mut self.terminal_expirations, &mut self.retry_schedule, *attempt_id, *state);
            self.index_state.rebuilt_usage.add_values(*app_id, *state, *reserved_bytes);
        }

        if let Some((last, ..)) = facts.last() {
            self.index_state.rebuild_cursor = Some(*last);
        }
        let has_more = self
            .index_state
            .rebuild_cursor
            .is_some_and(|cursor| self.entries.range((Excluded(cursor), Unbounded)).next().is_some());
        if has_more {
            return Ok(false);
        }

        self.usage = std::mem::take(&mut self.index_state.rebuilt_usage);
        self.index_state.version = ACTION_DELIVERY_INDEX_VERSION;
        self.index_state.rebuild_phase = ActionDeliveryIndexRebuildPhase::Uninitialized;
        self.index_state.rebuild_cursor = None;
        self.index_state.active_usage_trusted = true;
        Ok(true)
    }

    fn rebuild_has_scanned(&self, attempt_id: &ActionDeliveryAttemptId) -> bool {
        self.index_state.rebuild_phase == ActionDeliveryIndexRebuildPhase::Scanning
            && self.index_state.rebuild_cursor.is_some_and(|cursor| *attempt_id <= cursor)
    }

    fn add_inserted_entry_to_usage(&mut self, attempt_id: ActionDeliveryAttemptId) {
        let entry = self.entries.get(&attempt_id).unwrap();
        self.usage.add_entry(entry);
        if self.rebuild_has_scanned(&attempt_id) {
            self.index_state
                .rebuilt_usage
                .add_values(entry.app_id, entry.state, entry.reserved_bytes);
        }
    }

    fn replace_state_index(
        &mut self,
        attempt_id: ActionDeliveryAttemptId,
        old_state: ActionDeliveryState,
        new_state: ActionDeliveryState,
    ) {
        remove_state_from_index(
            &mut self.terminal_expirations,
            &mut self.retry_schedule,
            attempt_id,
            old_state,
        );
        add_state_to_index(
            &mut self.terminal_expirations,
            &mut self.retry_schedule,
            attempt_id,
            new_state,
        );
    }

    fn make_attempt_terminal(&mut self, attempt_id: ActionDeliveryAttemptId, terminal_state: ActionDeliveryState) {
        let (app_id, old_state, old_bytes, new_state, new_bytes) = {
            let entry = self.entries.get_mut(&attempt_id).unwrap();
            let old_state = entry.state;
            let old_bytes = entry.reserved_bytes;
            make_terminal(entry, terminal_state);
            (entry.app_id, old_state, old_bytes, entry.state, entry.reserved_bytes)
        };
        self.usage.transition(app_id, old_state, new_state, old_bytes, new_bytes);
        if self.rebuild_has_scanned(&attempt_id) {
            self.index_state
                .rebuilt_usage
                .transition(app_id, old_state, new_state, old_bytes, new_bytes);
        }
        self.replace_state_index(attempt_id, old_state, new_state);
    }

    fn increment_expired_before_dispatch(&mut self) {
        self.usage.expired_before_dispatch = self.usage.expired_before_dispatch.saturating_add(1);
        if self.index_state.rebuild_phase == ActionDeliveryIndexRebuildPhase::Scanning {
            self.index_state.rebuilt_usage.expired_before_dispatch =
                self.index_state.rebuilt_usage.expired_before_dispatch.saturating_add(1);
        }
    }

    fn increment_attempt_capacity_rejections(&mut self) {
        self.usage.attempt_capacity_rejections = self.usage.attempt_capacity_rejections.saturating_add(1);
        if self.index_state.rebuild_phase == ActionDeliveryIndexRebuildPhase::Scanning {
            self.index_state.rebuilt_usage.attempt_capacity_rejections =
                self.index_state.rebuilt_usage.attempt_capacity_rejections.saturating_add(1);
        }
    }

    fn increment_pending_capacity_rejection(&mut self, error: ActionDeliveryOutboxError) {
        match error {
            ActionDeliveryOutboxError::PendingCapacity => {
                self.usage.pending_count_rejections = self.usage.pending_count_rejections.saturating_add(1);
                if self.index_state.rebuild_phase == ActionDeliveryIndexRebuildPhase::Scanning {
                    self.index_state.rebuilt_usage.pending_count_rejections =
                        self.index_state.rebuilt_usage.pending_count_rejections.saturating_add(1);
                }
            }
            ActionDeliveryOutboxError::PendingByteCapacity => {
                self.usage.pending_byte_rejections = self.usage.pending_byte_rejections.saturating_add(1);
                if self.index_state.rebuild_phase == ActionDeliveryIndexRebuildPhase::Scanning {
                    self.index_state.rebuilt_usage.pending_byte_rejections =
                        self.index_state.rebuilt_usage.pending_byte_rejections.saturating_add(1);
                }
            }
            _ => {}
        }
    }

    fn remove_attempt(&mut self, attempt_id: &ActionDeliveryAttemptId) {
        if let Some(entry) = self.entries.remove(attempt_id) {
            if let Some(slot_id) = entry.logical_slot_id
                && self.logical_slots.get(&slot_id) == Some(attempt_id)
            {
                self.logical_slots.remove(&slot_id);
            }
            remove_state_from_index(
                &mut self.terminal_expirations,
                &mut self.retry_schedule,
                *attempt_id,
                entry.state,
            );
            self.usage.remove_entry(&entry);
            if self.rebuild_has_scanned(attempt_id) {
                self.index_state
                    .rebuilt_usage
                    .remove_values(entry.app_id, entry.state, entry.reserved_bytes);
            }
        }
    }
}

fn remove_first_keys<K: Ord + Clone, V>(map: &mut BTreeMap<K, V>, remaining: &mut usize) {
    while *remaining > 0 {
        let Some(key) = map.first_key_value().map(|(key, _)| key.clone()) else {
            break;
        };
        map.remove(&key);
        *remaining -= 1;
    }
}

fn add_state_to_index(
    terminal_expirations: &mut BTreeMap<(TimestampMillis, ActionDeliveryAttemptId), ()>,
    retry_schedule: &mut BTreeMap<(TimestampMillis, ActionDeliveryAttemptId), ()>,
    attempt_id: ActionDeliveryAttemptId,
    state: ActionDeliveryState,
) {
    if let Some(completed_at) = terminal_completed_at_state(state) {
        terminal_expirations.insert((terminal_expires_at(completed_at), attempt_id), ());
    }
    if let Some(due_at) = retry_due_state(state) {
        retry_schedule.insert((due_at, attempt_id), ());
    }
}

fn remove_state_from_index(
    terminal_expirations: &mut BTreeMap<(TimestampMillis, ActionDeliveryAttemptId), ()>,
    retry_schedule: &mut BTreeMap<(TimestampMillis, ActionDeliveryAttemptId), ()>,
    attempt_id: ActionDeliveryAttemptId,
    state: ActionDeliveryState,
) {
    if let Some(completed_at) = terminal_completed_at_state(state) {
        terminal_expirations.remove(&(terminal_expires_at(completed_at), attempt_id));
    }
    if let Some(due_at) = retry_due_state(state) {
        retry_schedule.remove(&(due_at, attempt_id));
    }
}

fn terminal_expires_at(completed_at: TimestampMillis) -> TimestampMillis {
    completed_at.saturating_add(ACTION_DELIVERY_IDEMPOTENCY_HORIZON_MS)
}

fn validate_request_size(request_bytes: usize) -> Result<(), ActionDeliveryOutboxError> {
    if request_bytes == 0 || request_bytes > MAX_ACTION_DELIVERY_REQUEST_BYTES {
        Err(ActionDeliveryOutboxError::InvalidRequestSize)
    } else {
        Ok(())
    }
}

fn begin_stored_retry(
    entry: &mut ActionDeliveryEntry,
    epoch: u64,
    now: TimestampMillis,
) -> Result<(), ActionDeliveryOutboxError> {
    if entry.request.is_empty() || entry.destination.is_none() {
        return Err(ActionDeliveryOutboxError::MissingPreparedRequest);
    }
    let next_epoch = epoch.checked_add(1).ok_or(ActionDeliveryOutboxError::StaleEpoch)?;
    entry.state = ActionDeliveryState::InFlight {
        epoch: next_epoch,
        lease_started_at: now,
    };
    Ok(())
}

fn dispatch_for(
    attempt_id: ActionDeliveryAttemptId,
    entry: &ActionDeliveryEntry,
) -> Result<ActionDeliveryDispatch, ActionDeliveryOutboxError> {
    let ActionDeliveryState::InFlight { epoch, .. } = entry.state else {
        return Err(ActionDeliveryOutboxError::MissingPreparedRequest);
    };
    let destination = entry.destination.ok_or(ActionDeliveryOutboxError::MissingPreparedRequest)?;
    if entry.request.is_empty() {
        return Err(ActionDeliveryOutboxError::MissingPreparedRequest);
    }
    Ok(ActionDeliveryDispatch {
        attempt_id,
        epoch,
        destination,
        request: entry.request.clone(),
    })
}

fn make_terminal(entry: &mut ActionDeliveryEntry, state: ActionDeliveryState) {
    entry.request.clear();
    entry.destination = None;
    entry.reserved_bytes = 0;
    entry.state = state;
}

fn is_pending(entry: &ActionDeliveryEntry) -> bool {
    is_pending_state(entry.state)
}

fn is_pending_state(state: ActionDeliveryState) -> bool {
    matches!(
        state,
        ActionDeliveryState::Preparing { .. }
            | ActionDeliveryState::InFlight { .. }
            | ActionDeliveryState::OutcomeUnknown { .. }
    )
}

fn terminal_completed_at_state(state: ActionDeliveryState) -> Option<TimestampMillis> {
    match state {
        ActionDeliveryState::Delivered { completed_at } | ActionDeliveryState::Rejected { completed_at } => Some(completed_at),
        _ => None,
    }
}

fn retry_due_state(state: ActionDeliveryState) -> Option<TimestampMillis> {
    match state {
        ActionDeliveryState::InFlight { lease_started_at, .. } => Some(retry_due_at(lease_started_at)),
        ActionDeliveryState::OutcomeUnknown { retry_after, .. } => Some(retry_after),
        _ => None,
    }
}

fn retry_due_at(timestamp: TimestampMillis) -> TimestampMillis {
    timestamp.saturating_add(ACTION_DELIVERY_LEASE_MS).saturating_add(1)
}

fn delivery_window_open(attempt_created_at: TimestampMillis, now: TimestampMillis) -> bool {
    attempt_created_at <= now
        && now.saturating_add(ACTION_DELIVERY_NETWORK_BUDGET_MS)
            <= attempt_created_at.saturating_add(ACTION_DELIVERY_IDEMPOTENCY_HORIZON_MS)
}

fn attempt_capacity_available(global_attempts: usize, app_attempts: usize) -> bool {
    global_attempts < MAX_ATTEMPTS_GLOBAL && app_attempts < MAX_ATTEMPTS_PER_APP
}

fn lease_expired(lease_started_at: TimestampMillis, now: TimestampMillis) -> bool {
    now > lease_started_at.saturating_add(ACTION_DELIVERY_LEASE_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(value: u8) -> ActionDeliveryAttemptId {
        [value; 32]
    }

    fn numbered_id(value: u16) -> ActionDeliveryAttemptId {
        let mut attempt_id = [0u8; 32];
        attempt_id[..2].copy_from_slice(&value.to_be_bytes());
        attempt_id
    }

    fn prepare(
        outbox: &mut ActionDeliveryOutbox,
        attempt_id: ActionDeliveryAttemptId,
        app_id: AiAppId,
        now: TimestampMillis,
    ) -> ActionDeliveryDispatch {
        assert_eq!(
            outbox.start(attempt_id, app_id, 3, now, now),
            Ok(ActionDeliveryStart::Prepare { epoch: 1 })
        );
        outbox
            .store_prepared(attempt_id, 1, Principal::from_slice(&[9]), vec![1, 2, 3], now)
            .unwrap()
    }

    #[test]
    fn logical_slot_rejects_a_competing_attempt_before_it_can_be_prepared() {
        let mut outbox = ActionDeliveryOutbox::default();
        let slot_id = id(40);
        let winner_attempt_id = id(41);
        let competing_attempt_id = id(42);

        assert_eq!(
            outbox.start_in_slot(slot_id, winner_attempt_id, 7, 3, 100, 100),
            Ok(ActionDeliveryStart::Prepare { epoch: 1 })
        );
        assert_eq!(
            outbox.start_in_slot(slot_id, competing_attempt_id, 7, 3, 100, 100),
            Err(ActionDeliveryOutboxError::IdentityCollision)
        );
        assert_eq!(outbox.metrics().total_attempts, 1);
        assert_eq!(outbox.metrics().preparing, 1);
    }

    #[test]
    fn logical_slot_allows_only_the_exact_attempt_to_observe_its_result() {
        let mut outbox = ActionDeliveryOutbox::default();
        let slot_id = id(43);
        let attempt_id = id(44);

        assert_eq!(
            outbox.start_in_slot(slot_id, attempt_id, 7, 3, 100, 100),
            Ok(ActionDeliveryStart::Prepare { epoch: 1 })
        );
        assert_eq!(
            outbox.start_in_slot(slot_id, attempt_id, 7, 3, 100, 101),
            Ok(ActionDeliveryStart::Pending)
        );
        let dispatch = outbox
            .store_prepared(attempt_id, 1, Principal::from_slice(&[9]), vec![1, 2, 3], 101)
            .unwrap();
        outbox
            .complete(
                dispatch.attempt_id,
                dispatch.epoch,
                ActionDeliveryRemoteResult::Delivered,
                102,
            )
            .unwrap();
        assert_eq!(
            outbox.start_in_slot(slot_id, attempt_id, 7, 3, 100, 103),
            Ok(ActionDeliveryStart::Delivered)
        );
        assert_eq!(
            outbox.start_in_slot(slot_id, id(45), 7, 3, 100, 103),
            Err(ActionDeliveryOutboxError::IdentityCollision)
        );
    }

    #[test]
    fn logical_slot_binding_survives_every_persisted_delivery_state() {
        let slot_id = id(46);
        let attempt_id = id(47);
        let competitor_id = id(48);

        let mut preparing = ActionDeliveryOutbox::default();
        preparing.start_in_slot(slot_id, attempt_id, 7, 3, 100, 100).unwrap();

        let mut in_flight = ActionDeliveryOutbox::default();
        in_flight.start_in_slot(slot_id, attempt_id, 7, 3, 100, 100).unwrap();
        let in_flight_dispatch = in_flight
            .store_prepared(attempt_id, 1, Principal::from_slice(&[9]), vec![1, 2, 3], 100)
            .unwrap();
        let persisted_in_flight: ActionDeliveryOutbox =
            msgpack::deserialize(msgpack::serialize_to_vec(&in_flight).unwrap().as_slice()).unwrap();

        let mut outcome_unknown: ActionDeliveryOutbox =
            msgpack::deserialize(msgpack::serialize_to_vec(&in_flight).unwrap().as_slice()).unwrap();
        outcome_unknown
            .complete(
                attempt_id,
                in_flight_dispatch.epoch,
                ActionDeliveryRemoteResult::OutcomeUnknown,
                101,
            )
            .unwrap();

        let mut delivered: ActionDeliveryOutbox =
            msgpack::deserialize(msgpack::serialize_to_vec(&in_flight).unwrap().as_slice()).unwrap();
        delivered
            .complete(
                attempt_id,
                in_flight_dispatch.epoch,
                ActionDeliveryRemoteResult::Delivered,
                101,
            )
            .unwrap();

        let mut rejected = in_flight;
        rejected
            .complete(
                attempt_id,
                in_flight_dispatch.epoch,
                ActionDeliveryRemoteResult::Rejected,
                101,
            )
            .unwrap();

        for state in [preparing, persisted_in_flight, outcome_unknown, delivered, rejected] {
            let bytes = msgpack::serialize_to_vec(&state).unwrap();
            let mut restored: ActionDeliveryOutbox = msgpack::deserialize(bytes.as_slice()).unwrap();
            assert_eq!(restored.logical_slots.get(&slot_id), Some(&attempt_id));
            assert_eq!(
                restored.start_in_slot(slot_id, competitor_id, 7, 3, 100, 102),
                Err(ActionDeliveryOutboxError::IdentityCollision)
            );
        }
    }

    #[test]
    fn legacy_snapshot_without_logical_slot_fields_preserves_default_slot_semantics() {
        #[derive(serde::Serialize)]
        struct LegacyOutbox {
            entries: BTreeMap<ActionDeliveryAttemptId, LegacyEntry>,
            usage: ActionDeliveryUsage,
        }

        #[derive(serde::Serialize)]
        struct LegacyEntry {
            app_id: AiAppId,
            attempt_created_at: TimestampMillis,
            request: Vec<u8>,
            destination: Option<Principal>,
            reserved_bytes: usize,
            state: ActionDeliveryState,
        }

        let attempt_id = id(49);
        let legacy = LegacyOutbox {
            entries: BTreeMap::from([(
                attempt_id,
                LegacyEntry {
                    app_id: 7,
                    attempt_created_at: 100,
                    request: Vec::new(),
                    destination: None,
                    reserved_bytes: 3,
                    state: ActionDeliveryState::Preparing {
                        epoch: 1,
                        lease_started_at: 100,
                    },
                },
            )]),
            usage: ActionDeliveryUsage::default(),
        };
        let bytes = msgpack::serialize_to_vec(legacy).unwrap();
        let mut restored: ActionDeliveryOutbox = msgpack::deserialize(bytes.as_slice()).unwrap();

        assert!(restored.logical_slots.is_empty());
        assert_eq!(restored.start(attempt_id, 7, 3, 100, 101), Ok(ActionDeliveryStart::Pending));
        assert_eq!(restored.metrics().total_attempts, 1);
    }

    #[test]
    fn abort_expiry_and_capacity_rejection_do_not_leave_logical_slot_claims() {
        let slot_id = id(50);
        let first_attempt = id(51);
        let second_attempt = id(52);
        let mut outbox = ActionDeliveryOutbox::default();
        assert_eq!(
            outbox.start_in_slot(slot_id, first_attempt, 7, 3, 100, 100),
            Ok(ActionDeliveryStart::Prepare { epoch: 1 })
        );
        outbox.abort_preparation(first_attempt, 1);
        assert!(outbox.logical_slots.is_empty());
        assert_eq!(
            outbox.start_in_slot(slot_id, second_attempt, 7, 3, 100, 100),
            Ok(ActionDeliveryStart::Prepare { epoch: 1 })
        );

        let dispatch = outbox
            .store_prepared(second_attempt, 1, Principal::from_slice(&[9]), vec![1, 2, 3], 100)
            .unwrap();
        outbox
            .complete(second_attempt, dispatch.epoch, ActionDeliveryRemoteResult::Delivered, 101)
            .unwrap();
        outbox.prune_terminal(101 + ACTION_DELIVERY_IDEMPOTENCY_HORIZON_MS + 1);
        assert!(outbox.logical_slots.is_empty());

        outbox.usage.attempts_by_app.insert(7, MAX_ATTEMPTS_PER_APP);
        assert_eq!(
            outbox.start_in_slot(slot_id, id(53), 7, 3, 200, 200),
            Err(ActionDeliveryOutboxError::PendingCapacity)
        );
        assert!(outbox.logical_slots.is_empty());
        assert!(outbox.entries.is_empty());
    }

    #[test]
    fn concurrent_exact_retry_is_single_flight_and_reuses_exact_request_after_drift() {
        let mut outbox = ActionDeliveryOutbox::default();
        let first = prepare(&mut outbox, id(1), 7, 100);
        assert_eq!(first.request, vec![1, 2, 3]);
        assert_eq!(first.destination, Principal::from_slice(&[9]));

        assert_eq!(outbox.start(id(1), 7, 3, 100, 30_100), Ok(ActionDeliveryStart::Pending));
        assert_eq!(outbox.start(id(1), 7, 99, 100, 30_101), Ok(ActionDeliveryStart::Dispatch));
        let retry = outbox.dispatch(id(1)).unwrap();
        assert_eq!(retry.epoch, 2);
        assert_eq!(retry.request, first.request);
        assert_eq!(retry.destination, first.destination);
    }

    #[test]
    fn timeout_is_ambiguous_then_background_retry_replays_stored_bytes() {
        let mut outbox = ActionDeliveryOutbox::default();
        let first = prepare(&mut outbox, id(2), 7, 1);
        assert_eq!(
            outbox.complete(id(2), first.epoch, ActionDeliveryRemoteResult::OutcomeUnknown, 20),
            Ok(ActionDeliveryCompletion::OutcomeUnknown)
        );
        assert!(outbox.begin_due_retry(30_020).is_none());
        let retry = outbox.begin_due_retry(30_021).unwrap();
        assert_eq!(retry.request, first.request);
        assert_eq!(retry.destination, first.destination);
        assert_eq!(retry.epoch, first.epoch + 1);
    }

    #[test]
    fn terminal_replay_survives_lost_upstream_reply() {
        let mut delivered = ActionDeliveryOutbox::default();
        let dispatch = prepare(&mut delivered, id(3), 7, 1);
        assert_eq!(
            delivered.complete(id(3), dispatch.epoch, ActionDeliveryRemoteResult::Delivered, 2),
            Ok(ActionDeliveryCompletion::Delivered)
        );
        assert_eq!(delivered.start(id(3), 7, 3, 1, 3), Ok(ActionDeliveryStart::Delivered));

        let mut rejected = ActionDeliveryOutbox::default();
        let dispatch = prepare(&mut rejected, id(4), 7, 1);
        assert_eq!(
            rejected.complete(id(4), dispatch.epoch, ActionDeliveryRemoteResult::Rejected, 2),
            Ok(ActionDeliveryCompletion::Rejected)
        );
        assert_eq!(rejected.start(id(4), 7, 3, 1, 3), Ok(ActionDeliveryStart::Rejected));
    }

    #[test]
    fn stale_failure_cannot_overwrite_newer_attempt_and_success_always_dominates() {
        let mut outbox = ActionDeliveryOutbox::default();
        let first = prepare(&mut outbox, id(5), 7, 1);
        assert_eq!(outbox.start(id(5), 7, 3, 1, 30_002), Ok(ActionDeliveryStart::Dispatch));
        let second = outbox.dispatch(id(5)).unwrap();

        assert_eq!(
            outbox.complete(id(5), first.epoch, ActionDeliveryRemoteResult::Rejected, 30_003),
            Ok(ActionDeliveryCompletion::OutcomeUnknown)
        );
        assert_eq!(
            outbox.complete(id(5), second.epoch, ActionDeliveryRemoteResult::Rejected, 30_004),
            Ok(ActionDeliveryCompletion::Rejected)
        );
        assert_eq!(
            outbox.complete(id(5), first.epoch, ActionDeliveryRemoteResult::Delivered, 30_005),
            Ok(ActionDeliveryCompletion::Delivered)
        );
        assert_eq!(outbox.start(id(5), 7, 3, 1, 30_006), Ok(ActionDeliveryStart::Delivered));
    }

    #[test]
    fn per_app_pending_cap_leaves_global_headroom_for_another_app() {
        let mut outbox = ActionDeliveryOutbox::default();
        for value in 1..=MAX_PENDING_PER_APP as u8 {
            assert!(matches!(
                outbox.start(id(value), 1, 1, 1, 1),
                Ok(ActionDeliveryStart::Prepare { .. })
            ));
        }
        assert_eq!(
            outbox.start(id(100), 1, 1, 1, 1),
            Err(ActionDeliveryOutboxError::PendingCapacity)
        );
        assert!(matches!(
            outbox.start(id(101), 2, 1, 1, 1),
            Ok(ActionDeliveryStart::Prepare { .. })
        ));
        assert_eq!(outbox.metrics().pending_count_rejections, 1);
    }

    #[test]
    fn global_pending_count_cap_is_exact_and_reported() {
        let mut outbox = ActionDeliveryOutbox::default();
        let mut attempt = 1u8;
        for app_id in 1..=MAX_PENDING_GLOBAL / MAX_PENDING_PER_APP {
            for _ in 0..MAX_PENDING_PER_APP {
                assert!(matches!(
                    outbox.start(id(attempt), app_id as AiAppId, 1, 1, 1),
                    Ok(ActionDeliveryStart::Prepare { .. })
                ));
                attempt += 1;
            }
        }
        assert_eq!(usize::from(attempt) - 1, MAX_PENDING_GLOBAL);
        assert_eq!(
            outbox.start(id(attempt), 99, 1, 1, 1),
            Err(ActionDeliveryOutboxError::PendingCapacity)
        );
        let metrics = outbox.metrics();
        assert_eq!(metrics.pending_entries, MAX_PENDING_GLOBAL);
        assert_eq!(metrics.pending_count_rejections, 1);
    }

    #[test]
    fn byte_caps_never_evict_pending_work_and_preserve_other_app_headroom() {
        let mut outbox = ActionDeliveryOutbox::default();
        for value in 1..=MAX_PENDING_BYTES_PER_APP / MAX_ACTION_DELIVERY_REQUEST_BYTES {
            assert!(matches!(
                outbox.start(numbered_id(value as u16), 1, MAX_ACTION_DELIVERY_REQUEST_BYTES, 1, 1),
                Ok(ActionDeliveryStart::Prepare { .. })
            ));
        }
        assert_eq!(
            outbox.start(id(50), 1, 1, 1, 1),
            Err(ActionDeliveryOutboxError::PendingByteCapacity)
        );
        assert!(matches!(
            outbox.start(id(51), 2, 1, 1, 1),
            Ok(ActionDeliveryStart::Prepare { .. })
        ));
        assert_eq!(
            outbox.metrics().preparing,
            MAX_PENDING_BYTES_PER_APP / MAX_ACTION_DELIVERY_REQUEST_BYTES + 1
        );
        assert_eq!(outbox.metrics().pending_byte_rejections, 1);
    }

    #[test]
    fn global_pending_byte_cap_is_exact_and_reported() {
        let mut outbox = ActionDeliveryOutbox::default();
        let attempts_per_app = MAX_PENDING_BYTES_PER_APP / MAX_ACTION_DELIVERY_REQUEST_BYTES;
        let app_count = MAX_PENDING_BYTES_GLOBAL / MAX_PENDING_BYTES_PER_APP;
        let mut attempt = 1u8;
        for app_id in 1..=app_count {
            for _ in 0..attempts_per_app {
                assert!(matches!(
                    outbox.start(id(attempt), app_id as AiAppId, MAX_ACTION_DELIVERY_REQUEST_BYTES, 1, 1,),
                    Ok(ActionDeliveryStart::Prepare { .. })
                ));
                attempt += 1;
            }
        }
        assert_eq!(outbox.metrics().pending_bytes, MAX_PENDING_BYTES_GLOBAL);
        assert_eq!(
            outbox.start(id(attempt), 99, 1, 1, 1),
            Err(ActionDeliveryOutboxError::PendingByteCapacity)
        );
        assert_eq!(outbox.metrics().pending_byte_rejections, 1);
    }

    #[test]
    fn serialized_preparing_lease_is_epoch_safe_after_lost_validation_callback() {
        let mut outbox = ActionDeliveryOutbox::default();
        assert_eq!(outbox.start(id(6), 7, 3, 1, 1), Ok(ActionDeliveryStart::Prepare { epoch: 1 }));
        let bytes = msgpack::serialize_to_vec(&outbox).unwrap();
        let mut restored: ActionDeliveryOutbox = msgpack::deserialize(bytes.as_slice()).unwrap();

        assert_eq!(restored.start(id(6), 7, 3, 1, 30_001), Ok(ActionDeliveryStart::Pending));
        assert_eq!(
            restored.start(id(6), 7, 3, 1, 30_002),
            Ok(ActionDeliveryStart::Prepare { epoch: 2 })
        );
        assert_eq!(
            restored.store_prepared(id(6), 1, Principal::from_slice(&[9]), vec![1, 2, 3], 30_003),
            Err(ActionDeliveryOutboxError::StaleEpoch)
        );
        assert!(
            restored
                .store_prepared(id(6), 2, Principal::from_slice(&[9]), vec![1, 2, 3], 30_003)
                .is_ok()
        );
    }

    #[test]
    fn serialized_in_flight_state_retains_exact_request_and_becomes_retryable() {
        let mut outbox = ActionDeliveryOutbox::default();
        let first = prepare(&mut outbox, id(7), 9, 55);
        let bytes = msgpack::serialize_to_vec(&outbox).unwrap();
        let mut restored: ActionDeliveryOutbox = msgpack::deserialize(bytes.as_slice()).unwrap();

        assert!(restored.begin_due_retry(30_055).is_none());
        let retry = restored.begin_due_retry(30_056).unwrap();
        assert_eq!(retry.request, first.request);
        assert_eq!(retry.destination, first.destination);
        assert_eq!(retry.epoch, 2);
        assert_eq!(restored.metrics().total_attempts, 1);
        assert_eq!(restored.metrics().in_flight, 1);
    }

    #[test]
    fn legacy_snapshot_without_usage_index_is_rebuilt_before_a_transition() {
        let mut outbox = ActionDeliveryOutbox::default();
        prepare(&mut outbox, id(24), 9, 55);
        outbox.usage = ActionDeliveryUsage::default();
        let bytes = msgpack::serialize_to_vec(&outbox).unwrap();
        let mut restored: ActionDeliveryOutbox = msgpack::deserialize(bytes.as_slice()).unwrap();

        assert_eq!(restored.start(id(24), 9, 3, 55, 56), Ok(ActionDeliveryStart::Pending));
        let metrics = restored.metrics();
        assert_eq!(metrics.total_attempts, 1);
        assert_eq!(metrics.pending_entries, 1);
        assert_eq!(metrics.in_flight, 1);
        assert_eq!(metrics.pending_bytes, 3);
    }

    #[test]
    fn metrics_are_aggregate_only_and_terminal_transition_releases_request_bytes() {
        let mut outbox = ActionDeliveryOutbox::default();
        let dispatch = prepare(&mut outbox, id(8), 123, 1);
        let pending = outbox.metrics();
        assert_eq!(pending.in_flight, 1);
        assert_eq!(pending.pending_bytes, 3);

        outbox
            .complete(id(8), dispatch.epoch, ActionDeliveryRemoteResult::Delivered, 2)
            .unwrap();
        let terminal = outbox.metrics();
        assert_eq!(terminal.in_flight, 0);
        assert_eq!(terminal.pending_bytes, 0);
        assert_eq!(terminal.delivered_tombstones, 1);
    }

    #[test]
    fn indexed_attempt_caps_reject_at_exact_boundaries() {
        assert!(attempt_capacity_available(MAX_ATTEMPTS_GLOBAL - 1, MAX_ATTEMPTS_PER_APP - 1));
        assert!(!attempt_capacity_available(MAX_ATTEMPTS_GLOBAL, 0));
        assert!(!attempt_capacity_available(0, MAX_ATTEMPTS_PER_APP));
    }

    #[test]
    fn app_cap_rejection_does_not_evict_an_unexpired_terminal_outcome() {
        let mut outbox = ActionDeliveryOutbox::default();
        let dispatch = prepare(&mut outbox, id(25), 1, 100);
        outbox
            .complete(id(25), dispatch.epoch, ActionDeliveryRemoteResult::Delivered, 101)
            .unwrap();
        // Inject the indexed boundary without allocating 200,000 tombstones. `start` deliberately
        // trusts this production-maintained index when its aggregate entry count is coherent.
        outbox.usage.attempts_by_app.insert(1, MAX_ATTEMPTS_PER_APP);
        assert_eq!(
            outbox.start(id(26), 1, 1, 100, 102),
            Err(ActionDeliveryOutboxError::PendingCapacity)
        );
        assert_eq!(
            outbox.start(id(25), 1, 3, 100, 102),
            Ok(ActionDeliveryStart::Delivered),
            "capacity pressure must not forget an unexpired terminal result"
        );
        let metrics = outbox.metrics();
        assert_eq!(metrics.delivered_tombstones, 1);
        assert_eq!(metrics.attempt_capacity_rejections, 1);
    }

    #[test]
    fn new_attempt_requires_a_complete_network_window_before_expiry() {
        let created_at = 1_000;
        let mut boundary = ActionDeliveryOutbox::default();
        assert!(matches!(
            boundary.start(
                id(20),
                1,
                1,
                created_at,
                created_at + ACTION_DELIVERY_IDEMPOTENCY_HORIZON_MS - ACTION_DELIVERY_NETWORK_BUDGET_MS,
            ),
            Ok(ActionDeliveryStart::Prepare { .. })
        ));

        let mut expired = ActionDeliveryOutbox::default();
        assert_eq!(
            expired.start(
                id(21),
                1,
                1,
                created_at,
                created_at + ACTION_DELIVERY_IDEMPOTENCY_HORIZON_MS - ACTION_DELIVERY_NETWORK_BUDGET_MS + 1,
            ),
            Err(ActionDeliveryOutboxError::AttemptExpired)
        );
        assert_eq!(expired.metrics().expired_before_dispatch, 1);
    }

    #[test]
    fn preparation_that_loses_its_delivery_window_cannot_open_a_late_call() {
        let created_at = 1_000;
        let last_safe_start = created_at + ACTION_DELIVERY_IDEMPOTENCY_HORIZON_MS - ACTION_DELIVERY_NETWORK_BUDGET_MS;
        let mut outbox = ActionDeliveryOutbox::default();
        assert_eq!(
            outbox.start(id(27), 1, 3, created_at, last_safe_start),
            Ok(ActionDeliveryStart::Prepare { epoch: 1 })
        );
        assert_eq!(
            outbox.store_prepared(id(27), 1, Principal::from_slice(&[9]), vec![1, 2, 3], last_safe_start + 1),
            Err(ActionDeliveryOutboxError::AttemptExpired)
        );
        outbox.abort_preparation(id(27), 1);
        assert_eq!(outbox.metrics().total_attempts, 0);
        assert_eq!(outbox.metrics().expired_before_dispatch, 1);
    }

    #[test]
    fn due_retry_is_removed_when_no_complete_network_window_remains() {
        let created_at = 1_000;
        let last_safe_start = created_at + ACTION_DELIVERY_IDEMPOTENCY_HORIZON_MS - ACTION_DELIVERY_NETWORK_BUDGET_MS;
        let mut outbox = ActionDeliveryOutbox::default();
        let dispatch = prepare(&mut outbox, id(28), 1, created_at);
        let ambiguous_at = last_safe_start - ACTION_DELIVERY_LEASE_MS;
        assert_eq!(
            outbox.complete(
                id(28),
                dispatch.epoch,
                ActionDeliveryRemoteResult::OutcomeUnknown,
                ambiguous_at,
            ),
            Ok(ActionDeliveryCompletion::OutcomeUnknown)
        );
        let due_at = retry_due_at(ambiguous_at);
        assert_eq!(due_at, last_safe_start + 1);
        assert!(outbox.begin_due_retry(due_at).is_none());
        let metrics = outbox.metrics();
        assert_eq!(metrics.total_attempts, 0);
        assert_eq!(metrics.expired_before_dispatch, 1);
        assert_eq!(
            outbox.start(id(28), 1, 3, created_at, due_at),
            Err(ActionDeliveryOutboxError::AttemptExpired)
        );
    }

    #[test]
    fn already_sent_attempt_can_record_a_late_success_without_redelivery() {
        let created_at = 1_000;
        let mut outbox = ActionDeliveryOutbox::default();
        let dispatch = prepare(&mut outbox, id(29), 1, created_at);
        let callback_at = created_at + ACTION_DELIVERY_IDEMPOTENCY_HORIZON_MS + 1;
        assert_eq!(
            outbox.complete(id(29), dispatch.epoch, ActionDeliveryRemoteResult::Delivered, callback_at),
            Ok(ActionDeliveryCompletion::Delivered)
        );
        assert_eq!(
            outbox.start(id(29), 1, 3, created_at, callback_at),
            Ok(ActionDeliveryStart::Delivered)
        );
    }

    #[test]
    fn future_authoritative_created_at_is_rejected_before_reserving_capacity() {
        let mut outbox = ActionDeliveryOutbox::default();
        assert_eq!(
            outbox.start(id(23), 1, 1, 1_001, 1_000),
            Err(ActionDeliveryOutboxError::AttemptInFuture)
        );
        assert_eq!(outbox.metrics().preparing, 0);
        assert_eq!(outbox.metrics().pending_bytes, 0);
    }

    #[test]
    fn retry_after_terminal_horizon_prunes_then_fails_closed_instead_of_redelivering() {
        let mut outbox = ActionDeliveryOutbox::default();
        let dispatch = prepare(&mut outbox, id(22), 1, 1);
        outbox
            .complete(id(22), dispatch.epoch, ActionDeliveryRemoteResult::Delivered, 2)
            .unwrap();

        assert_eq!(
            outbox.start(id(22), 1, 3, 1, 2 + ACTION_DELIVERY_IDEMPOTENCY_HORIZON_MS + 1),
            Err(ActionDeliveryOutboxError::AttemptExpired)
        );
        assert_eq!(outbox.metrics().delivered_tombstones, 0);
        assert_eq!(outbox.metrics().preparing, 0);
    }

    #[test]
    fn terminal_tombstone_is_retained_at_completion_horizon_and_pruned_one_millisecond_later() {
        let mut outbox = ActionDeliveryOutbox::default();
        let dispatch = prepare(&mut outbox, id(30), 1, 1);
        outbox
            .complete(id(30), dispatch.epoch, ActionDeliveryRemoteResult::Delivered, 2)
            .unwrap();

        outbox.prune_terminal(2 + ACTION_DELIVERY_IDEMPOTENCY_HORIZON_MS);
        assert_eq!(outbox.metrics().delivered_tombstones, 1);
        outbox.prune_terminal(2 + ACTION_DELIVERY_IDEMPOTENCY_HORIZON_MS + 1);
        assert_eq!(outbox.metrics().delivered_tombstones, 0);
    }

    #[test]
    fn confirmation_hot_path_does_not_scan_the_terminal_history() {
        let mut outbox = ActionDeliveryOutbox::default();
        for value in 0..1_024u16 {
            let attempt_id = numbered_id(value);
            let dispatch = prepare(&mut outbox, attempt_id, 7, 1);
            outbox
                .complete(attempt_id, dispatch.epoch, ActionDeliveryRemoteResult::Delivered, 2)
                .unwrap();
        }

        outbox.entry_scan_visits = 0;
        assert_eq!(
            outbox.start(numbered_id(2_000), 7, 1, 3, 3),
            Ok(ActionDeliveryStart::Prepare { epoch: 1 })
        );
        assert!(
            outbox.entry_scan_visits <= HOT_PATH_INDEX_REBUILD_BATCH,
            "one confirmation inspected {} historical entries",
            outbox.entry_scan_visits
        );

        let dispatch = outbox
            .store_prepared(numbered_id(2_000), 1, Principal::from_slice(&[9]), vec![1], 3)
            .unwrap();
        outbox.entry_scan_visits = 0;
        outbox
            .complete(dispatch.attempt_id, dispatch.epoch, ActionDeliveryRemoteResult::Delivered, 4)
            .unwrap();
        assert_eq!(outbox.entry_scan_visits, 0, "a completion scanned retained history");
    }

    #[test]
    fn legacy_rebuild_work_is_bounded_and_fresh_direct_slots_fail_closed() {
        let mut outbox = ActionDeliveryOutbox::default();
        for value in 0..256u16 {
            let attempt_id = numbered_id(value);
            let dispatch = prepare(&mut outbox, attempt_id, 7, 1);
            outbox
                .complete(attempt_id, dispatch.epoch, ActionDeliveryRemoteResult::Delivered, 2)
                .unwrap();
        }
        outbox.index_state = ActionDeliveryIndexState::default();
        outbox.entry_scan_visits = 0;

        assert_eq!(
            outbox.start_in_slot(id(60), id(61), 7, 1, 3, 3),
            Err(ActionDeliveryOutboxError::IndexRebuilding)
        );
        assert!(outbox.entry_scan_visits <= HOT_PATH_INDEX_REBUILD_BATCH);
        assert_eq!(outbox.metrics().total_attempts, 256);
        assert!(outbox.metrics().index_rebuilding);

        while !outbox.indexes_ready() {
            assert!(outbox.begin_due_retry(3).is_none());
        }
        let metrics = outbox.metrics();
        assert_eq!(metrics.total_attempts, 256);
        assert_eq!(metrics.delivered_tombstones, 256);
        assert!(!metrics.index_rebuilding);
        assert_eq!(
            outbox.start_in_slot(id(60), id(61), 7, 1, 3, 3),
            Ok(ActionDeliveryStart::Prepare { epoch: 1 })
        );
        assert_eq!(
            outbox.start_in_slot(id(60), id(62), 7, 1, 3, 3),
            Err(ActionDeliveryOutboxError::IdentityCollision)
        );
    }

    #[test]
    fn legacy_rebuild_cursor_and_partial_usage_survive_an_upgrade() {
        let mut outbox = ActionDeliveryOutbox::default();
        for value in 0..130u16 {
            let attempt_id = numbered_id(value);
            let mut slot_id = numbered_id(value + 1_000);
            slot_id[31] = 1;
            assert_eq!(
                outbox.start_in_slot(slot_id, attempt_id, 7, 1, 1, 1),
                Ok(ActionDeliveryStart::Prepare { epoch: 1 })
            );
            let dispatch = outbox
                .store_prepared(attempt_id, 1, Principal::from_slice(&[9]), vec![1], 1)
                .unwrap();
            outbox
                .complete(attempt_id, dispatch.epoch, ActionDeliveryRemoteResult::Delivered, 2)
                .unwrap();
        }
        outbox.logical_slots.clear();
        outbox.terminal_expirations.clear();
        outbox.retry_schedule.clear();
        outbox.index_state = ActionDeliveryIndexState::default();

        assert_eq!(outbox.advance_index_rebuild(HOT_PATH_INDEX_REBUILD_BATCH), Ok(false));
        assert_eq!(outbox.index_state.rebuild_phase, ActionDeliveryIndexRebuildPhase::Scanning);
        assert_eq!(outbox.index_state.rebuilt_usage.total_attempts, HOT_PATH_INDEX_REBUILD_BATCH);
        let bytes = msgpack::serialize_to_vec(&outbox).unwrap();
        let mut restored: ActionDeliveryOutbox = msgpack::deserialize(bytes.as_slice()).unwrap();

        while !restored.indexes_ready() {
            restored.advance_index_rebuild(HOT_PATH_INDEX_REBUILD_BATCH).unwrap();
        }
        assert_eq!(restored.logical_slots.len(), 130);
        assert_eq!(restored.terminal_expirations.len(), 130);
        let metrics = restored.metrics();
        assert_eq!(metrics.total_attempts, 130);
        assert_eq!(metrics.delivered_tombstones, 130);

        let first_attempt = numbered_id(0);
        let mut first_slot = numbered_id(1_000);
        first_slot[31] = 1;
        assert_eq!(
            restored.start_in_slot(first_slot, id(63), 7, 1, 1, 3),
            Err(ActionDeliveryOutboxError::IdentityCollision)
        );
        assert_eq!(restored.logical_slots.get(&first_slot), Some(&first_attempt));
    }

    #[test]
    fn duplicate_legacy_logical_slots_leave_the_outbox_failed_closed() {
        let mut outbox = ActionDeliveryOutbox::default();
        assert_eq!(
            outbox.start_in_slot(id(70), id(71), 7, 1, 1, 1),
            Ok(ActionDeliveryStart::Prepare { epoch: 1 })
        );
        assert_eq!(
            outbox.start_in_slot(id(72), id(73), 7, 1, 1, 1),
            Ok(ActionDeliveryStart::Prepare { epoch: 1 })
        );
        outbox.entries.get_mut(&id(73)).unwrap().logical_slot_id = Some(id(70));
        outbox.logical_slots.clear();
        outbox.index_state = ActionDeliveryIndexState::default();

        assert_eq!(
            outbox.advance_index_rebuild(BACKGROUND_INDEX_REBUILD_BATCH),
            Err(ActionDeliveryOutboxError::IdentityCollision)
        );
        assert!(outbox.metrics().index_rebuild_failed);
        assert_eq!(outbox.next_retry_at(), None);
        assert_eq!(
            outbox.start_in_slot(id(74), id(75), 7, 1, 1, 1),
            Err(ActionDeliveryOutboxError::IdentityCollision)
        );
    }

    #[test]
    fn stale_persisted_retry_index_is_rebuilt_before_any_dispatch() {
        let mut outbox = ActionDeliveryOutbox::default();
        let expected = prepare(&mut outbox, id(80), 7, 1);
        outbox.retry_schedule.clear();
        outbox.retry_schedule.insert((1, id(81)), ());

        assert!(outbox.begin_due_retry(retry_due_at(1)).is_none());
        assert!(outbox.metrics().index_rebuilding);
        while !outbox.indexes_ready() {
            outbox.advance_index_rebuild(HOT_PATH_INDEX_REBUILD_BATCH).unwrap();
        }

        let retry = outbox.begin_due_retry(retry_due_at(1)).unwrap();
        assert_eq!(retry.attempt_id, expected.attempt_id);
        assert_eq!(retry.request, expected.request);
        assert_eq!(retry.destination, expected.destination);
        assert_eq!(retry.epoch, expected.epoch + 1);
    }

    #[test]
    fn terminal_cleanup_is_time_ordered_and_bounded_per_call() {
        let mut outbox = ActionDeliveryOutbox::default();
        for value in 0..200u16 {
            let attempt_id = numbered_id(value);
            let dispatch = prepare(&mut outbox, attempt_id, 7, 1);
            outbox
                .complete(attempt_id, dispatch.epoch, ActionDeliveryRemoteResult::Delivered, 2)
                .unwrap();
        }

        let expired_at = terminal_expires_at(2) + 1;
        assert_eq!(outbox.next_retry_at(), Some(expired_at));
        assert!(outbox.begin_due_retry(expired_at).is_none());
        assert_eq!(outbox.metrics().total_attempts, 200 - TERMINAL_PRUNE_BATCH);
        while outbox.metrics().total_attempts > 0 {
            assert_eq!(outbox.next_retry_at(), Some(expired_at));
            assert!(outbox.begin_due_retry(expired_at).is_none());
        }
        assert!(outbox.terminal_expirations.is_empty());
        assert_eq!(outbox.metrics().delivered_tombstones, 0);
    }
}
