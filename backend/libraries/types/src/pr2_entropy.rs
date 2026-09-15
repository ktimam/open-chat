use candid::Principal;
use rand::SeedableRng;
use rand::rngs::StdRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const ROOT_DOMAIN: &[u8] = b"openchat/pr2/entropy-root/v2\0";
const OUTPUT_DOMAIN: &[u8] = b"openchat/pr2/security-output/v2\0";
const TEST_MODE_COMMITMENT_DOMAIN: &[u8] = b"openchat/pr2/test-mode-raw-rand-commitment/v2\0";
const MAX_RESEED_ATTEMPTS_PER_WINDOW: u8 = 3;
const RETRY_DELAY_MS: u64 = 5_000;
const EXHAUSTED_RETRY_DELAY_MS: u64 = 60_000;
pub const PR2_ENTROPY_RESEED_WATCHDOG_MS: u64 = 60_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Pr2EntropyLifecycleId {
    pub generation: u64,
    pub version_salt: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Pr2EntropyReseedTicket {
    lifecycle: Pr2EntropyLifecycleId,
    attempt: u64,
}

/// Selects how replay commitments are derived from management-canister randomness.
///
/// Production retains the original `SHA256(raw_rand)` commitment exactly. PocketIC can return
/// deterministic bytes after an upgrade, so test mode also binds the commitment to the persisted
/// logical lifecycle. This permits the same fixture bytes in a new lifecycle without permitting a
/// replay in the same lifecycle.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Pr2EntropyCommitmentMode {
    Production,
    TestMode,
}

