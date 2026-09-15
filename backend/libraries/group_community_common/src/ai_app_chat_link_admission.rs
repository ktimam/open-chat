use constants::MINUTE_IN_MS;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use types::{AiAppId, TimestampMillis, UserId};

pub const CHAT_LINK_ADMISSION_WINDOW_MS: TimestampMillis = 10 * MINUTE_IN_MS;
pub const CHAT_LINK_ADMISSION_LEASE_MS: TimestampMillis = 2 * MINUTE_IN_MS;
pub const MAX_CHAT_LINK_ATTEMPTS_PER_USER_APP_WINDOW: u16 = 20;
pub const MAX_CHAT_LINK_ATTEMPTS_PER_CHILD_WINDOW: u16 = 1_000;
pub const MAX_TRACKED_CHAT_LINK_ADMISSION_SUBJECTS: usize = 10_000;
const MAX_EXPIRED_PRUNED_PER_CALL: usize = 64;
const SCHEMA_VERSION: u8 = 1;

type Subject = (UserId, AiAppId);

#[derive(Serialize, Deserialize, Clone, Copy)]
struct LeaseState {
    id: u64,
    expires_at: TimestampMillis,
}

#[derive(Serialize, Deserialize, Clone, Copy)]
struct SubjectWindow {
    started_at: TimestampMillis,
    attempts: u16,
    lease: Option<LeaseState>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AiAppChatLinkAdmissionLease {
    subject: Subject,
    id: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AiAppChatLinkAdmissionError {
    InFlight,
    SubjectRateLimited,
    ChildRateLimited,
    Capacity,
}

/// Stable, bounded child-local admission for chat-link mint attempts.
///
/// Attempts are charged before the first inter-canister await, including failed attempts. This is
/// deliberately stricter than the UserIndex success-based issuance window: once the downstream
/// store is saturated, a caller cannot keep creating GroupIndex authorities and relay traffic.
#[derive(Serialize, Deserialize)]
pub struct AiAppChatLinkAdmission {
    #[serde(default)]
    subjects: HashMap<Subject, SubjectWindow>,
    #[serde(default)]
    expiries: BTreeSet<(TimestampMillis, UserId, AiAppId)>,
    #[serde(default)]
    child_window_started_at: TimestampMillis,
    #[serde(default)]
    child_attempts: u16,
    #[serde(default)]
    next_lease_id: u64,
    #[serde(default)]
    schema_version: u8,
}

impl Default for AiAppChatLinkAdmission {
    fn default() -> Self {
        Self {
            subjects: HashMap::new(),
            expiries: BTreeSet::new(),
            child_window_started_at: 0,
            child_attempts: 0,
            next_lease_id: 0,
            schema_version: SCHEMA_VERSION,
        }
    }
}

impl AiAppChatLinkAdmission {
    pub fn reserve(
        &mut self,
        user_id: UserId,
        app_id: AiAppId,
        now: TimestampMillis,
    ) -> Result<AiAppChatLinkAdmissionLease, AiAppChatLinkAdmissionError> {
        self.ensure_current();
        self.prune_expired_bounded(now);
        if now.saturating_sub(self.child_window_started_at) >= CHAT_LINK_ADMISSION_WINDOW_MS {
            self.child_window_started_at = now;
            self.child_attempts = 0;
        }
        if self.child_attempts >= MAX_CHAT_LINK_ATTEMPTS_PER_CHILD_WINDOW {
            return Err(AiAppChatLinkAdmissionError::ChildRateLimited);
        }

        let subject = (user_id, app_id);
        if self
            .subjects
            .get(&subject)
            .is_some_and(|window| now.saturating_sub(window.started_at) >= CHAT_LINK_ADMISSION_WINDOW_MS)
        {
            self.remove_subject(subject);
        }
        if !self.subjects.contains_key(&subject) && self.subjects.len() >= MAX_TRACKED_CHAT_LINK_ADMISSION_SUBJECTS {
            return Err(AiAppChatLinkAdmissionError::Capacity);
        }

        let window = self.subjects.entry(subject).or_insert_with(|| {
            self.expiries
                .insert((now.saturating_add(CHAT_LINK_ADMISSION_WINDOW_MS), user_id, app_id));
            SubjectWindow {
                started_at: now,
                attempts: 0,
                lease: None,
            }
        });
        if window.lease.is_some_and(|lease| lease.expires_at > now) {
            return Err(AiAppChatLinkAdmissionError::InFlight);
        }
        window.lease = None;
        if window.attempts >= MAX_CHAT_LINK_ATTEMPTS_PER_USER_APP_WINDOW {
            return Err(AiAppChatLinkAdmissionError::SubjectRateLimited);
        }

        self.next_lease_id = self.next_lease_id.wrapping_add(1);
        if self.next_lease_id == 0 {
            self.next_lease_id = 1;
        }
        let lease = AiAppChatLinkAdmissionLease {
            subject,
            id: self.next_lease_id,
        };
        window.attempts = window.attempts.saturating_add(1);
        window.lease = Some(LeaseState {
            id: lease.id,
            expires_at: now.saturating_add(CHAT_LINK_ADMISSION_LEASE_MS),
        });
        self.child_attempts = self.child_attempts.saturating_add(1);
        Ok(lease)
    }

    pub fn is_current(&self, lease: &AiAppChatLinkAdmissionLease, now: TimestampMillis) -> bool {
        self.schema_version == SCHEMA_VERSION
            && self.subjects.get(&lease.subject).is_some_and(|window| {
                window
                    .lease
                    .is_some_and(|current| current.id == lease.id && current.expires_at > now)
            })
    }

    pub fn release(&mut self, lease: &AiAppChatLinkAdmissionLease) -> bool {
        self.ensure_current();
        let Some(window) = self.subjects.get_mut(&lease.subject) else {
            return false;
        };
        if window.lease.is_some_and(|current| current.id == lease.id) {
            window.lease = None;
            true
        } else {
            false
        }
    }

    fn ensure_current(&mut self) {
        if self.schema_version != SCHEMA_VERSION {
            *self = Self::default();
        }
    }

    fn prune_expired_bounded(&mut self, now: TimestampMillis) {
        for _ in 0..MAX_EXPIRED_PRUNED_PER_CALL {
            let Some((expires_at, user_id, app_id)) = self.expiries.first().copied() else {
                break;
            };
            if expires_at > now {
                break;
            }
            self.remove_subject((user_id, app_id));
        }
    }

    fn remove_subject(&mut self, subject: Subject) {
        if let Some(window) = self.subjects.remove(&subject) {
            self.expiries.remove(&(
                window.started_at.saturating_add(CHAT_LINK_ADMISSION_WINDOW_MS),
                subject.0,
                subject.1,
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use candid::Principal;

    fn user(seed: u64) -> UserId {
        Principal::from_slice(&seed.to_be_bytes()).into()
    }

    #[test]
    fn reservation_is_single_flight_and_release_is_exact() {
        let mut admission = AiAppChatLinkAdmission::default();
        let first = admission.reserve(user(1), 7, 1).unwrap();
        assert!(admission.is_current(&first, 1));
        assert_eq!(admission.reserve(user(1), 7, 2), Err(AiAppChatLinkAdmissionError::InFlight));
        let forged = AiAppChatLinkAdmissionLease {
            subject: first.subject,
            id: first.id + 1,
        };
        assert!(!admission.release(&forged));
        assert!(admission.release(&first));
        assert!(admission.reserve(user(1), 7, 2).is_ok());
    }

    #[test]
    fn subject_attempts_are_charged_before_await_and_recover_after_window() {
        let mut admission = AiAppChatLinkAdmission::default();
        for now in 0..MAX_CHAT_LINK_ATTEMPTS_PER_USER_APP_WINDOW as u64 {
            let lease = admission.reserve(user(1), 7, now).unwrap();
            assert!(admission.release(&lease));
        }
        assert_eq!(
            admission.reserve(user(1), 7, 100),
            Err(AiAppChatLinkAdmissionError::SubjectRateLimited)
        );
        assert!(admission.reserve(user(1), 7, CHAT_LINK_ADMISSION_WINDOW_MS).is_ok());
    }

    #[test]
    fn child_attempt_cap_is_exact_across_rotating_subjects() {
        let mut admission = AiAppChatLinkAdmission::default();
        for seed in 0..MAX_CHAT_LINK_ATTEMPTS_PER_CHILD_WINDOW as u64 {
            let lease = admission.reserve(user(seed + 1), 7, 1).unwrap();
            assert!(admission.release(&lease));
        }
        assert_eq!(
            admission.reserve(user(10_000), 7, 2),
            Err(AiAppChatLinkAdmissionError::ChildRateLimited)
        );
        assert!(admission.reserve(user(10_000), 7, CHAT_LINK_ADMISSION_WINDOW_MS).is_ok());
    }

    #[test]
    fn expired_lease_cannot_release_a_new_reservation() {
        let mut admission = AiAppChatLinkAdmission::default();
        let stale = admission.reserve(user(1), 7, 1).unwrap();
        let current = admission.reserve(user(1), 7, CHAT_LINK_ADMISSION_LEASE_MS + 1).unwrap();
        assert!(!admission.release(&stale));
        assert!(admission.is_current(&current, CHAT_LINK_ADMISSION_LEASE_MS + 1));
    }
}
