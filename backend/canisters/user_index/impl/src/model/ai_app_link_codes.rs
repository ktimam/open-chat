use candid::Principal;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};
use types::{AiAppId, CanisterId, TimestampMillis, UserId};

pub const CLAIM_TOKEN_HEX_LENGTH: usize = 64;
pub const MAX_OUTSTANDING_TOKENS_PER_USER: usize = 20;
pub const MAX_OUTSTANDING_TOKENS_PER_APP: usize = 1_000;
pub const MAX_OUTSTANDING_TOKENS: usize = 10_000;
const MAX_EXPIRED_PRUNED_PER_CALL: usize = 64;
const DIGEST_VERSION: u8 = 1;
const LINK_CODE_DOMAIN: &[u8] = b"openchat.ai-app-link-code.v1\0";

pub fn is_valid_claim_token(token: &str) -> bool {
    token.len() == CLAIM_TOKEN_HEX_LENGTH
        && token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// One-time claim tokens pairing a user with an external app. The 256-bit token is bound to the
/// stored app id; the external app cannot redirect it to another registration.
/// Codes are single-use with a short TTL; expired entries are lazily pruned on access.
/// Heap state, serialized across upgrades like the other models.
#[derive(Serialize, Deserialize, Default)]
pub struct AiAppLinkCodes {
    /// Keys in every map are domain-separated SHA-256 digests, never live bearer codes.
    codes: HashMap<String, AiAppLinkCode>,
    #[serde(default)]
    by_user_app: HashMap<UserId, HashMap<AiAppId, String>>,
    #[serde(default)]
    by_expiry: BTreeSet<(TimestampMillis, String)>,
    #[serde(default)]
    indexes_initialized: bool,
    #[serde(default)]
    by_app: HashMap<AiAppId, HashSet<String>>,
    // Existing indexed states predate `by_app`, so this separate bit forces a one-time rebuild.
    #[serde(default)]
    app_index_initialized: bool,
    /// Pre-v1 states stored raw bearer codes. They are short lived, so the safe upgrade migration is
    /// to invalidate them instead of preserving plaintext authorization material.
    #[serde(default)]
    digest_version: u8,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AiAppLinkCode {
    pub user_id: UserId,
    pub app_id: AiAppId,
    #[serde(default)]
    pub app_revision: TimestampMillis,
    #[serde(default = "anonymous_canister_id")]
    pub app_canister_id: CanisterId,
    /// Exact user/app consent epoch at issuance. A set/remove/cancel advances the epoch so a stale
    /// code cannot overwrite the user's newer decision even if an index entry survives migration.
    #[serde(default)]
    pub consent_epoch: u64,
    pub expires: TimestampMillis,
}

fn anonymous_canister_id() -> CanisterId {
    Principal::anonymous()
}

pub enum ClaimLinkCodeResult {
    Valid(AiAppLinkCode),
    Expired,
    NotFound,
}

#[derive(Debug, Eq, PartialEq)]
pub enum InsertLinkCodeError {
    UserLimitReached,
    AppLimitReached,
    StoreFull,
}

impl AiAppLinkCodes {
    pub fn contains_bound(&self, code: &str, this_canister_id: CanisterId) -> bool {
        self.codes.contains_key(&token_digest(code, this_canister_id))
    }

    #[cfg(test)]
    pub fn contains(&self, code: &str) -> bool {
        self.contains_bound(code, test_canister_id())
    }

    /// Inserts a new code for a (user, app) pair, replacing any earlier code for the same pair so
    /// at most one code per pair is outstanding.
    #[expect(
        clippy::too_many_arguments,
        reason = "Keep the existing link-code issuer, app and user binding explicit at this authorization boundary"
    )]
    pub fn insert_bound(
        &mut self,
        code: String,
        this_canister_id: CanisterId,
        user_id: UserId,
        app_id: AiAppId,
        app_revision: TimestampMillis,
        app_canister_id: CanisterId,
        consent_epoch: u64,
        expires: TimestampMillis,
        now: TimestampMillis,
    ) -> Result<(), InsertLinkCodeError> {
        self.ensure_indexes(now);
        self.prune_expired_bounded(now);
        self.prune_expired_for_user(user_id, now);
        let code = token_digest(&code, this_canister_id);

        let existing = self.by_user_app.get(&user_id).and_then(|apps| apps.get(&app_id)).cloned();
        if existing.is_none() {
            if self.by_user_app.get(&user_id).map_or(0, HashMap::len) >= MAX_OUTSTANDING_TOKENS_PER_USER {
                return Err(InsertLinkCodeError::UserLimitReached);
            }
            if self.by_app.get(&app_id).map_or(0, HashSet::len) >= MAX_OUTSTANDING_TOKENS_PER_APP {
                return Err(InsertLinkCodeError::AppLimitReached);
            }
            if self.codes.len() >= MAX_OUTSTANDING_TOKENS {
                return Err(InsertLinkCodeError::StoreFull);
            }
        }
        if let Some(existing) = existing {
            self.remove_code(&existing);
        }

        self.codes.insert(
            code.clone(),
            AiAppLinkCode {
                user_id,
                app_id,
                app_revision,
                app_canister_id,
                consent_epoch,
                expires,
            },
        );
        self.by_user_app.entry(user_id).or_default().insert(app_id, code.clone());
        self.by_app.entry(app_id).or_default().insert(code.clone());
        self.by_expiry.insert((expires, code));
        Ok(())
    }

    /// Validates and consumes a code. A valid code is removed (single-use); an expired one is also
    /// removed but reported as such so callers can distinguish "expired" from "never existed".
    pub fn lookup(&mut self, code: &str, this_canister_id: CanisterId, now: TimestampMillis) -> ClaimLinkCodeResult {
        self.ensure_indexes(now);
        let digest = token_digest(code, this_canister_id);
        let result = match self.codes.get(&digest).cloned() {
            Some(entry) if entry.expires > now => ClaimLinkCodeResult::Valid(entry),
            Some(_) => {
                self.remove_code(&digest);
                ClaimLinkCodeResult::Expired
            }
            None => ClaimLinkCodeResult::NotFound,
        };
        self.prune_expired_bounded(now);
        result
    }

    #[cfg(test)]
    pub fn insert(
        &mut self,
        code: String,
        user_id: UserId,
        app_id: AiAppId,
        expires: TimestampMillis,
        now: TimestampMillis,
    ) -> Result<(), InsertLinkCodeError> {
        self.insert_bound(
            code,
            test_canister_id(),
            user_id,
            app_id,
            now,
            test_app_canister_id(),
            0,
            expires,
            now,
        )
    }

    /// Consumes a previously authorized code. Callers must use `lookup` to authenticate the bound
    /// app canister and exact registry revision before calling this method.
    pub fn claim_bound(&mut self, code: &str, this_canister_id: CanisterId, now: TimestampMillis) -> ClaimLinkCodeResult {
        self.ensure_indexes(now);
        let digest = token_digest(code, this_canister_id);
        let result = match self.remove_code(&digest) {
            Some(entry) if entry.expires > now => ClaimLinkCodeResult::Valid(entry),
            Some(_) => ClaimLinkCodeResult::Expired,
            None => ClaimLinkCodeResult::NotFound,
        };
        self.prune_expired_bounded(now);
        result
    }

    #[cfg(test)]
    pub fn claim(&mut self, code: &str, now: TimestampMillis) -> ClaimLinkCodeResult {
        self.claim_bound(code, test_canister_id(), now)
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.codes.len()
    }

    /// Invalidates every short-lived link bearer and all of its derived indexes. The initialized
    /// markers deliberately remain current so a restored legacy index cannot be rebuilt after a
    /// canister-version change.
    pub fn invalidate_all(&mut self) {
        self.codes.clear();
        self.by_user_app.clear();
        self.by_expiry.clear();
        self.by_app.clear();
        self.indexes_initialized = true;
        self.app_index_initialized = true;
        self.digest_version = DIGEST_VERSION;
    }

    /// Cancels the one outstanding code for an exact user/app pair. Work is O(1) after the bounded
    /// one-time index normalization and is idempotent when no code exists.
    pub fn remove_user_app(&mut self, user_id: UserId, app_id: AiAppId, now: TimestampMillis) -> bool {
        self.ensure_indexes(now);
        let Some(code) = self.by_user_app.get(&user_id).and_then(|apps| apps.get(&app_id)).cloned() else {
            return false;
        };
        self.remove_code(&code).is_some()
    }

    /// Cancels every outstanding link code for one deleted account. The per-user index is capped by
    /// `MAX_OUTSTANDING_TOKENS_PER_USER`, so deletion never scans the global bearer store.
    pub fn remove_user(&mut self, user_id: UserId, now: TimestampMillis) -> usize {
        self.ensure_indexes(now);
        let codes: Vec<_> = self
            .by_user_app
            .get(&user_id)
            .into_iter()
            .flat_map(|apps| apps.values().cloned())
            .take(MAX_OUTSTANDING_TOKENS_PER_USER)
            .collect();
        codes.iter().filter(|code| self.remove_code(code).is_some()).count()
    }

    /// Cancels only the supplied bearer when it is still outstanding for the exact caller. The
    /// token itself selects the app, which prevents an old modal from cancelling a newer token for
    /// the same tuple. A foreign, replaced, consumed, or malformed token is a no-op.
    pub fn cancel_bound(&mut self, code: &str, this_canister_id: CanisterId, user_id: UserId, now: TimestampMillis) -> bool {
        self.ensure_indexes(now);
        if !is_valid_claim_token(code) {
            return false;
        }
        let digest = token_digest(code, this_canister_id);
        let owned_by_caller = self.codes.get(&digest).is_some_and(|entry| entry.user_id == user_id);
        let removed = owned_by_caller && self.remove_code(&digest).is_some();
        self.prune_expired_bounded(now);
        removed
    }

    /// Removes every outstanding capability for an app. Work is bounded by the per-app token cap.
    pub fn remove_app(&mut self, app_id: AiAppId, now: TimestampMillis) -> usize {
        self.ensure_indexes(now);
        let codes: Vec<_> = self
            .by_app
            .get(&app_id)
            .into_iter()
            .flat_map(|codes| codes.iter().cloned())
            .collect();
        let mut removed = 0;
        for code in codes {
            removed += usize::from(self.remove_code(&code).is_some());
        }
        removed
    }

    fn ensure_indexes(&mut self, now: TimestampMillis) {
        if self.digest_version != DIGEST_VERSION {
            // Legacy maps used raw bearer strings as keys. Do not reserialize or preserve those
            // capabilities across the security-boundary upgrade.
            self.codes.clear();
            self.by_user_app.clear();
            self.by_expiry.clear();
            self.by_app.clear();
            self.indexes_initialized = true;
            self.app_index_initialized = true;
            self.digest_version = DIGEST_VERSION;
            return;
        }
        if self.indexes_initialized && self.app_index_initialized {
            return;
        }

        // Upgrade path from the original codes-only map. Keep the newest deterministic entry per
        // pair, discard expired/over-limit legacy state, and rebuild bounded derived indexes once.
        let mut entries: Vec<_> = std::mem::take(&mut self.codes).into_iter().collect();
        entries.sort_unstable_by(|(token_a, entry_a), (token_b, entry_b)| {
            entry_b.expires.cmp(&entry_a.expires).then_with(|| token_a.cmp(token_b))
        });
        self.by_user_app.clear();
        self.by_expiry.clear();
        self.by_app.clear();
        for (token, entry) in entries {
            if entry.expires <= now || self.codes.len() >= MAX_OUTSTANDING_TOKENS {
                continue;
            }
            let user_apps = self.by_user_app.entry(entry.user_id).or_default();
            if user_apps.contains_key(&entry.app_id) || user_apps.len() >= MAX_OUTSTANDING_TOKENS_PER_USER {
                continue;
            }
            let app_codes = self.by_app.entry(entry.app_id).or_default();
            if app_codes.len() >= MAX_OUTSTANDING_TOKENS_PER_APP {
                continue;
            }
            user_apps.insert(entry.app_id, token.clone());
            app_codes.insert(token.clone());
            self.by_expiry.insert((entry.expires, token.clone()));
            self.codes.insert(token, entry);
        }
        self.indexes_initialized = true;
        self.app_index_initialized = true;
    }

    fn prune_expired_bounded(&mut self, now: TimestampMillis) {
        for _ in 0..MAX_EXPIRED_PRUNED_PER_CALL {
            let Some((expires, token)) = self.by_expiry.first().cloned() else {
                break;
            };
            if expires > now {
                break;
            }
            self.remove_code(&token);
        }
    }

    fn prune_expired_for_user(&mut self, user_id: UserId, now: TimestampMillis) {
        let expired: Vec<_> = self
            .by_user_app
            .get(&user_id)
            .into_iter()
            .flat_map(|apps| apps.values())
            .filter(|token| self.codes.get(*token).is_some_and(|entry| entry.expires <= now))
            .cloned()
            .collect();
        for token in expired {
            self.remove_code(&token);
        }
    }

    fn remove_code(&mut self, code: &str) -> Option<AiAppLinkCode> {
        let entry = self.codes.remove(code)?;
        self.by_expiry.remove(&(entry.expires, code.to_string()));
        let remove_user = if let Some(apps) = self.by_user_app.get_mut(&entry.user_id) {
            if apps.get(&entry.app_id).is_some_and(|current| current == code) {
                apps.remove(&entry.app_id);
            }
            apps.is_empty()
        } else {
            false
        };
        if remove_user {
            self.by_user_app.remove(&entry.user_id);
        }
        let remove_app = if let Some(codes) = self.by_app.get_mut(&entry.app_id) {
            codes.remove(code);
            codes.is_empty()
        } else {
            false
        };
        if remove_app {
            self.by_app.remove(&entry.app_id);
        }
        Some(entry)
    }
}