impl Pr2EntropyCommitmentMode {
    pub fn from_test_mode(test_mode: bool) -> Self {
        if test_mode { Self::TestMode } else { Self::Production }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Pr2EntropyReseedAdmission {
    Unavailable,
    Ready,
    Started(Pr2EntropyReseedTicket),
    InProgress {
        ticket: Pr2EntropyReseedTicket,
        watchdog_delay_ms: u64,
    },
    RetryAfter(u64),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Pr2EntropyReseedWatchdog {
    Stale,
    Pending(u64),
    Expired,
}

/// Persisted readiness for PR2-only bearers, envelope secrets, ephemeral keys, and signing
/// randomness.
///
/// `version_salt` is sampled exactly once by each canister's init/post-upgrade hook. It is not the
/// lifecycle generation: the IC may increment the live system canister version after ordinary
/// update messages. The persisted generation plus the one-time salt prevents a restored snapshot
/// from aliasing a historical post-snapshot lifecycle. Snapshot recovery must still use the
/// controller-enforced stop -> load -> same-Wasm upgrade -> start protocol so the lifecycle hook
/// runs before the canister can serve requests.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Pr2EntropyGate {
    // Legacy fields are retained only for stable-state compatibility. They are deliberately not
    // reinterpreted as logical lifecycle state; legacy readiness therefore decodes fail-closed.
    #[serde(default)]
    observed_canister_version: Option<u64>,
    #[serde(default)]
    ready_canister_version: Option<u64>,
    #[serde(default)]
    root_seed: [u8; 32],
    #[serde(default)]
    next_output_counter: u64,
    #[serde(default)]
    last_raw_rand_commitment: Option<[u8; 32]>,
    #[serde(default)]
    reseed_in_progress_for: Option<u64>,
    #[serde(default)]
    reseed_attempts: u8,
    #[serde(default)]
    retry_after: u64,
    /// Monotonic generation for the active/most-recent raw-rand call. This is deliberately never
    /// reset on an upgrade, so a delayed callback cannot alias a later attempt.
    #[serde(default)]
    reseed_attempt_generation: u64,
    /// Persisted because canister timers are not. A post-upgrade lifecycle pass invalidates the old
    /// ticket, while serialization within one lifecycle can reconstruct its watchdog.
    #[serde(default)]
    reseed_deadline: u64,
    #[serde(default)]
    lifecycle: Option<Pr2EntropyLifecycleId>,
    #[serde(default)]
    ready_lifecycle: Option<Pr2EntropyLifecycleId>,
    #[serde(default)]
    reseed_lifecycle: Option<Pr2EntropyLifecycleId>,
    #[serde(default)]
    lifecycle_generation_exhausted: bool,
}

impl Pr2EntropyGate {
    /// Advances the persisted logical lifecycle exactly once from init or post-upgrade.
    ///
    /// The caller captures `version_salt` synchronously in that lifecycle hook. A checked
    /// generation overflow permanently fails closed rather than reusing an earlier identifier.
    pub fn advance_lifecycle(&mut self, version_salt: u64) -> Result<Pr2EntropyLifecycleId, &'static str> {
        if self.lifecycle_generation_exhausted {
            self.clear_output_state();
            return Err("PR2 entropy lifecycle generation exhausted");
        }
        let previous_generation = self.lifecycle.map_or(0, |lifecycle| lifecycle.generation);
        let Some(generation) = previous_generation.checked_add(1) else {
            self.lifecycle_generation_exhausted = true;
            self.clear_output_state();
            return Err("PR2 entropy lifecycle generation exhausted");
        };
        let lifecycle = Pr2EntropyLifecycleId {
            generation,
            version_salt,
        };
        self.lifecycle = Some(lifecycle);
        self.clear_output_state();
        Ok(lifecycle)
    }

    pub fn lifecycle_id(&self) -> Option<Pr2EntropyLifecycleId> {
        self.lifecycle
    }

    pub fn is_ready(&self) -> bool {
        !self.lifecycle_generation_exhausted && self.lifecycle.is_some() && self.ready_lifecycle == self.lifecycle
    }

    /// Lets adapters distinguish an active rejection (which needs a bounded retry) from a delayed
    /// stale callback (which must not schedule duplicate work). No seed or replay commitment is
    /// exposed.
    pub fn is_active_reseed_ticket(&self, ticket: Pr2EntropyReseedTicket) -> bool {
        self.ticket_is_active(ticket)
    }

    pub fn begin_reseed(&mut self, now: u64) -> Pr2EntropyReseedAdmission {
        let Some(lifecycle) = self.lifecycle.filter(|_| !self.lifecycle_generation_exhausted) else {
            return Pr2EntropyReseedAdmission::Unavailable;
        };
        if self.is_ready() {
            return Pr2EntropyReseedAdmission::Ready;
        }
        if self.reseed_lifecycle == Some(lifecycle) {
            let ticket = Pr2EntropyReseedTicket {
                lifecycle,
                attempt: self.reseed_attempt_generation,
            };
            if now < self.reseed_deadline {
                return Pr2EntropyReseedAdmission::InProgress {
                    ticket,
                    watchdog_delay_ms: self.reseed_deadline - now,
                };
            }
            self.fail_reseed(ticket, now);
            return Pr2EntropyReseedAdmission::RetryAfter(self.retry_after.saturating_sub(now));
        }
        if self.reseed_lifecycle.is_some() {
            self.reseed_lifecycle = None;
            self.reseed_deadline = 0;
        }
        if now < self.retry_after {
            return Pr2EntropyReseedAdmission::RetryAfter(self.retry_after - now);
        }
        if self.reseed_attempts >= MAX_RESEED_ATTEMPTS_PER_WINDOW {
            self.reseed_attempts = 0;
        }
        let Some(attempt) = self.reseed_attempt_generation.checked_add(1) else {
            self.retry_after = now.saturating_add(EXHAUSTED_RETRY_DELAY_MS);
            return Pr2EntropyReseedAdmission::RetryAfter(EXHAUSTED_RETRY_DELAY_MS);
        };
        self.reseed_attempt_generation = attempt;
        self.reseed_attempts += 1;
        self.reseed_lifecycle = Some(lifecycle);
        self.reseed_deadline = now.saturating_add(PR2_ENTROPY_RESEED_WATCHDOG_MS);
        Pr2EntropyReseedAdmission::Started(Pr2EntropyReseedTicket { lifecycle, attempt })
    }

    pub fn finish_reseed(
        &mut self,
        ticket: Pr2EntropyReseedTicket,
        canister_id: Principal,
        commitment_mode: Pr2EntropyCommitmentMode,
        raw_rand: &[u8],
        now: u64,
    ) -> bool {
        if !self.ticket_is_active(ticket) {
            return false;
        }
        if now >= self.reseed_deadline {
            self.fail_reseed(ticket, now);
            return false;
        }
        if raw_rand.len() != 32 {
            self.fail_reseed(ticket, now);
            return false;
        }
        let raw_commitment = raw_rand_commitment(commitment_mode, ticket.lifecycle, raw_rand);
        if self.last_raw_rand_commitment == Some(raw_commitment) {
            self.fail_reseed(ticket, now);
            return false;
        }
        let mut hasher = Sha256::new();
        hasher.update(ROOT_DOMAIN);
        hasher.update([canister_id.as_slice().len() as u8]);
        hasher.update(canister_id.as_slice());
        hash_lifecycle(&mut hasher, ticket.lifecycle);
        hasher.update(raw_rand);
        self.root_seed = hasher.finalize().into();
        self.ready_lifecycle = Some(ticket.lifecycle);
        self.next_output_counter = 0;
        self.last_raw_rand_commitment = Some(raw_commitment);
        self.reseed_lifecycle = None;
        self.reseed_deadline = 0;
        self.reseed_attempts = 0;
        self.retry_after = 0;
        true
    }

    pub fn fail_reseed(&mut self, ticket: Pr2EntropyReseedTicket, now: u64) -> bool {
        if self.ticket_is_active(ticket) {
            self.reseed_lifecycle = None;
            self.reseed_deadline = 0;
            self.retry_after = now.saturating_add(if self.reseed_attempts >= MAX_RESEED_ATTEMPTS_PER_WINDOW {
                EXHAUSTED_RETRY_DELAY_MS
            } else {
                RETRY_DELAY_MS
            });
            true
        } else {
            false
        }
    }

    pub fn check_reseed_watchdog(&mut self, ticket: Pr2EntropyReseedTicket, now: u64) -> Pr2EntropyReseedWatchdog {
        if !self.ticket_is_active(ticket) {
            return Pr2EntropyReseedWatchdog::Stale;
        }
        if now < self.reseed_deadline {
            return Pr2EntropyReseedWatchdog::Pending(self.reseed_deadline - now);
        }
        self.fail_reseed(ticket, now);
        Pr2EntropyReseedWatchdog::Expired
    }

    pub fn mark_unavailable(&mut self) {
        self.clear_output_state();
    }

    pub fn output_rng(&mut self, canister_id: Principal, purpose: &[u8]) -> Result<StdRng, &'static str> {
        let lifecycle = self
            .lifecycle
            .filter(|lifecycle| self.ready_lifecycle == Some(*lifecycle) && !self.lifecycle_generation_exhausted)
            .ok_or("PR2 entropy is not ready for the current lifecycle")?;
        let counter = self.next_output_counter;
        self.next_output_counter = self
            .next_output_counter
            .checked_add(1)
            .ok_or("PR2 entropy output counter exhausted")?;
        let mut hasher = Sha256::new();
        hasher.update(OUTPUT_DOMAIN);
        hasher.update(self.root_seed);
        hasher.update([canister_id.as_slice().len() as u8]);
        hasher.update(canister_id.as_slice());
        hash_lifecycle(&mut hasher, lifecycle);
        hasher.update(counter.to_le_bytes());
        hasher.update((purpose.len() as u64).to_le_bytes());
        hasher.update(purpose);
        Ok(StdRng::from_seed(hasher.finalize().into()))
    }

