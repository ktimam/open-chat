use candid::Principal;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
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

pub type ActionDeliveryAttemptId = [u8; 32];

#[derive(Serialize, Deserialize, Default)]
pub struct ActionDeliveryOutbox {
    entries: BTreeMap<ActionDeliveryAttemptId, ActionDeliveryEntry>,
    #[serde(default)]
    usage: ActionDeliveryUsage,
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
}

impl ActionDeliveryUsage {
    fn rebuilt(entries: &BTreeMap<ActionDeliveryAttemptId, ActionDeliveryEntry>, previous: &ActionDeliveryUsage) -> Self {
        let mut usage = Self {
            attempt_capacity_rejections: previous.attempt_capacity_rejections,
            pending_count_rejections: previous.pending_count_rejections,
            pending_byte_rejections: previous.pending_byte_rejections,
            expired_before_dispatch: previous.expired_before_dispatch,
            ..Self::default()
        };
        for entry in entries.values() {
            usage.add_entry(entry);
        }
        usage
    }

    fn add_entry(&mut self, entry: &ActionDeliveryEntry) {
        self.total_attempts += 1;
        *self.attempts_by_app.entry(entry.app_id).or_default() += 1;
        self.add_state(entry.state);
        if is_pending(entry) {
            self.pending_count += 1;
            self.pending_bytes = self.pending_bytes.saturating_add(entry.reserved_bytes);
            let app = self.pending_by_app.entry(entry.app_id).or_default();
            app.count += 1;
            app.bytes = app.bytes.saturating_add(entry.reserved_bytes);
        }
    }