fn token_digest(code: &str, this_canister_id: CanisterId) -> String {
    let mut input = Vec::with_capacity(LINK_CODE_DOMAIN.len() + this_canister_id.as_slice().len() + code.len());
    input.extend_from_slice(LINK_CODE_DOMAIN);
    input.extend_from_slice(this_canister_id.as_slice());
    input.extend_from_slice(code.as_bytes());
    sha256::sha256_string(&input)
}

#[cfg(test)]
fn test_canister_id() -> CanisterId {
    Principal::from_slice(&[0xC1])
}

#[cfg(test)]
fn test_app_canister_id() -> CanisterId {
    Principal::from_slice(&[0xA1])
}

#[cfg(test)]
mod tests {
    use super::*;
    use candid::Principal;

    fn user(seed: u32) -> UserId {
        Principal::self_authenticating(seed.to_le_bytes()).into()
    }

    fn token(seed: usize) -> String {
        format!("{seed:064x}")
    }

    #[test]
    fn claim_token_format_is_exact_and_canonical() {
        assert!(is_valid_claim_token(&"ab".repeat(32)));
        assert!(is_valid_claim_token(&"0".repeat(CLAIM_TOKEN_HEX_LENGTH)));
        assert!(!is_valid_claim_token("123456"));
        assert!(!is_valid_claim_token(&"a".repeat(CLAIM_TOKEN_HEX_LENGTH - 1)));
        assert!(!is_valid_claim_token(&"a".repeat(CLAIM_TOKEN_HEX_LENGTH + 1)));
        assert!(!is_valid_claim_token(&"A".repeat(CLAIM_TOKEN_HEX_LENGTH)));
        assert!(!is_valid_claim_token(&"g".repeat(CLAIM_TOKEN_HEX_LENGTH)));
    }

