use candid::Principal;
use rand::SeedableRng;
use rand::rngs::StdRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const ROOT_DOMAIN: &[u8] = b"openchat/pr2/entropy-root/v1\0";
const OUTPUT_DOMAIN: &[u8] = b"openchat/pr2/security-output/v1\0";
const MAX_RESEED_ATTEMPTS_PER_WINDOW: u8 = 3;
const RETRY_DELAY_MS: u64 = 5_000;
const EXHAUSTED_RETRY_DELAY_MS: u64 = 60_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Pr2EntropyReseedTicket {
    canister_version: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Pr2EntropyReseedAdmission {
    Ready,
    Started(Pr2EntropyReseedTicket),
    InProgress,
    RetryAfter(u64),
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

    pub fn begin_reseed(&mut self, canister_version: u64, now: u64) -> Pr2EntropyReseedAdmission {
        self.invalidate_if_version_changed(canister_version);
        if self.is_ready(canister_version) {
            return Pr2EntropyReseedAdmission::Ready;
        }
        if self.reseed_in_progress_for == Some(canister_version) {
            return Pr2EntropyReseedAdmission::InProgress;
        }
        if now < self.retry_after {
            return Pr2EntropyReseedAdmission::RetryAfter(self.retry_after - now);
        }
        if self.reseed_attempts >= MAX_RESEED_ATTEMPTS_PER_WINDOW {
            self.reseed_attempts = 0;
        }
        self.reseed_attempts += 1;
        self.reseed_in_progress_for = Some(canister_version);
        Pr2EntropyReseedAdmission::Started(Pr2EntropyReseedTicket { canister_version })
    }

    pub fn finish_reseed(
        &mut self,
        ticket: Pr2EntropyReseedTicket,
        current_canister_version: u64,
        canister_id: Principal,
        raw_rand: &[u8],
        now: u64,
    ) -> bool {
        self.invalidate_if_version_changed(current_canister_version);
        if ticket.canister_version != current_canister_version
            || self.reseed_in_progress_for != Some(ticket.canister_version)
            || raw_rand.len() != 32
        {
            self.fail_reseed(ticket, current_canister_version, now);
            return false;
        }
        let raw_commitment: [u8; 32] = Sha256::digest(raw_rand).into();
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
        self.reseed_attempts = 0;
        self.retry_after = 0;
        true
    }

    pub fn fail_reseed(&mut self, ticket: Pr2EntropyReseedTicket, current_canister_version: u64, now: u64) {
        if ticket.canister_version == current_canister_version && self.reseed_in_progress_for == Some(ticket.canister_version) {
            self.reseed_in_progress_for = None;
            self.retry_after = now.saturating_add(if self.reseed_attempts >= MAX_RESEED_ATTEMPTS_PER_WINDOW {
                EXHAUSTED_RETRY_DELAY_MS
            } else {
                RETRY_DELAY_MS
            });
        }
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
            self.reseed_attempts = 0;
            self.retry_after = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::Rng;

    fn start(gate: &mut Pr2EntropyGate, version: u64, now: u64) -> Pr2EntropyReseedTicket {
        let Pr2EntropyReseedAdmission::Started(ticket) = gate.begin_reseed(version, now) else {
            panic!("expected reseed admission")
        };
        ticket
    }

    #[test]
    fn snapshot_version_mismatch_blocks_until_fresh_raw_rand_reseed() {
        let canister = Principal::from_slice(&[1]);
        let mut gate = Pr2EntropyGate::default();
        let ticket = start(&mut gate, 7, 1);
        assert!(gate.finish_reseed(ticket, 7, canister, &[3; 32], 1));
        assert!(gate.output_rng(7, b"bearer").is_ok());

        let snapshot = msgpack::serialize_to_vec(&gate).unwrap();
        let mut restored: Pr2EntropyGate = msgpack::deserialize_then_unwrap(&snapshot);
        assert!(restored.output_rng(8, b"bearer").is_err());
        let ticket = start(&mut restored, 8, 2);
        assert!(restored.finish_reseed(ticket, 8, canister, &[4; 32], 2));
        assert!(restored.output_rng(8, b"bearer").is_ok());
    }

    #[test]
    fn version_observation_reports_only_real_epoch_changes() {
        let mut gate = Pr2EntropyGate::default();
        assert!(gate.ensure_canister_version(7));
        assert!(!gate.ensure_canister_version(7));

        let ticket = start(&mut gate, 7, 1);
        assert!(gate.finish_reseed(ticket, 7, Principal::from_slice(&[1]), &[3; 32], 1));
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
        assert!(!gate.finish_reseed(stale, 11, canister, &[5; 32], 1));
        assert!(gate.output_rng(11, b"signature").is_err());

        let current = start(&mut gate, 11, 2);
        assert!(gate.finish_reseed(current, 11, canister, &[5; 32], 2));
        assert!(gate.output_rng(11, b"signature").is_ok());

        assert!(gate.output_rng(12, b"signature").is_err());
        let replay = start(&mut gate, 12, 3);
        assert!(!gate.finish_reseed(replay, 12, canister, &[5; 32], 3));
        assert!(gate.output_rng(12, b"signature").is_err());
    }

    #[test]
    fn concurrent_reseed_and_retry_are_bounded() {
        let mut gate = Pr2EntropyGate::default();
        let ticket = start(&mut gate, 1, 10);
        assert_eq!(gate.begin_reseed(1, 10), Pr2EntropyReseedAdmission::InProgress);
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
        assert!(gate.finish_reseed(ticket, 1, canister, &[9; 32], 1));
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
        assert!(gate.finish_reseed(ticket, 1, canister, &[10; 32], 1));
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
        assert!(gate.finish_reseed(ticket, 2, canister, &[11; 32], 1));
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
        assert!(!gate.finish_reseed(ticket, 3, canister, &[12; 31], 100));
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
        assert!(gate.finish_reseed(ticket, 4, canister, &[13; 32], 1));
        gate.next_output_counter = u64::MAX;
        assert!(gate.output_rng(4, b"token").is_err());
        assert!(gate.output_rng(4, b"token").is_err());
    }

    #[test]
    fn stale_callback_immediately_clears_old_in_flight_version() {
        let mut gate = Pr2EntropyGate::default();
        let stale = start(&mut gate, 20, 1);
        assert!(!gate.finish_reseed(stale, 21, Principal::from_slice(&[8]), &[14; 32], 1));
        assert!(matches!(gate.begin_reseed(21, 1), Pr2EntropyReseedAdmission::Started(_)));
    }

    #[test]
    fn post_reseed_initialization_failure_revokes_output_and_rejects_raw_rand_replay() {
        let canister = Principal::from_slice(&[9]);
        let mut gate = Pr2EntropyGate::default();
        let ticket = start(&mut gate, 30, 1);
        assert!(gate.finish_reseed(ticket, 30, canister, &[15; 32], 1));
        assert!(gate.output_rng(30, b"bootstrap").is_ok());

        gate.mark_unavailable(30);
        assert!(!gate.is_ready(30));
        assert!(gate.output_rng(30, b"bearer").is_err());

        let replay = start(&mut gate, 30, 2);
        assert!(!gate.finish_reseed(replay, 30, canister, &[15; 32], 2));
        assert!(gate.output_rng(30, b"bearer").is_err());
    }
}