    fn remove_entry(&mut self, entry: &ActionDeliveryEntry) {
        self.total_attempts = self.total_attempts.saturating_sub(1);
        decrement_map_count(&mut self.attempts_by_app, entry.app_id);
        self.remove_state(entry.state);
        if is_pending(entry) {
            self.remove_pending(entry.app_id, entry.reserved_bytes);
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
        self.rebuild_usage_if_required();
        self.prune_terminal(now);
        validate_request_size(reserved_bytes)?;

        if self.entries.contains_key(&attempt_id) {
            return self.start_existing(attempt_id, app_id, reserved_bytes, attempt_created_at, now);
        }

        if attempt_created_at > now {
            return Err(ActionDeliveryOutboxError::AttemptInFuture);
        }
        if !delivery_window_open(attempt_created_at, now) {
            self.usage.expired_before_dispatch = self.usage.expired_before_dispatch.saturating_add(1);
            return Err(ActionDeliveryOutboxError::AttemptExpired);
        }
        if let Err(error) = self.check_attempt_capacity(app_id) {
            self.usage.attempt_capacity_rejections = self.usage.attempt_capacity_rejections.saturating_add(1);
            return Err(error);
        }
        if let Err(error) = self.check_pending_capacity(app_id, reserved_bytes, None) {
            match error {
                ActionDeliveryOutboxError::PendingCapacity => {
                    self.usage.pending_count_rejections = self.usage.pending_count_rejections.saturating_add(1)
                }
                ActionDeliveryOutboxError::PendingByteCapacity => {
                    self.usage.pending_byte_rejections = self.usage.pending_byte_rejections.saturating_add(1)
                }
                _ => {}
            }
            return Err(error);
        }
        self.entries.insert(
            attempt_id,
            ActionDeliveryEntry {
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
        self.usage.add_entry(self.entries.get(&attempt_id).unwrap());
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
                    self.usage.expired_before_dispatch = self.usage.expired_before_dispatch.saturating_add(1);
                    return Err(ActionDeliveryOutboxError::AttemptExpired);
                }
                if let Err(error) = self.check_pending_capacity(app_id, reserved_bytes, Some(attempt_id)) {
                    match error {
                        ActionDeliveryOutboxError::PendingCapacity => {
                            self.usage.pending_count_rejections = self.usage.pending_count_rejections.saturating_add(1)
                        }
                        ActionDeliveryOutboxError::PendingByteCapacity => {
                            self.usage.pending_byte_rejections = self.usage.pending_byte_rejections.saturating_add(1)
                        }
                        _ => {}
                    }
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
                Ok(ActionDeliveryStart::Prepare { epoch: next_epoch })
            }
            ActionDeliveryState::Preparing { .. } => Ok(ActionDeliveryStart::Pending),
            ActionDeliveryState::InFlight { epoch, lease_started_at } if lease_expired(lease_started_at, now) => {
                if !delivery_window_open(attempt_created_at, now) {
                    self.remove_attempt(&attempt_id);
                    self.usage.expired_before_dispatch = self.usage.expired_before_dispatch.saturating_add(1);
                    return Err(ActionDeliveryOutboxError::AttemptExpired);
                }
                begin_stored_retry(self.entries.get_mut(&attempt_id).unwrap(), epoch, now)?;
                Ok(ActionDeliveryStart::Dispatch)
            }
            ActionDeliveryState::InFlight { .. } => Ok(ActionDeliveryStart::Pending),
            ActionDeliveryState::OutcomeUnknown { epoch, retry_after } if now >= retry_after => {
                if !delivery_window_open(attempt_created_at, now) {
                    self.remove_attempt(&attempt_id);
                    self.usage.expired_before_dispatch = self.usage.expired_before_dispatch.saturating_add(1);
                    return Err(ActionDeliveryOutboxError::AttemptExpired);
                }
                let entry = self.entries.get_mut(&attempt_id).unwrap();
                let old_state = entry.state;
                begin_stored_retry(entry, epoch, now)?;
                self.usage
                    .transition(app_id, old_state, entry.state, entry.reserved_bytes, entry.reserved_bytes);
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
            self.usage.expired_before_dispatch = self.usage.expired_before_dispatch.saturating_add(1);
            return Err(ActionDeliveryOutboxError::AttemptExpired);
        }
        let old_state = entry.state;
        entry.request = request;
        entry.destination = Some(destination);
        entry.state = ActionDeliveryState::InFlight {
            epoch,
            lease_started_at: now,
        };
        self.usage.transition(
            entry.app_id,
            old_state,
            entry.state,
            entry.reserved_bytes,
            entry.reserved_bytes,
        );
        dispatch_for(attempt_id, entry)
    }

    pub fn abort_preparation(&mut self, attempt_id: ActionDeliveryAttemptId, epoch: u64) {
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
        let entry = self
            .entries
            .get_mut(&attempt_id)
            .ok_or(ActionDeliveryOutboxError::MissingPreparedRequest)?;

        if matches!(result, ActionDeliveryRemoteResult::Delivered) {
            let old_state = entry.state;
            let old_bytes = entry.reserved_bytes;
            make_terminal(entry, ActionDeliveryState::Delivered { completed_at: now });
            self.usage
                .transition(entry.app_id, old_state, entry.state, old_bytes, entry.reserved_bytes);
            self.prune_terminal(now);
            return Ok(ActionDeliveryCompletion::Delivered);
        }

        let current_epoch = match entry.state {
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
                let old_state = entry.state;
                let old_bytes = entry.reserved_bytes;
                make_terminal(entry, ActionDeliveryState::Rejected { completed_at: now });
                self.usage
                    .transition(entry.app_id, old_state, entry.state, old_bytes, entry.reserved_bytes);
                self.prune_terminal(now);
                Ok(ActionDeliveryCompletion::Rejected)
            }
            ActionDeliveryRemoteResult::OutcomeUnknown => {
                let old_state = entry.state;
                entry.state = ActionDeliveryState::OutcomeUnknown {
                    epoch,
                    retry_after: retry_due_at(now),
                };
                self.usage.transition(
                    entry.app_id,
                    old_state,
                    entry.state,
                    entry.reserved_bytes,
                    entry.reserved_bytes,
                );
                Ok(ActionDeliveryCompletion::OutcomeUnknown)
            }
        }
    }

    /// Acquires exactly one due stored request for the single-flight background delivery job.
    pub fn begin_due_retry(&mut self, now: TimestampMillis) -> Option<ActionDeliveryDispatch> {
        self.rebuild_usage_if_required();
        loop {
            let attempt_id = self
                .entries
                .iter()
                .filter_map(|(attempt_id, entry)| retry_due(entry).filter(|due| *due <= now).map(|due| (due, *attempt_id)))
                .min()
                .map(|(_, attempt_id)| attempt_id)?;
            let entry = self.entries.get(&attempt_id).unwrap();
            if !delivery_window_open(entry.attempt_created_at, now) {
                self.remove_attempt(&attempt_id);
                self.usage.expired_before_dispatch = self.usage.expired_before_dispatch.saturating_add(1);
                continue;
            }
            let entry = self.entries.get_mut(&attempt_id).unwrap();
            let epoch = match entry.state {
                ActionDeliveryState::InFlight { epoch, .. } | ActionDeliveryState::OutcomeUnknown { epoch, .. } => epoch,
                _ => return None,
            };
            let old_state = entry.state;
            begin_stored_retry(entry, epoch, now).ok()?;
            self.usage.transition(
                entry.app_id,
                old_state,
                entry.state,
                entry.reserved_bytes,
                entry.reserved_bytes,
            );
            return dispatch_for(attempt_id, entry).ok();
        }
    }

    pub fn next_retry_at(&self) -> Option<TimestampMillis> {
        self.entries.values().filter_map(retry_due).min()
    }

    pub fn metrics(&self) -> ActionDeliveryOutboxMetrics {
        let repaired;
        let usage = if self.usage.total_attempts == self.entries.len() {
            &self.usage
        } else {
            repaired = ActionDeliveryUsage::rebuilt(&self.entries, &self.usage);
            &repaired
        };
        ActionDeliveryOutboxMetrics {
            total_attempts: usage.total_attempts,
            attempt_slots_remaining: MAX_ATTEMPTS_GLOBAL.saturating_sub(usage.total_attempts),
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
        let expired: Vec<_> = self
            .entries
            .iter()
            .filter_map(|(attempt_id, entry)| {
                terminal_completed_at(entry)
                    .filter(|completed_at| now > completed_at.saturating_add(ACTION_DELIVERY_IDEMPOTENCY_HORIZON_MS))
                    .map(|_| *attempt_id)
            })
            .collect();
        for attempt_id in expired {
            self.remove_attempt(&attempt_id);
        }
    }

    fn rebuild_usage_if_required(&mut self) {
        if self.usage.total_attempts != self.entries.len() {
            self.usage = ActionDeliveryUsage::rebuilt(&self.entries, &self.usage);
        }
    }

    fn remove_attempt(&mut self, attempt_id: &ActionDeliveryAttemptId) {
        if let Some(entry) = self.entries.remove(attempt_id) {
            self.usage.remove_entry(&entry);
        }
    }
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

fn terminal_completed_at(entry: &ActionDeliveryEntry) -> Option<TimestampMillis> {
    match entry.state {
        ActionDeliveryState::Delivered { completed_at } | ActionDeliveryState::Rejected { completed_at } => Some(completed_at),
        _ => None,
    }
}

fn retry_due(entry: &ActionDeliveryEntry) -> Option<TimestampMillis> {
    match entry.state {
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
}