    #[test]
    fn outstanding_tokens_are_bounded_per_user_and_pair_replacement_is_constant_size() {
        let mut codes = AiAppLinkCodes::default();
        let owner = user(1);
        for app_id in 0..MAX_OUTSTANDING_TOKENS_PER_USER as AiAppId {
            codes.insert(token(app_id as usize), owner, app_id, 1_000, 1).unwrap();
        }
        assert_eq!(codes.len(), MAX_OUTSTANDING_TOKENS_PER_USER);
        assert_eq!(codes.insert(token(9_000), owner, 0, 2_000, 2), Ok(()));
        assert_eq!(codes.len(), MAX_OUTSTANDING_TOKENS_PER_USER);
        assert_eq!(
            codes.insert(token(9_001), owner, MAX_OUTSTANDING_TOKENS_PER_USER as AiAppId, 2_000, 2),
            Err(InsertLinkCodeError::UserLimitReached)
        );
    }

    #[test]
    fn global_capacity_is_bounded_and_recovers_from_expiry_without_a_full_scan() {
        let mut codes = AiAppLinkCodes::default();
        for seed in 0..MAX_OUTSTANDING_TOKENS {
            codes
                .insert(token(seed), user(seed as u32), seed as AiAppId + 1, 10, 1)
                .unwrap();
        }
        assert_eq!(codes.len(), MAX_OUTSTANDING_TOKENS);
        assert_eq!(
            codes.insert(
                token(MAX_OUTSTANDING_TOKENS + 1),
                user(u32::MAX),
                MAX_OUTSTANDING_TOKENS as AiAppId + 1,
                10,
                1,
            ),
            Err(InsertLinkCodeError::StoreFull)
        );
        codes
            .insert(
                token(MAX_OUTSTANDING_TOKENS + 2),
                user(u32::MAX),
                MAX_OUTSTANDING_TOKENS as AiAppId + 2,
                20,
                11,
            )
            .unwrap();
        assert!(codes.len() <= MAX_OUTSTANDING_TOKENS);
    }

