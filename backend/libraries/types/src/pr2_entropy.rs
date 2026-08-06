use candid::Principal;
use rand::SeedableRng;
use rand::rngs::StdRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const ROOT_DOMAIN: &[u8] = b"openchat/pr2/entropy-root/v1\0";
const OUTPUT_DOMAIN: &[u8] = b"openchat/pr2/security-output/v1\0";
const TEST_MODE_COMMITMENT_DOMAIN: &[u8] = b"openchat/pr2/test-mode-raw-rand-commitment/v1\0";
const MAX_RESEED_ATTEMPTS_PER_WINDOW: u8 = 3;
const RETRY_DELAY_MS: u64 = 5_000;
const EXHAUSTED_RETRY_DELAY_MS: u64 = 60_000;
pub const PR2_ENTROPY_RESEED_WATCHDOG_MS: u64 = 60_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Pr2EntropyReseedTicket {
    canister_version: u64,
    attempt: u64,
}

/// Selects how replay commitments are derived from management-canister randomness.
///
/// Production retains the original `SHA256(raw_rand)` commitment exactly. PocketIC can return
/// deterministic bytes after an upgrade, so test mode also binds the commitment to the canister
/// version. This permits the same fixture bytes in a new version without permitting a replay in
/// the same version.
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
/// randomness. A canister snapshot restores this value but the IC increments `canister_version`, so
/// a restored snapshot cannot issue another output until a fresh management-canister `raw_rand`
/// response is accepted for the new version.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Pr2EntropyGate {
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
    /// reset on an upgrade, so a delayed callback cannot alias a later same-version attempt.
    #[serde(default)]
    reseed_attempt_generation: u64,
    /// Persisted because canister timers are not. A post-upgrade lifecycle pass can reconstruct a
    /// ticket-bound watchdog for an in-flight call, or expire a legacy/hung attempt safely.
    #[serde(default)]
    reseed_deadline: u64,
}

impl Default for Pr2EntropyGate {
    fn default() -> Self {
        Self {
            observed_canister_version: None,
            ready_canister_version: None,
            root_seed: [0; 32],
            next_output_counter: 0,
            last_raw_rand_commitment: None,
            reseed_in_progress_for: None,
            reseed_attempts: 0,
            retry_after: 0,
            reseed_attempt_generation: 0,
            reseed_deadline: 0,
        }
    }
}

impl Pr2EntropyGate {
    /// Observes the system canister version and invalidates every derived output state when it
    /// changes. Callers use the boolean to invalidate any short-lived bearer records that were
    /// restored with the old heap. Long-lived configuration is deliberately left to the caller.
    pub fn ensure_canister_version(&mut self, canister_version: u64) -> bool {
        let changed = self.observed_canister_version != Some(canister_version);
        self.invalidate_if_version_changed(canister_version);
        changed
    }

    pub fn is_ready(&self, canister_version: u64) -> bool {
        self.ready_canister_version == Some(canister_version)
    }

    /// Lets adapters distinguish an active rejection (which needs a bounded retry) from a delayed
    /// stale callback (which must not schedule duplicate work). No seed or replay commitment is
    /// exposed.
    pub fn is_active_reseed_ticket(&self, ticket: Pr2EntropyReseedTicket, current_canister_version: u64) -> bool {
        self.ticket_is_active(ticket, current_canister_version)
    }