    fn clear_output_state(&mut self) {
        self.observed_canister_version = None;
        self.ready_canister_version = None;
        self.reseed_in_progress_for = None;
        self.ready_lifecycle = None;
        self.root_seed.fill(0);
        self.next_output_counter = 0;
        self.reseed_lifecycle = None;
        self.reseed_deadline = 0;
        self.reseed_attempts = 0;
        self.retry_after = 0;
    }

    fn ticket_is_active(&self, ticket: Pr2EntropyReseedTicket) -> bool {
        !self.lifecycle_generation_exhausted
            && self.lifecycle == Some(ticket.lifecycle)
            && self.reseed_lifecycle == Some(ticket.lifecycle)
            && ticket.attempt == self.reseed_attempt_generation
    }
}

fn hash_lifecycle(hasher: &mut Sha256, lifecycle: Pr2EntropyLifecycleId) {
    hasher.update(lifecycle.generation.to_le_bytes());
    hasher.update(lifecycle.version_salt.to_le_bytes());
}

fn raw_rand_commitment(mode: Pr2EntropyCommitmentMode, lifecycle: Pr2EntropyLifecycleId, raw_rand: &[u8]) -> [u8; 32] {
    match mode {
        Pr2EntropyCommitmentMode::Production => Sha256::digest(raw_rand).into(),
        Pr2EntropyCommitmentMode::TestMode => {
            let mut hasher = Sha256::new();
            hasher.update(TEST_MODE_COMMITMENT_DOMAIN);
            hash_lifecycle(&mut hasher, lifecycle);
            hasher.update(raw_rand);
            hasher.finalize().into()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::Rng;

    fn advance(gate: &mut Pr2EntropyGate, version_salt: u64) -> Pr2EntropyLifecycleId {
        gate.advance_lifecycle(version_salt).expect("lifecycle must advance")
    }

    fn start(gate: &mut Pr2EntropyGate, now: u64) -> Pr2EntropyReseedTicket {
        let Pr2EntropyReseedAdmission::Started(ticket) = gate.begin_reseed(now) else {
            panic!("expected reseed admission")
        };
        ticket
    }

    fn finish(
        gate: &mut Pr2EntropyGate,
        ticket: Pr2EntropyReseedTicket,
        canister: Principal,
        raw_rand: &[u8],
        now: u64,
    ) -> bool {
        gate.finish_reseed(ticket, canister, Pr2EntropyCommitmentMode::Production, raw_rand, now)
    }

    fn ready_gate(version_salt: u64, canister: Principal, raw_rand: &[u8]) -> Pr2EntropyGate {
        let mut gate = Pr2EntropyGate::default();
        advance(&mut gate, version_salt);
        let ticket = start(&mut gate, 1);
        assert!(finish(&mut gate, ticket, canister, raw_rand, 1));
        gate
    }

    #[test]
    fn lifecycle_advance_blocks_until_fresh_raw_rand_reseed() {
        let canister = Principal::from_slice(&[1]);
        let mut gate = ready_gate(7, canister, &[3; 32]);
        assert!(gate.output_rng(canister, b"bearer").is_ok());

        assert_eq!(advance(&mut gate, 8).generation, 2);
        assert!(!gate.is_ready());
        assert!(gate.output_rng(canister, b"bearer").is_err());
        let ticket = start(&mut gate, 2);
        assert!(finish(&mut gate, ticket, canister, &[4; 32], 2));
        assert!(gate.output_rng(canister, b"bearer").is_ok());
    }

    #[test]
    fn ordinary_system_version_drift_does_not_change_the_logical_lifecycle() {
        let canister = Principal::from_slice(&[2]);
        let mut gate = ready_gate(20, canister, &[5; 32]);
        let lifecycle = gate.lifecycle_id();
        for _ordinary_message_system_version in 21..40 {
            assert_eq!(gate.lifecycle_id(), lifecycle);
            assert!(gate.output_rng(canister, b"ordinary-message").is_ok());
        }
    }

    #[test]
    fn stale_callback_and_watchdog_are_rejected_by_the_full_lifecycle_id() {
        let mut gate = Pr2EntropyGate::default();
        advance(&mut gate, 30);
        let stale = start(&mut gate, 1);
        advance(&mut gate, 31);
        assert!(!gate.is_active_reseed_ticket(stale));
        assert_eq!(gate.check_reseed_watchdog(stale, 2), Pr2EntropyReseedWatchdog::Stale);
        assert!(!finish(&mut gate, stale, Principal::from_slice(&[3]), &[6; 32], 2));
        assert!(!gate.is_ready());
    }

    #[test]
    fn version_salt_prevents_snapshot_generation_collision() {
        let canister = Principal::from_slice(&[4]);
        let mut before_snapshot = ready_gate(40, canister, &[7; 32]);
        let snapshot = msgpack::serialize_to_vec(&before_snapshot).unwrap();

        let historical_id = advance(&mut before_snapshot, 41);
        let historical_ticket = start(&mut before_snapshot, 2);
        let deterministic_raw_rand = [8; 32];
        assert!(before_snapshot.finish_reseed(
            historical_ticket,
            canister,
            Pr2EntropyCommitmentMode::TestMode,
            &deterministic_raw_rand,
            2
        ));
        let historical_commitment = before_snapshot.last_raw_rand_commitment;

        let mut restored: Pr2EntropyGate = msgpack::deserialize_then_unwrap(&snapshot);
        let restored_id = advance(&mut restored, 99);
        assert_eq!(historical_id.generation, restored_id.generation);
        assert_ne!(historical_id, restored_id);
        assert!(!restored.is_active_reseed_ticket(historical_ticket));
        assert!(!finish(
            &mut restored,
            historical_ticket,
            canister,
            &deterministic_raw_rand,
            3
        ));
        let restored_ticket = start(&mut restored, 3);
        assert!(restored.finish_reseed(
            restored_ticket,
            canister,
            Pr2EntropyCommitmentMode::TestMode,
            &deterministic_raw_rand,
            3
        ));
        assert_ne!(restored.last_raw_rand_commitment, historical_commitment);

        let mut historical_bytes = [0; 32];
        let mut restored_bytes = [0; 32];
        before_snapshot
            .output_rng(canister, b"rollback-collision")
            .unwrap()
            .fill_bytes(&mut historical_bytes);
        restored
            .output_rng(canister, b"rollback-collision")
            .unwrap()
            .fill_bytes(&mut restored_bytes);
        assert_ne!(historical_bytes, restored_bytes);
    }

    #[test]
    fn concurrent_reseed_watchdog_and_retry_are_bounded() {
        let mut gate = Pr2EntropyGate::default();
        advance(&mut gate, 1);
        let ticket = start(&mut gate, 10);
        assert_eq!(
            gate.begin_reseed(10),
            Pr2EntropyReseedAdmission::InProgress {
                ticket,
                watchdog_delay_ms: PR2_ENTROPY_RESEED_WATCHDOG_MS,
            }
        );
        assert_eq!(
            gate.check_reseed_watchdog(ticket, 10 + PR2_ENTROPY_RESEED_WATCHDOG_MS - 1),
            Pr2EntropyReseedWatchdog::Pending(1)
        );
        assert_eq!(
            gate.check_reseed_watchdog(ticket, 10 + PR2_ENTROPY_RESEED_WATCHDOG_MS),
            Pr2EntropyReseedWatchdog::Expired
        );
        assert_eq!(
            gate.begin_reseed(11 + PR2_ENTROPY_RESEED_WATCHDOG_MS),
            Pr2EntropyReseedAdmission::RetryAfter(RETRY_DELAY_MS - 1)
        );
    }

    #[test]
    fn persisted_in_flight_ticket_reconstructs_its_watchdog() {
        let mut gate = Pr2EntropyGate::default();
        advance(&mut gate, 50);
        let ticket = start(&mut gate, 100);
        let encoded = msgpack::serialize_to_vec(&gate).unwrap();
        let mut restored: Pr2EntropyGate = msgpack::deserialize_then_unwrap(&encoded);
        assert_eq!(
            restored.begin_reseed(200),
            Pr2EntropyReseedAdmission::InProgress {
                ticket,
                watchdog_delay_ms: PR2_ENTROPY_RESEED_WATCHDOG_MS - 100,
            }
        );
    }

    #[test]
    fn same_lifecycle_serialization_preserves_the_consumed_output_counter() {
        let canister = Principal::from_slice(&[5]);
        let mut gate = ready_gate(55, canister, &[11; 32]);
        let mut first = [0; 32];
        gate.output_rng(canister, b"envelope").unwrap().fill_bytes(&mut first);
        let encoded = msgpack::serialize_to_vec(&gate).unwrap();
        let mut reopened: Pr2EntropyGate = msgpack::deserialize_then_unwrap(&encoded);
        let mut second = [0; 32];
        reopened.output_rng(canister, b"envelope").unwrap().fill_bytes(&mut second);
        assert_ne!(first, second);
    }

    #[test]
    fn stale_expired_attempt_cannot_cancel_a_newer_attempt() {
        let mut gate = Pr2EntropyGate::default();
        advance(&mut gate, 56);
        let stale = start(&mut gate, 0);
        assert_eq!(
            gate.check_reseed_watchdog(stale, PR2_ENTROPY_RESEED_WATCHDOG_MS),
            Pr2EntropyReseedWatchdog::Expired
        );
        let current = start(&mut gate, PR2_ENTROPY_RESEED_WATCHDOG_MS + RETRY_DELAY_MS);

        assert!(!gate.fail_reseed(stale, PR2_ENTROPY_RESEED_WATCHDOG_MS + RETRY_DELAY_MS + 1));
        assert_eq!(
            gate.check_reseed_watchdog(stale, PR2_ENTROPY_RESEED_WATCHDOG_MS + RETRY_DELAY_MS + 1),
            Pr2EntropyReseedWatchdog::Stale
        );
        assert!(!finish(
            &mut gate,
            stale,
            Principal::from_slice(&[17]),
            &[17; 32],
            PR2_ENTROPY_RESEED_WATCHDOG_MS + RETRY_DELAY_MS + 1
        ));
        assert_eq!(
            gate.begin_reseed(PR2_ENTROPY_RESEED_WATCHDOG_MS + RETRY_DELAY_MS + 1),
            Pr2EntropyReseedAdmission::InProgress {
                ticket: current,
                watchdog_delay_ms: PR2_ENTROPY_RESEED_WATCHDOG_MS - 1,
            }
        );
    }

    #[test]
    fn callback_at_or_after_deadline_is_rejected() {
        let canister = Principal::from_slice(&[18]);
        let mut gate = Pr2EntropyGate::default();
        advance(&mut gate, 57);
        let at_deadline = start(&mut gate, 100);
        assert!(!finish(
            &mut gate,
            at_deadline,
            canister,
            &[18; 32],
            100 + PR2_ENTROPY_RESEED_WATCHDOG_MS
        ));
        let after_deadline = start(&mut gate, 100 + PR2_ENTROPY_RESEED_WATCHDOG_MS + RETRY_DELAY_MS);
        assert!(!finish(
            &mut gate,
            after_deadline,
            canister,
            &[19; 32],
            101 + 2 * PR2_ENTROPY_RESEED_WATCHDOG_MS + RETRY_DELAY_MS
        ));
        assert!(!gate.is_ready());
    }

    #[test]
    fn three_failed_attempts_enter_the_exhausted_backoff_window() {
        let mut gate = Pr2EntropyGate::default();
        advance(&mut gate, 58);
        for now in [0, RETRY_DELAY_MS, 2 * RETRY_DELAY_MS] {
            let ticket = start(&mut gate, now);
            assert!(gate.fail_reseed(ticket, now));
        }
        assert_eq!(
            gate.begin_reseed(2 * RETRY_DELAY_MS + 1),
            Pr2EntropyReseedAdmission::RetryAfter(EXHAUSTED_RETRY_DELAY_MS - 1)
        );
    }

    #[test]
    fn attempt_generation_exhaustion_remains_fail_closed() {
        let mut gate = Pr2EntropyGate::default();
        advance(&mut gate, 59);
        gate.reseed_attempt_generation = u64::MAX;
        assert_eq!(
            gate.begin_reseed(1),
            Pr2EntropyReseedAdmission::RetryAfter(EXHAUSTED_RETRY_DELAY_MS)
        );
        assert!(!gate.is_ready());
        assert!(gate.output_rng(Principal::from_slice(&[19]), b"attempt-overflow").is_err());
        assert_eq!(
            gate.begin_reseed(1 + EXHAUSTED_RETRY_DELAY_MS),
            Pr2EntropyReseedAdmission::RetryAfter(EXHAUSTED_RETRY_DELAY_MS)
        );
    }

    #[test]
    fn invalid_raw_rand_length_remains_blocked_and_observes_backoff() {
        let mut gate = Pr2EntropyGate::default();
        advance(&mut gate, 60);
        let ticket = start(&mut gate, 100);
        assert!(!finish(&mut gate, ticket, Principal::from_slice(&[6]), &[12; 31], 100));
        assert!(!gate.is_ready());
        assert_eq!(
            gate.begin_reseed(101),
            Pr2EntropyReseedAdmission::RetryAfter(RETRY_DELAY_MS - 1)
        );
    }

    #[test]
    fn every_output_is_counter_and_purpose_separated() {
        let mut gate = ready_gate(70, Principal::from_slice(&[7]), &[13; 32]);
        let mut same_state = gate.clone();
        let mut first = [0; 32];
        let mut second = [0; 32];
        let mut other_purpose = [0; 32];
        let canister = Principal::from_slice(&[7]);
        gate.output_rng(canister, b"capability").unwrap().fill_bytes(&mut first);
        gate.output_rng(canister, b"capability").unwrap().fill_bytes(&mut second);
        same_state
            .output_rng(canister, b"signature")
            .unwrap()
            .fill_bytes(&mut other_purpose);
        assert_ne!(first, second);
        assert_ne!(first, other_purpose);
    }

    #[test]
    fn root_derivation_is_bound_to_the_canister_identity() {
        let raw_rand = [14; 32];
        let output_canister = Principal::from_slice(&[10]);
        let mut first = ready_gate(80, Principal::from_slice(&[8]), &raw_rand);
        let mut second = ready_gate(80, Principal::from_slice(&[9]), &raw_rand);
        let mut first_bytes = [0; 32];
        let mut second_bytes = [0; 32];
        first
            .output_rng(output_canister, b"authority")
            .unwrap()
            .fill_bytes(&mut first_bytes);
        second
            .output_rng(output_canister, b"authority")
            .unwrap()
            .fill_bytes(&mut second_bytes);
        assert_ne!(first_bytes, second_bytes);
    }

    #[test]
    fn output_derivation_is_bound_to_the_canister_identity() {
        let root_canister = Principal::from_slice(&[11]);
        let mut first = ready_gate(81, root_canister, &[15; 32]);
        let mut second = first.clone();
        let mut first_bytes = [0; 32];
        let mut second_bytes = [0; 32];
        first
            .output_rng(root_canister, b"authority")
            .unwrap()
            .fill_bytes(&mut first_bytes);
        second
            .output_rng(Principal::from_slice(&[12]), b"authority")
            .unwrap()
            .fill_bytes(&mut second_bytes);
        assert_ne!(first_bytes, second_bytes);
    }

    #[test]
    fn output_counter_exhaustion_is_permanently_fail_closed_for_the_lifecycle() {
        let mut gate = ready_gate(90, Principal::from_slice(&[10]), &[15; 32]);
        gate.next_output_counter = u64::MAX;
        let canister = Principal::from_slice(&[10]);
        assert!(gate.output_rng(canister, b"token").is_err());
        assert!(gate.output_rng(canister, b"token").is_err());
    }

    #[test]
    fn post_reseed_initialization_failure_revokes_output_and_rejects_same_lifecycle_replay() {
        let canister = Principal::from_slice(&[11]);
        let mut gate = ready_gate(100, canister, &[16; 32]);
        gate.mark_unavailable();
        assert!(!gate.is_ready());
        let replay = start(&mut gate, 2);
        assert!(!finish(&mut gate, replay, canister, &[16; 32], 2));
        assert!(!gate.is_ready());
    }

    #[test]
    fn production_commitment_remains_exact_sha256_of_raw_rand() {
        let raw_rand = [0x71; 32];
        let mut gate = Pr2EntropyGate::default();
        advance(&mut gate, 110);
        let ticket = start(&mut gate, 0);
        assert!(finish(&mut gate, ticket, Principal::from_slice(&[12]), &raw_rand, 0));
        assert_eq!(gate.last_raw_rand_commitment, Some(Sha256::digest(raw_rand).into()));
    }

    #[test]
    fn production_rejects_repeated_raw_rand_across_lifecycles() {
        let raw_rand = [0x81; 32];
        let canister = Principal::from_slice(&[13]);
        let mut gate = ready_gate(120, canister, &raw_rand);
        advance(&mut gate, 121);
        let replay = start(&mut gate, 2);
        assert!(!finish(&mut gate, replay, canister, &raw_rand, 2));
        assert!(!gate.is_ready());
    }

    #[test]
    fn test_mode_allows_deterministic_fixture_only_in_a_new_lifecycle() {
        let raw_rand = [0x91; 32];
        let canister = Principal::from_slice(&[14]);
        let mut gate = Pr2EntropyGate::default();
        advance(&mut gate, 130);
        let first = start(&mut gate, 0);
        assert!(gate.finish_reseed(first, canister, Pr2EntropyCommitmentMode::TestMode, &raw_rand, 0));
        let first_commitment = gate.last_raw_rand_commitment;

        gate.mark_unavailable();
        let same_lifecycle = start(&mut gate, 1);
        assert!(!gate.finish_reseed(same_lifecycle, canister, Pr2EntropyCommitmentMode::TestMode, &raw_rand, 1));

        advance(&mut gate, 131);
        let second = start(&mut gate, 2);
        assert!(gate.finish_reseed(second, canister, Pr2EntropyCommitmentMode::TestMode, &raw_rand, 2));
        assert_ne!(gate.last_raw_rand_commitment, first_commitment);
    }

    #[test]
    fn lifecycle_generation_overflow_is_terminal_and_fail_closed() {
        let mut gate = Pr2EntropyGate::default();
        gate.lifecycle = Some(Pr2EntropyLifecycleId {
            generation: u64::MAX,
            version_salt: 140,
        });
        gate.ready_lifecycle = gate.lifecycle;
        gate.root_seed = [1; 32];
        assert!(gate.advance_lifecycle(141).is_err());
        assert!(!gate.is_ready());
        assert!(gate.output_rng(Principal::from_slice(&[15]), b"bearer").is_err());
        assert_eq!(gate.begin_reseed(0), Pr2EntropyReseedAdmission::Unavailable);
        assert!(gate.advance_lifecycle(142).is_err());
    }

    #[derive(Serialize)]
    struct LegacyEightFieldPr2EntropyGate {
        observed_canister_version: Option<u64>,
        ready_canister_version: Option<u64>,
        root_seed: [u8; 32],
        next_output_counter: u64,
        last_raw_rand_commitment: Option<[u8; 32]>,
        reseed_in_progress_for: Option<u64>,
        reseed_attempts: u8,
        retry_after: u64,
    }

    #[test]
    fn original_eight_field_legacy_state_also_decodes_fail_closed() {
        let legacy = LegacyEightFieldPr2EntropyGate {
            observed_canister_version: Some(40),
            ready_canister_version: Some(40),
            root_seed: [0xA0; 32],
            next_output_counter: 6,
            last_raw_rand_commitment: Some([0xB1; 32]),
            reseed_in_progress_for: None,
            reseed_attempts: 0,
            retry_after: 0,
        };
        let encoded = msgpack::serialize_to_vec(&legacy).unwrap();
        let mut restored: Pr2EntropyGate = msgpack::deserialize_then_unwrap(&encoded);

        assert_eq!(restored.lifecycle_id(), None);
        assert!(!restored.is_ready());
        assert!(restored.output_rng(Principal::from_slice(&[20]), b"legacy-eight").is_err());
        assert_eq!(restored.begin_reseed(0), Pr2EntropyReseedAdmission::Unavailable);
    }

    #[derive(Serialize)]
    struct LegacyPr2EntropyGate {
        observed_canister_version: Option<u64>,
        ready_canister_version: Option<u64>,
        root_seed: [u8; 32],
        next_output_counter: u64,
        last_raw_rand_commitment: Option<[u8; 32]>,
        reseed_in_progress_for: Option<u64>,
        reseed_attempts: u8,
        retry_after: u64,
        reseed_attempt_generation: u64,
        reseed_deadline: u64,
    }

    #[test]
    fn legacy_ready_state_decodes_fail_closed_and_requires_lifecycle_advance() {
        let legacy = LegacyPr2EntropyGate {
            observed_canister_version: Some(41),
            ready_canister_version: Some(41),
            root_seed: [0xA1; 32],
            next_output_counter: 7,
            last_raw_rand_commitment: Some([0xB2; 32]),
            reseed_in_progress_for: Some(41),
            reseed_attempts: 2,
            retry_after: 9,
            reseed_attempt_generation: 3,
            reseed_deadline: 12,
        };
        let encoded = msgpack::serialize_to_vec(&legacy).unwrap();
        let mut restored: Pr2EntropyGate = msgpack::deserialize_then_unwrap(&encoded);

        assert_eq!(restored.lifecycle_id(), None);
        assert!(!restored.is_ready());
        assert!(restored.output_rng(Principal::from_slice(&[16]), b"legacy").is_err());
        assert_eq!(restored.begin_reseed(20), Pr2EntropyReseedAdmission::Unavailable);

        assert_eq!(advance(&mut restored, 150).generation, 1);
        assert!(!restored.is_ready());
        assert!(matches!(restored.begin_reseed(20), Pr2EntropyReseedAdmission::Started(_)));
    }
}