    #[test]
    fn one_app_cannot_monopolize_link_codes_and_cleanup_is_indexed() {
        let mut codes = AiAppLinkCodes::default();
        for seed in 0..MAX_OUTSTANDING_TOKENS_PER_APP {
            codes.insert(token(seed), user(seed as u32), 7, 1_000, 1).unwrap();
        }
        assert_eq!(
            codes.insert(token(9_000), user(u32::MAX), 7, 1_000, 1),
            Err(InsertLinkCodeError::AppLimitReached)
        );
        assert_eq!(codes.remove_app(7, 1), MAX_OUTSTANDING_TOKENS_PER_APP);
        assert_eq!(codes.len(), 0);
    }

    #[test]
    fn legacy_codes_only_state_normalizes_deterministically_and_round_trips() {
        #[derive(Serialize)]
        struct Legacy {
            codes: HashMap<String, AiAppLinkCode>,
        }

        let owner = user(77);
        let mut legacy = HashMap::new();
        for app_id in 0..(MAX_OUTSTANDING_TOKENS_PER_USER as AiAppId + 5) {
            legacy.insert(
                token(app_id as usize),
                AiAppLinkCode {
                    user_id: owner,
                    app_id,
                    app_revision: 0,
                    app_canister_id: Principal::anonymous(),
                    consent_epoch: 0,
                    expires: 1_000 + app_id as u64,
                },
            );
        }
        legacy.insert(
            token(9_999),
            AiAppLinkCode {
                user_id: user(88),
                app_id: 1,
                app_revision: 0,
                app_canister_id: Principal::anonymous(),
                consent_epoch: 0,
                expires: 1,
            },
        );
        let bytes = msgpack::serialize_to_vec(&Legacy { codes: legacy }).unwrap();
        let mut restored: AiAppLinkCodes = msgpack::deserialize_then_unwrap(&bytes);

        restored.insert(token(20_000), user(99), 1, 2_000, 2).unwrap();
        assert!(restored.len() <= MAX_OUTSTANDING_TOKENS_PER_USER + 1);
        assert!(matches!(restored.claim(&token(9_999), 2), ClaimLinkCodeResult::NotFound));

        let current = msgpack::serialize_to_vec(&restored).unwrap();
        let mut round_tripped: AiAppLinkCodes = msgpack::deserialize_then_unwrap(&current);
        assert!(matches!(
            round_tripped.claim(&token(20_000), 3),
            ClaimLinkCodeResult::Valid(_)
        ));
    }

