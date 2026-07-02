use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use types::{AiAppId, TimestampMillis, UserId};

/// One-time "link codes" pairing a user with an external app: OpenChat displays a short code to the
/// user, the external app claims it (bearer authorization) to register that user's delivery key.
/// Codes are single-use with a short TTL; expired entries are lazily pruned on access.
/// Heap state, serialized across upgrades like the other models.
#[derive(Serialize, Deserialize, Default)]
pub struct AiAppLinkCodes {
    codes: HashMap<String, AiAppLinkCode>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AiAppLinkCode {
    pub user_id: UserId,
    pub app_id: AiAppId,
    pub expires: TimestampMillis,
}

pub enum ClaimLinkCodeResult {
    Valid(AiAppLinkCode),
    Expired,
    NotFound,
}

impl AiAppLinkCodes {
    pub fn contains(&self, code: &str) -> bool {
        self.codes.contains_key(code)
    }

    /// Inserts a new code for a (user, app) pair, replacing any earlier code for the same pair so
    /// at most one code per pair is outstanding.
    pub fn insert(&mut self, code: String, user_id: UserId, app_id: AiAppId, expires: TimestampMillis, now: TimestampMillis) {
        self.prune_expired(now);
        self.codes.retain(|_, c| !(c.user_id == user_id && c.app_id == app_id));
        self.codes.insert(code, AiAppLinkCode { user_id, app_id, expires });
    }

    /// Validates and consumes a code. A valid code is removed (single-use); an expired one is also
    /// removed but reported as such so callers can distinguish "expired" from "never existed".
    pub fn claim(&mut self, code: &str, now: TimestampMillis) -> ClaimLinkCodeResult {
        match self.codes.remove(code) {
            Some(entry) if entry.expires > now => ClaimLinkCodeResult::Valid(entry),
            Some(_) => ClaimLinkCodeResult::Expired,
            None => ClaimLinkCodeResult::NotFound,
        }
    }

    /// Drops every expired code (called lazily whenever the map is mutated).
    pub fn prune_expired(&mut self, now: TimestampMillis) {
        self.codes.retain(|_, c| c.expires > now);
    }
}