    pub fn begin_reseed(&mut self, canister_version: u64, now: u64) -> Pr2EntropyReseedAdmission {
        self.invalidate_if_version_changed(canister_version);
        if self.is_ready(canister_version) {
            return Pr2EntropyReseedAdmission::Ready;
        }
        if self.reseed_in_progress_for == Some(canister_version) {
            let ticket = Pr2EntropyReseedTicket {
                canister_version,
                attempt: self.reseed_attempt_generation,
            };
            if now < self.reseed_deadline {
                return Pr2EntropyReseedAdmission::InProgress {
                    ticket,
                    watchdog_delay_ms: self.reseed_deadline - now,
                };
            }

            // Timers are not persisted and management callbacks can be lost across upgrades. An
            // expired (or legacy, zero-deadline) attempt enters the same bounded backoff as an
            // explicit raw_rand failure.
            self.fail_reseed(ticket, canister_version, now);
            return Pr2EntropyReseedAdmission::RetryAfter(self.retry_after.saturating_sub(now));
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
        self.reseed_in_progress_for = Some(canister_version);
        self.reseed_deadline = now.saturating_add(PR2_ENTROPY_RESEED_WATCHDOG_MS);
        Pr2EntropyReseedAdmission::Started(Pr2EntropyReseedTicket {
            canister_version,
            attempt,
        })
    }

    pub fn finish_reseed(
        &mut self,
        ticket: Pr2EntropyReseedTicket,
        current_canister_version: u64,
        canister_id: Principal,
        commitment_mode: Pr2EntropyCommitmentMode,
        raw_rand: &[u8],
        now: u64,
    ) -> bool {
        self.invalidate_if_version_changed(current_canister_version);
        if !self.ticket_is_active(ticket, current_canister_version) {
            return false;
        }
        if now >= self.reseed_deadline {
            self.fail_reseed(ticket, current_canister_version, now);
            return false;
        }
        if raw_rand.len() != 32 {
            self.fail_reseed(ticket, current_canister_version, now);
            return false;
        }
        let raw_commitment = raw_rand_commitment(commitment_mode, current_canister_version, raw_rand);
        if self.last_raw_rand_commitment == Some(raw_commitment) {
            self.fail_reseed(ticket, current_canister_version, now);
            return false;
        }
        let mut hasher = Sha256::new();
        hasher.update(ROOT_DOMAIN);
        hasher.update([canister_id.as_slice().len() as u8]);
        hasher.update(canister_id.as_slice());
        hasher.update(current_canister_version.to_le_bytes());
        hasher.update(raw_rand);
        self.root_seed = hasher.finalize().into();
        self.ready_canister_version = Some(current_canister_version);
        self.next_output_counter = 0;
        self.last_raw_rand_commitment = Some(raw_commitment);
        self.reseed_in_progress_for = None;
        self.reseed_deadline = 0;
        self.reseed_attempts = 0;
        self.retry_after = 0;
        true
    }

    pub fn fail_reseed(&mut self, ticket: Pr2EntropyReseedTicket, current_canister_version: u64, now: u64) -> bool {
        self.invalidate_if_version_changed(current_canister_version);
        if self.ticket_is_active(ticket, current_canister_version) {
            self.reseed_in_progress_for = None;
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

    /// Checks the exact persisted attempt associated with a watchdog. Old timers and callbacks are
    /// intentionally harmless: only the current version+attempt may enter backoff.
    pub fn check_reseed_watchdog(
        &mut self,
        ticket: Pr2EntropyReseedTicket,
        current_canister_version: u64,
        now: u64,
    ) -> Pr2EntropyReseedWatchdog {
        self.invalidate_if_version_changed(current_canister_version);
        if !self.ticket_is_active(ticket, current_canister_version) {
            return Pr2EntropyReseedWatchdog::Stale;
        }
        if now < self.reseed_deadline {
            return Pr2EntropyReseedWatchdog::Pending(self.reseed_deadline - now);
        }
        self.fail_reseed(ticket, current_canister_version, now);
        Pr2EntropyReseedWatchdog::Expired
    }

    /// Removes current-version output capability without forgetting the raw-rand commitment.
    /// Canisters use this when post-reseed initialization of persisted security state fails: no
    /// bearer or signature may be issued, and the same raw-rand response cannot be accepted again.
    pub fn mark_unavailable(&mut self, current_canister_version: u64) {
        self.invalidate_if_version_changed(current_canister_version);
        self.ready_canister_version = None;
        self.root_seed.fill(0);
        self.next_output_counter = 0;
        self.reseed_in_progress_for = None;
        self.reseed_deadline = 0;
        self.reseed_attempts = 0;
        self.retry_after = 0;
    }

    pub fn output_rng(&mut self, canister_version: u64, purpose: &[u8]) -> Result<StdRng, &'static str> {
        self.invalidate_if_version_changed(canister_version);
        if !self.is_ready(canister_version) {
            return Err("PR2 entropy is not ready for the current canister version");
        }
        let counter = self.next_output_counter;
        self.next_output_counter = self
            .next_output_counter
            .checked_add(1)
            .ok_or("PR2 entropy output counter exhausted")?;
        let mut hasher = Sha256::new();
        hasher.update(OUTPUT_DOMAIN);
        hasher.update(self.root_seed);
        hasher.update(canister_version.to_le_bytes());
        hasher.update(counter.to_le_bytes());
        hasher.update((purpose.len() as u64).to_le_bytes());
        hasher.update(purpose);
        Ok(StdRng::from_seed(hasher.finalize().into()))
    }

    fn invalidate_if_version_changed(&mut self, canister_version: u64) {
        if self.observed_canister_version != Some(canister_version) {
            self.observed_canister_version = Some(canister_version);
            self.ready_canister_version = None;
            self.root_seed.fill(0);
            self.next_output_counter = 0;
            self.reseed_in_progress_for = None;
            self.reseed_deadline = 0;
            self.reseed_attempts = 0;
            self.retry_after = 0;
        }
    }

    fn ticket_is_active(&self, ticket: Pr2EntropyReseedTicket, current_canister_version: u64) -> bool {
        ticket.canister_version == current_canister_version
            && self.reseed_in_progress_for == Some(ticket.canister_version)
            && ticket.attempt == self.reseed_attempt_generation
    }
}

fn raw_rand_commitment(mode: Pr2EntropyCommitmentMode, canister_version: u64, raw_rand: &[u8]) -> [u8; 32] {
    match mode {
        Pr2EntropyCommitmentMode::Production => Sha256::digest(raw_rand).into(),
        Pr2EntropyCommitmentMode::TestMode => {
            let mut hasher = Sha256::new();
            hasher.update(TEST_MODE_COMMITMENT_DOMAIN);
            hasher.update(canister_version.to_le_bytes());
            hasher.update(raw_rand);
            hasher.finalize().into()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::RngCore;

    fn start(gate: &mut Pr2EntropyGate, version: u64, now: u64) -> Pr2EntropyReseedTicket {
        let Pr2EntropyReseedAdmission::Started(ticket) = gate.begin_reseed(version, now) else {
            panic!("expected reseed admission")
        };
        ticket
    }

    fn finish(
        gate: &mut Pr2EntropyGate,
        ticket: Pr2EntropyReseedTicket,
        version: u64,
        canister: Principal,
        raw_rand: &[u8],
        now: u64,
    ) -> bool {
        gate.finish_reseed(ticket, version, canister, Pr2EntropyCommitmentMode::Production, raw_rand, now)
    }

    #[test]
    fn snapshot_version_mismatch_blocks_until_fresh_raw_rand_reseed() {
        let canister = Principal::from_slice(&[1]);
        let mut gate = Pr2EntropyGate::default();
        let ticket = start(&mut gate, 7, 1);
        assert!(finish(&mut gate, ticket, 7, canister, &[3; 32], 1));
        assert!(gate.output_rng(7, b"bearer").is_ok());

        let snapshot = msgpack::serialize_to_vec(&gate).unwrap();
        let mut restored: Pr2EntropyGate = msgpack::deserialize_then_unwrap(&snapshot);
        assert!(restored.output_rng(8, b"bearer").is_err());
        let ticket = start(&mut restored, 8, 2);
        assert!(finish(&mut restored, ticket, 8, canister, &[4; 32], 2));
        assert!(restored.output_rng(8, b"bearer").is_ok());
    }

    #[test]
    fn version_observation_reports_only_real_epoch_changes() {
        let mut gate = Pr2EntropyGate::default();
        assert!(gate.ensure_canister_version(7));
        assert!(!gate.ensure_canister_version(7));

        let ticket = start(&mut gate, 7, 1);
        assert!(finish(&mut gate, ticket, 7, Principal::from_slice(&[1]), &[3; 32], 1,));
        assert!(gate.is_ready(7));

        assert!(gate.ensure_canister_version(8));
        assert!(!gate.is_ready(7));
        assert!(!gate.is_ready(8));
        assert!(!gate.ensure_canister_version(8));
    }

    #[test]
    fn stale_callback_and_replayed_raw_rand_cannot_restore_readiness() {
        let canister = Principal::from_slice(&[2]);
        let mut gate = Pr2EntropyGate::default();
        let stale = start(&mut gate, 10, 1);
        assert!(!finish(&mut gate, stale, 11, canister, &[5; 32], 1));
        assert!(gate.output_rng(11, b"signature").is_err());

        let current = start(&mut gate, 11, 2);
        assert!(finish(&mut gate, current, 11, canister, &[5; 32], 2));
        assert!(gate.output_rng(11, b"signature").is_ok());

        assert!(gate.output_rng(12, b"signature").is_err());
        let replay = start(&mut gate, 12, 3);
        assert!(!finish(&mut gate, replay, 12, canister, &[5; 32], 3));
        assert!(gate.output_rng(12, b"signature").is_err());
    }

    #[test]
    fn concurrent_reseed_and_retry_are_bounded() {
        let mut gate = Pr2EntropyGate::default();
        let ticket = start(&mut gate, 1, 10);
        assert_eq!(
            gate.begin_reseed(1, 10),
            Pr2EntropyReseedAdmission::InProgress {
                ticket,
                watchdog_delay_ms: PR2_ENTROPY_RESEED_WATCHDOG_MS,
            }
        );
        gate.fail_reseed(ticket, 1, 10);
        assert_eq!(
            gate.begin_reseed(1, 11),
            Pr2EntropyReseedAdmission::RetryAfter(RETRY_DELAY_MS - 1)
        );
    }

    #[test]
    fn every_output_gets_a_domain_separated_nonrepeating_rng() {
        let canister = Principal::from_slice(&[3]);
        let mut gate = Pr2EntropyGate::default();
        let ticket = start(&mut gate, 1, 1);
        assert!(finish(&mut gate, ticket, 1, canister, &[9; 32], 1));
        let mut first = [0; 32];
        let mut second = [0; 32];
        gate.output_rng(1, b"capability").unwrap().fill_bytes(&mut first);
        gate.output_rng(1, b"capability").unwrap().fill_bytes(&mut second);
        assert_ne!(first, second);
    }

    #[test]
    fn different_purposes_separate_the_first_output_from_identical_seeded_state() {
        let canister = Principal::from_slice(&[4]);
        let mut gate = Pr2EntropyGate::default();
        let ticket = start(&mut gate, 1, 1);
        assert!(finish(&mut gate, ticket, 1, canister, &[10; 32], 1));
        let mut other_purpose = gate.clone();
        let mut bearer = [0; 32];
        let mut signature = [0; 32];
        gate.output_rng(1, b"bearer").unwrap().fill_bytes(&mut bearer);
        other_purpose.output_rng(1, b"signature").unwrap().fill_bytes(&mut signature);
        assert_ne!(bearer, signature);
    }

    #[test]
    fn same_version_serialization_preserves_the_consumed_output_counter() {
        let canister = Principal::from_slice(&[5]);
        let mut gate = Pr2EntropyGate::default();
        let ticket = start(&mut gate, 2, 1);
        assert!(finish(&mut gate, ticket, 2, canister, &[11; 32], 1));
        let mut first = [0; 32];
        gate.output_rng(2, b"envelope").unwrap().fill_bytes(&mut first);
        let encoded = msgpack::serialize_to_vec(&gate).unwrap();
        let mut reopened: Pr2EntropyGate = msgpack::deserialize_then_unwrap(&encoded);
        let mut second = [0; 32];
        reopened.output_rng(2, b"envelope").unwrap().fill_bytes(&mut second);
        assert_ne!(first, second);
    }

    #[test]
    fn invalid_raw_rand_length_remains_blocked_and_observes_backoff() {
        let canister = Principal::from_slice(&[6]);
        let mut gate = Pr2EntropyGate::default();
        let ticket = start(&mut gate, 3, 100);
        assert!(!finish(&mut gate, ticket, 3, canister, &[12; 31], 100));
        assert!(gate.output_rng(3, b"authority").is_err());
        assert_eq!(
            gate.begin_reseed(3, 101),
            Pr2EntropyReseedAdmission::RetryAfter(RETRY_DELAY_MS - 1)
        );
    }

    #[test]
    fn output_counter_exhaustion_is_permanently_fail_closed_for_that_epoch() {
        let canister = Principal::from_slice(&[7]);
        let mut gate = Pr2EntropyGate::default();
        let ticket = start(&mut gate, 4, 1);
        assert!(finish(&mut gate, ticket, 4, canister, &[13; 32], 1));
        gate.next_output_counter = u64::MAX;
        assert!(gate.output_rng(4, b"token").is_err());
        assert!(gate.output_rng(4, b"token").is_err());
    }

    #[test]
    fn stale_callback_immediately_clears_old_in_flight_version() {
        let mut gate = Pr2EntropyGate::default();
        let stale = start(&mut gate, 20, 1);
        assert!(!finish(&mut gate, stale, 21, Principal::from_slice(&[8]), &[14; 32], 1,));
        assert!(matches!(gate.begin_reseed(21, 1), Pr2EntropyReseedAdmission::Started(_)));
    }

    #[test]
    fn post_reseed_initialization_failure_revokes_output_and_rejects_raw_rand_replay() {
        let canister = Principal::from_slice(&[9]);
        let mut gate = Pr2EntropyGate::default();
        let ticket = start(&mut gate, 30, 1);
        assert!(finish(&mut gate, ticket, 30, canister, &[15; 32], 1));
        assert!(gate.output_rng(30, b"bootstrap").is_ok());

        gate.mark_unavailable(30);
        assert!(!gate.is_ready(30));
        assert!(gate.output_rng(30, b"bearer").is_err());

        let replay = start(&mut gate, 30, 2);
        assert!(!finish(&mut gate, replay, 30, canister, &[15; 32], 2));
        assert!(gate.output_rng(30, b"bearer").is_err());
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
    }

    #[test]
    fn legacy_messagepack_snapshot_defaults_recovery_fields_without_losing_readiness() {
        let legacy = LegacyPr2EntropyGate {
            observed_canister_version: Some(41),
            ready_canister_version: Some(41),
            root_seed: [0xA1; 32],
            next_output_counter: 7,
            last_raw_rand_commitment: Some([0xB2; 32]),
            reseed_in_progress_for: None,
            reseed_attempts: 0,
            retry_after: 0,
        };
        let encoded = msgpack::serialize_to_vec(&legacy).unwrap();
        let mut restored: Pr2EntropyGate = msgpack::deserialize_then_unwrap(&encoded);

        assert!(restored.is_ready(41));
        assert!(restored.output_rng(41, b"legacy-output").is_ok());
        assert_eq!(restored.reseed_attempt_generation, 0);
        assert_eq!(restored.reseed_deadline, 0);
    }

    #[test]
    fn legacy_inflight_snapshot_enters_backoff_instead_of_remaining_stuck() {
        let legacy = LegacyPr2EntropyGate {
            observed_canister_version: Some(42),
            ready_canister_version: None,
            root_seed: [0; 32],
            next_output_counter: 0,
            last_raw_rand_commitment: None,
            reseed_in_progress_for: Some(42),
            reseed_attempts: 1,
            retry_after: 0,
        };
        let encoded = msgpack::serialize_to_vec(&legacy).unwrap();
        let mut restored: Pr2EntropyGate = msgpack::deserialize_then_unwrap(&encoded);

        assert_eq!(
            restored.begin_reseed(42, 10),
            Pr2EntropyReseedAdmission::RetryAfter(RETRY_DELAY_MS)
        );
        let Pr2EntropyReseedAdmission::Started(ticket) = restored.begin_reseed(42, 10 + RETRY_DELAY_MS) else {
            panic!("legacy in-flight attempt must recover after bounded backoff")
        };
        assert_eq!(ticket.attempt, 1);
    }

    #[test]
    fn inflight_ticket_and_deadline_survive_messagepack_and_rebuild_the_watchdog() {
        let mut gate = Pr2EntropyGate::default();
        let ticket = start(&mut gate, 50, 100);
        let encoded = msgpack::serialize_to_vec(&gate).unwrap();
        let mut restored: Pr2EntropyGate = msgpack::deserialize_then_unwrap(&encoded);

        assert_eq!(
            restored.begin_reseed(50, 200),
            Pr2EntropyReseedAdmission::InProgress {
                ticket,
                watchdog_delay_ms: PR2_ENTROPY_RESEED_WATCHDOG_MS - 100,
            }
        );
        assert_eq!(
            restored.check_reseed_watchdog(ticket, 50, 100 + PR2_ENTROPY_RESEED_WATCHDOG_MS - 1),
            Pr2EntropyReseedWatchdog::Pending(1)
        );
        assert_eq!(
            restored.check_reseed_watchdog(ticket, 50, 100 + PR2_ENTROPY_RESEED_WATCHDOG_MS),
            Pr2EntropyReseedWatchdog::Expired
        );
        assert_eq!(
            restored.begin_reseed(50, 101 + PR2_ENTROPY_RESEED_WATCHDOG_MS),
            Pr2EntropyReseedAdmission::RetryAfter(RETRY_DELAY_MS - 1)
        );
    }

    #[test]
    fn stale_same_version_callback_failure_and_watchdog_cannot_cancel_new_attempt() {
        let canister = Principal::from_slice(&[10]);
        let mut gate = Pr2EntropyGate::default();
        let stale = start(&mut gate, 60, 0);
        assert_eq!(
            gate.check_reseed_watchdog(stale, 60, PR2_ENTROPY_RESEED_WATCHDOG_MS),
            Pr2EntropyReseedWatchdog::Expired
        );
        let current = start(&mut gate, 60, PR2_ENTROPY_RESEED_WATCHDOG_MS + RETRY_DELAY_MS);
        assert_ne!(stale, current);

        assert!(!finish(
            &mut gate,
            stale,
            60,
            canister,
            &[0x61; 32],
            PR2_ENTROPY_RESEED_WATCHDOG_MS + RETRY_DELAY_MS + 1,
        ));
        assert!(!gate.fail_reseed(stale, 60, PR2_ENTROPY_RESEED_WATCHDOG_MS + RETRY_DELAY_MS + 1,));
        assert_eq!(
            gate.check_reseed_watchdog(stale, 60, PR2_ENTROPY_RESEED_WATCHDOG_MS + RETRY_DELAY_MS + 1,),
            Pr2EntropyReseedWatchdog::Stale
        );
        assert!(matches!(
            gate.begin_reseed(60, PR2_ENTROPY_RESEED_WATCHDOG_MS + RETRY_DELAY_MS + 1),
            Pr2EntropyReseedAdmission::InProgress { ticket, .. } if ticket == current
        ));
        assert!(finish(
            &mut gate,
            current,
            60,
            canister,
            &[0x62; 32],
            PR2_ENTROPY_RESEED_WATCHDOG_MS + RETRY_DELAY_MS + 1,
        ));
    }

    #[test]
    fn callback_at_or_after_the_persisted_deadline_is_rejected_even_if_timer_is_delayed() {
        let canister = Principal::from_slice(&[14]);
        let mut gate = Pr2EntropyGate::default();
        let ticket = start(&mut gate, 65, 500);

        assert!(!finish(
            &mut gate,
            ticket,
            65,
            canister,
            &[0x66; 32],
            500 + PR2_ENTROPY_RESEED_WATCHDOG_MS,
        ));
        assert!(!gate.is_ready(65));
        assert_eq!(
            gate.check_reseed_watchdog(ticket, 65, 500 + PR2_ENTROPY_RESEED_WATCHDOG_MS),
            Pr2EntropyReseedWatchdog::Stale
        );
        assert_eq!(
            gate.begin_reseed(65, 501 + PR2_ENTROPY_RESEED_WATCHDOG_MS),
            Pr2EntropyReseedAdmission::RetryAfter(RETRY_DELAY_MS - 1)
        );
    }

    #[test]
    fn watchdog_failures_use_the_existing_bounded_backoff_window() {
        let mut gate = Pr2EntropyGate::default();
        let first = start(&mut gate, 70, 0);
        assert_eq!(
            gate.check_reseed_watchdog(first, 70, 60_000),
            Pr2EntropyReseedWatchdog::Expired
        );
        let second = start(&mut gate, 70, 65_000);
        assert_eq!(
            gate.check_reseed_watchdog(second, 70, 125_000),
            Pr2EntropyReseedWatchdog::Expired
        );
        let third = start(&mut gate, 70, 130_000);
        assert_eq!(
            gate.check_reseed_watchdog(third, 70, 190_000),
            Pr2EntropyReseedWatchdog::Expired
        );
        assert_eq!(
            gate.begin_reseed(70, 190_001),
            Pr2EntropyReseedAdmission::RetryAfter(EXHAUSTED_RETRY_DELAY_MS - 1)
        );
        let fourth = start(&mut gate, 70, 250_000);
        assert_eq!(fourth.attempt, third.attempt + 1);
    }

    #[test]
    fn production_commitment_remains_exact_sha256_of_raw_rand() {
        let raw_rand = [0x71; 32];
        let mut gate = Pr2EntropyGate::default();
        let ticket = start(&mut gate, 80, 0);
        assert!(finish(&mut gate, ticket, 80, Principal::from_slice(&[11]), &raw_rand, 0,));
        assert_eq!(gate.last_raw_rand_commitment, Some(Sha256::digest(raw_rand).into()));
    }

    #[test]
    fn test_mode_accepts_deterministic_bytes_across_versions_but_rejects_same_version_replay() {
        let canister = Principal::from_slice(&[12]);
        let raw_rand = [0x81; 32];
        let mut gate = Pr2EntropyGate::default();
        let first = start(&mut gate, 90, 0);
        assert!(gate.finish_reseed(first, 90, canister, Pr2EntropyCommitmentMode::TestMode, &raw_rand, 0,));
        let first_commitment = gate.last_raw_rand_commitment;
        let mut first_output = [0; 32];
        gate.output_rng(90, b"deterministic-pocket-ic-fixture")
            .unwrap()
            .fill_bytes(&mut first_output);

        gate.ensure_canister_version(91);
        let second = start(&mut gate, 91, 1);
        assert!(gate.finish_reseed(second, 91, canister, Pr2EntropyCommitmentMode::TestMode, &raw_rand, 1,));
        assert_ne!(gate.last_raw_rand_commitment, first_commitment);
        let mut second_output = [0; 32];
        gate.output_rng(91, b"deterministic-pocket-ic-fixture")
            .unwrap()
            .fill_bytes(&mut second_output);
        assert_ne!(first_output, second_output);

        gate.mark_unavailable(91);
        let replay = start(&mut gate, 91, 2);
        assert!(!gate.finish_reseed(replay, 91, canister, Pr2EntropyCommitmentMode::TestMode, &raw_rand, 2,));
        assert!(!gate.is_ready(91));
    }

    #[test]
    fn production_mode_still_rejects_identical_raw_rand_after_version_change() {
        let canister = Principal::from_slice(&[13]);
        let raw_rand = [0x91; 32];
        let mut gate = Pr2EntropyGate::default();
        let first = start(&mut gate, 100, 0);
        assert!(finish(&mut gate, first, 100, canister, &raw_rand, 0));

        gate.ensure_canister_version(101);
        let replay = start(&mut gate, 101, 1);
        assert!(!finish(&mut gate, replay, 101, canister, &raw_rand, 1));
        assert!(!gate.is_ready(101));
    }

    #[test]
    fn exhausted_attempt_generation_fails_closed_without_aliasing_an_old_ticket() {
        let mut gate = Pr2EntropyGate::default();
        gate.ensure_canister_version(110);
        gate.reseed_attempt_generation = u64::MAX;

        assert_eq!(
            gate.begin_reseed(110, 1),
            Pr2EntropyReseedAdmission::RetryAfter(EXHAUSTED_RETRY_DELAY_MS)
        );
        assert_eq!(gate.reseed_in_progress_for, None);
        assert!(gate.output_rng(110, b"must-remain-unavailable").is_err());
    }
}