    #[test]
    fn legacy_plaintext_state_is_invalidated() {
        #[derive(Serialize)]
        struct Previous {
            codes: HashMap<String, AiAppLinkCode>,
            by_user_app: HashMap<UserId, HashMap<AiAppId, String>>,
            by_expiry: BTreeSet<(TimestampMillis, String)>,
            indexes_initialized: bool,
        }

        let owner = user(42);
        let code = token(42);
        let entry = AiAppLinkCode {
            user_id: owner,
            app_id: 9,
            app_revision: 0,
            app_canister_id: Principal::anonymous(),
            consent_epoch: 0,
            expires: 1_000,
        };
        let bytes = msgpack::serialize_to_vec(&Previous {
            codes: HashMap::from([(code.clone(), entry)]),
            by_user_app: HashMap::from([(owner, HashMap::from([(9, code.clone())]))]),
            by_expiry: BTreeSet::from([(1_000, code)]),
            indexes_initialized: true,
        })
        .unwrap();
        let mut restored: AiAppLinkCodes = msgpack::deserialize_then_unwrap(&bytes);
        assert_eq!(restored.remove_app(9, 1), 0);
        assert_eq!(restored.len(), 0);
    }

    #[test]
    fn live_bearer_is_not_serialized_and_digest_is_canister_bound() {
        let raw = "ab".repeat(32);
        let owner = user(71);
        let app_canister = Principal::from_slice(&[8]);
        let mut codes = AiAppLinkCodes::default();
        codes
            .insert_bound(raw.clone(), test_canister_id(), owner, 4, 99, app_canister, 0, 1_000, 1)
            .unwrap();
        assert!(codes.contains_bound(&raw, test_canister_id()));
        assert!(!codes.contains_bound(&raw, Principal::from_slice(&[0xC2])));
        let encoded = msgpack::serialize_to_vec(&codes).unwrap();
        assert!(!encoded.windows(raw.len()).any(|window| window == raw.as_bytes()));
    }

    #[test]
    fn exact_pair_cancellation_does_not_remove_another_users_code() {
        let mut codes = AiAppLinkCodes::default();
        let user_a = user(1);
        let user_b = user(2);
        codes.insert(token(1), user_a, 7, 1_000, 1).unwrap();
        codes.insert(token(2), user_b, 7, 1_000, 1).unwrap();

        assert!(codes.remove_user_app(user_a, 7, 1));
        assert!(matches!(codes.claim(&token(1), 2), ClaimLinkCodeResult::NotFound));
        assert!(matches!(codes.claim(&token(2), 2), ClaimLinkCodeResult::Valid(_)));
    }

    #[test]
    fn exact_token_cancellation_is_caller_bound() {
        let mut codes = AiAppLinkCodes::default();
        let owner = user(1);
        let attacker = user(2);
        let code = token(101);
        codes.insert(code.clone(), owner, 7, 1_000, 1).unwrap();

        assert!(!codes.cancel_bound(&code, test_canister_id(), attacker, 2));
        assert!(matches!(codes.claim(&code, 2), ClaimLinkCodeResult::Valid(_)));
    }

    #[test]
    fn stale_token_cannot_cancel_its_replacement() {
        let mut codes = AiAppLinkCodes::default();
        let owner = user(1);
        let stale = token(201);
        let current = token(202);
        codes.insert(stale.clone(), owner, 7, 1_000, 1).unwrap();
        codes.insert(current.clone(), owner, 7, 1_000, 2).unwrap();

        assert!(!codes.cancel_bound(&stale, test_canister_id(), owner, 3));
        assert!(matches!(codes.claim(&current, 3), ClaimLinkCodeResult::Valid(_)));
    }

    #[test]
    fn cancellation_and_claim_are_serialized_without_reviving_authority() {
        let owner = user(1);
        let code = token(301);

        let mut cancel_first = AiAppLinkCodes::default();
        cancel_first.insert(code.clone(), owner, 7, 1_000, 1).unwrap();
        assert!(cancel_first.cancel_bound(&code, test_canister_id(), owner, 2));
        assert!(matches!(cancel_first.claim(&code, 2), ClaimLinkCodeResult::NotFound));

        let mut claim_first = AiAppLinkCodes::default();
        claim_first.insert(code.clone(), owner, 7, 1_000, 1).unwrap();
        assert!(matches!(claim_first.claim(&code, 2), ClaimLinkCodeResult::Valid(_)));
        assert!(!claim_first.cancel_bound(&code, test_canister_id(), owner, 2));
    }

    #[test]
    fn canister_version_invalidation_clears_every_code_and_derived_index() {
        let mut codes = AiAppLinkCodes::default();
        let first_user = user(1);
        let second_user = user(2);
        codes.insert(token(1), first_user, 7, 1_000, 1).unwrap();
        codes.insert(token(2), second_user, 8, 1_000, 1).unwrap();

        codes.invalidate_all();

        assert_eq!(codes.len(), 0);
        assert!(matches!(codes.claim(&token(1), 2), ClaimLinkCodeResult::NotFound));
        assert!(matches!(codes.claim(&token(2), 2), ClaimLinkCodeResult::NotFound));
        assert_eq!(codes.remove_app(7, 2), 0);
        assert_eq!(codes.insert(token(3), first_user, 7, 2_000, 2), Ok(()));
        assert_eq!(codes.len(), 1);
    }
}
