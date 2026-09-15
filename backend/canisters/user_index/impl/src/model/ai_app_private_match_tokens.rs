use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use types::{AiAppCardContext, AiAppId, CanisterId, TimestampMillis, UserId};

pub const TOKEN_BYTES: usize = 32;
pub const MAX_OUTSTANDING_PER_USER: usize = 8;
pub const MAX_OUTSTANDING_PER_APP: usize = 256;
pub const MAX_OUTSTANDING_TOTAL: usize = 2_000;
const MAX_EXPIRED_PRUNED_PER_CALL: usize = 64;
const ISSUANCE_WINDOW_MS: TimestampMillis = 60_000;
const MAX_ISSUANCES_PER_USER_APP: usize = 10;
const MAX_ISSUANCES_GLOBAL: usize = 2_000;
const INVALID_REDEEM_WINDOW_MS: TimestampMillis = 60_000;
const MAX_INVALID_REDEEMS_PER_CALLER: usize = 10;
const MAX_TRACKED_INVALID_REDEEM_CALLERS: usize = 1_024;
const PRIVATE_MATCH_CAPABILITY_DOMAIN: &[u8] = b"openchat.ai-app-private-match-capability.v1\0";

pub type TokenDigest = [u8; 32];

/// Internal-only bearer discriminator. `PrivateContext` is the fail-closed default so a record
/// missing this newly introduced tag can never be redeemed through the private-match endpoint.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CapabilityKind {
    #[default]
    PrivateContext,
    PrivateMatch,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct PrivateMatchCapability {
    pub context: AiAppCardContext,
    /// Domain-separated commitment computed from the authoritative stored TextContent.
    pub source_binding: [u8; 32],
    pub app_canister_id: CanisterId,
    pub recipient_key_scheme: String,
    pub recipient_public_key: ByteBuf,
    #[serde(default)]
    pub app_user_key_fingerprint: Option<[u8; 32]>,
    #[serde(default)]
    pub app_user_key_version: Option<u64>,
    #[serde(default)]
    pub kind: CapabilityKind,
    pub expires_at: TimestampMillis,
}

#[derive(Debug, Eq, PartialEq)]
pub enum InsertError {
    WrongKind,
    UserLimitReached,
    AppLimitReached,
    StoreFull,
    IssuanceRateLimitReached,
    TokenCollision,
}

#[derive(Debug, Eq, PartialEq)]
pub enum LookupResult {
    Valid(Box<PrivateMatchCapability>),
    WrongKind,
    Expired,
    NotFound,
}

/// Private-match bearers live outside the card bearer maps and issuance windows. This reserves all
/// legacy card capacity for card/provenance/confirmation flows and makes upgrades default-empty.
#[derive(Serialize, Deserialize, Default)]
pub struct AiAppPrivateMatchTokens {
    #[serde(default)]
    capabilities: HashMap<TokenDigest, PrivateMatchCapability>,
    #[serde(default)]
    by_user: HashMap<UserId, HashSet<TokenDigest>>,
    #[serde(default)]
    by_app: HashMap<AiAppId, HashSet<TokenDigest>>,
    #[serde(default)]
    by_expiry: BTreeSet<(TimestampMillis, TokenDigest)>,
    #[serde(default)]
    issuance_by_user_app: HashMap<(UserId, AiAppId), VecDeque<TimestampMillis>>,
    #[serde(default)]
    issuance_global: VecDeque<(TimestampMillis, UserId, AiAppId)>,
    #[serde(default)]
    invalid_redeems_by_caller: HashMap<CanisterId, VecDeque<TimestampMillis>>,
}

impl AiAppPrivateMatchTokens {
    pub fn token_digest(canister_id: CanisterId, token: &[u8]) -> TokenDigest {
        let mut bytes =
            Vec::with_capacity(PRIVATE_MATCH_CAPABILITY_DOMAIN.len() + canister_id.as_slice().len() + 8 + token.len());
        bytes.extend_from_slice(PRIVATE_MATCH_CAPABILITY_DOMAIN);
        bytes.extend_from_slice(canister_id.as_slice());
        bytes.extend_from_slice(&(token.len() as u64).to_be_bytes());
        bytes.extend_from_slice(token);
        sha256::sha256(&bytes)
    }

    pub fn insert(
        &mut self,
        canister_id: CanisterId,
        token: &[u8],
        capability: PrivateMatchCapability,
        now: TimestampMillis,
    ) -> Result<(), InsertError> {
        if capability.kind != CapabilityKind::PrivateMatch {
            return Err(InsertError::WrongKind);
        }
        self.prune_expired(now, MAX_EXPIRED_PRUNED_PER_CALL);
        self.prune_issuance(now);
        let issuance_key = (capability.context.user_id, capability.context.app_id);
        if self.issuance_by_user_app.get(&issuance_key).map_or(0, VecDeque::len) >= MAX_ISSUANCES_PER_USER_APP
            || self.issuance_global.len() >= MAX_ISSUANCES_GLOBAL
        {
            return Err(InsertError::IssuanceRateLimitReached);
        }
        if self.capabilities.len() >= MAX_OUTSTANDING_TOTAL {
            return Err(InsertError::StoreFull);
        }
        if self.by_user.get(&capability.context.user_id).map_or(0, HashSet::len) >= MAX_OUTSTANDING_PER_USER {
            return Err(InsertError::UserLimitReached);
        }
        if self.by_app.get(&capability.context.app_id).map_or(0, HashSet::len) >= MAX_OUTSTANDING_PER_APP {
            return Err(InsertError::AppLimitReached);
        }
        let digest = Self::token_digest(canister_id, token);
        if self.capabilities.contains_key(&digest) {
            return Err(InsertError::TokenCollision);
        }
        self.by_user.entry(capability.context.user_id).or_default().insert(digest);
        self.by_app.entry(capability.context.app_id).or_default().insert(digest);
        self.by_expiry.insert((capability.expires_at, digest));
        self.capabilities.insert(digest, capability);
        self.issuance_by_user_app.entry(issuance_key).or_default().push_back(now);
        self.issuance_global.push_back((now, issuance_key.0, issuance_key.1));
        Ok(())
    }

    pub fn lookup(&mut self, canister_id: CanisterId, token: &[u8], now: TimestampMillis) -> LookupResult {
        let digest = Self::token_digest(canister_id, token);
        let Some(value) = self.capabilities.get(&digest).cloned() else {
            self.prune_expired(now, MAX_EXPIRED_PRUNED_PER_CALL);
            return LookupResult::NotFound;
        };
        if value.expires_at <= now {
            self.remove(&digest);
            self.prune_expired(now, MAX_EXPIRED_PRUNED_PER_CALL);
            LookupResult::Expired
        } else if value.kind != CapabilityKind::PrivateMatch {
            LookupResult::WrongKind
        } else {
            LookupResult::Valid(Box::new(value))
        }
    }

    pub fn consume(&mut self, canister_id: CanisterId, token: &[u8]) -> bool {
        self.remove(&Self::token_digest(canister_id, token)).is_some()
    }

    /// Accounts only invalid redemption attempts. Callers presenting a real exact bearer bypass
    /// this bucket entirely, so anonymous/random misses can never lock out the registered app.
    pub fn record_invalid_redeem(&mut self, caller: CanisterId, now: TimestampMillis) -> Result<(), TimestampMillis> {
        let cutoff = now.saturating_sub(INVALID_REDEEM_WINDOW_MS);
        if !self.invalid_redeems_by_caller.contains_key(&caller)
            && self.invalid_redeems_by_caller.len() >= MAX_TRACKED_INVALID_REDEEM_CALLERS
        {
            let expired: Vec<_> = self
                .invalid_redeems_by_caller
                .iter()
                .filter(|(_, events)| events.back().is_none_or(|timestamp| *timestamp <= cutoff))
                .take(64)
                .map(|(caller, _)| *caller)
                .collect();
            for caller in expired {
                self.invalid_redeems_by_caller.remove(&caller);
            }
            if self.invalid_redeems_by_caller.len() >= MAX_TRACKED_INVALID_REDEEM_CALLERS {
                return Err(INVALID_REDEEM_WINDOW_MS);
            }
        }
        let events = self.invalid_redeems_by_caller.entry(caller).or_default();
        while events.front().is_some_and(|timestamp| *timestamp <= cutoff) {
            events.pop_front();
        }
        if events.len() >= MAX_INVALID_REDEEMS_PER_CALLER {
            let retry_after = events
                .front()
                .copied()
                .unwrap_or(now)
                .saturating_add(INVALID_REDEEM_WINDOW_MS)
                .saturating_sub(now);
            return Err(retry_after);
        }
        events.push_back(now);
        Ok(())
    }

    pub fn remove_user_app(&mut self, user_id: UserId, app_id: AiAppId) -> usize {
        let digests: Vec<_> = self
            .by_user
            .get(&user_id)
            .into_iter()
            .flat_map(|values| values.iter().copied())
            .filter(|digest| {
                self.capabilities
                    .get(digest)
                    .is_some_and(|value| value.context.app_id == app_id)
            })
            .take(MAX_OUTSTANDING_PER_USER)
            .collect();
        let mut removed = 0;
        for digest in digests {
            removed += usize::from(self.remove(&digest).is_some());
        }
        removed
    }

    pub fn remove_user(&mut self, user_id: UserId) -> usize {
        let digests: Vec<_> = self
            .by_user
            .get(&user_id)
            .into_iter()
            .flat_map(|values| values.iter().copied())
            .take(MAX_OUTSTANDING_PER_USER)
            .collect();
        let mut removed = 0;
        for digest in digests {
            removed += usize::from(self.remove(&digest).is_some());
        }
        self.issuance_by_user_app.retain(|(candidate, _), _| *candidate != user_id);
        self.issuance_global.retain(|(_, candidate, _)| *candidate != user_id);
        removed
    }

    pub fn remove_app(&mut self, app_id: AiAppId) -> usize {
        let digests: Vec<_> = self
            .by_app
            .get(&app_id)
            .into_iter()
            .flat_map(|values| values.iter().copied())
            .take(MAX_OUTSTANDING_PER_APP)
            .collect();
        let mut removed = 0;
        for digest in digests {
            removed += usize::from(self.remove(&digest).is_some());
        }
        removed
    }

    pub fn invalidate_all_bearers(&mut self) {
        self.capabilities.clear();
        self.by_user.clear();
        self.by_app.clear();
        self.by_expiry.clear();
    }

    pub fn prune_expired_bounded(&mut self, now: TimestampMillis) -> bool {
        self.prune_expired(now, MAX_EXPIRED_PRUNED_PER_CALL);
        self.by_expiry.first().is_some_and(|(expires_at, _)| *expires_at <= now)
    }

    fn remove(&mut self, digest: &TokenDigest) -> Option<PrivateMatchCapability> {
        let value = self.capabilities.remove(digest)?;
        self.by_expiry.remove(&(value.expires_at, *digest));
        remove_index(&mut self.by_user, value.context.user_id, digest);
        remove_index(&mut self.by_app, value.context.app_id, digest);
        Some(value)
    }

    fn prune_expired(&mut self, now: TimestampMillis, limit: usize) {
        let expired: Vec<_> = self
            .by_expiry
            .iter()
            .take_while(|(expires_at, _)| *expires_at <= now)
            .take(limit)
            .map(|(_, digest)| *digest)
            .collect();
        for digest in expired {
            self.remove(&digest);
        }
    }

    fn prune_issuance(&mut self, now: TimestampMillis) {
        let cutoff = now.saturating_sub(ISSUANCE_WINDOW_MS);
        while self
            .issuance_global
            .front()
            .is_some_and(|(timestamp, _, _)| *timestamp <= cutoff)
        {
            let (_, user_id, app_id) = self.issuance_global.pop_front().unwrap();
            let key = (user_id, app_id);
            let remove_key = self.issuance_by_user_app.get_mut(&key).is_some_and(|events| {
                while events.front().is_some_and(|timestamp| *timestamp <= cutoff) {
                    events.pop_front();
                }
                events.is_empty()
            });
            if remove_key {
                self.issuance_by_user_app.remove(&key);
            }
        }
    }
}

fn remove_index<K: Eq + std::hash::Hash + Copy>(index: &mut HashMap<K, HashSet<TokenDigest>>, key: K, digest: &TokenDigest) {
    if let Some(values) = index.get_mut(&key) {
        values.remove(digest);
        if values.is_empty() {
            index.remove(&key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use candid::Principal;
    use types::{Chat, MessageId};

    fn capability(user: u8, app_id: AiAppId, expires_at: TimestampMillis) -> PrivateMatchCapability {
        let user_id: UserId = Principal::from_slice(&[user]).into();
        PrivateMatchCapability {
            context: AiAppCardContext {
                user_id,
                chat: Chat::Group(Principal::from_slice(&[9]).into()),
                chat_key: "group:test".to_string(),
                thread_root_message_index: None,
                message_id: MessageId::from(7u64),
                app_id,
                app_revision: 2,
                action_id: "generic.action".to_string(),
            },
            source_binding: [4; 32],
            app_canister_id: Principal::from_slice(&[8]),
            recipient_key_scheme: "p256".to_string(),
            recipient_public_key: ByteBuf::from(vec![5; 33]),
            app_user_key_fingerprint: Some([6; 32]),
            app_user_key_version: Some(1),
            kind: CapabilityKind::PrivateMatch,
            expires_at,
        }
    }

    #[test]
    fn boxed_lookup_preserves_the_complete_value_and_persisted_state_until_exact_expiry() {
        let canister = Principal::from_slice(&[1]);
        let raw = [2; TOKEN_BYTES];
        for now in [19, 20, 21] {
            let expected = capability(3, 4, 20);
            let mut store = AiAppPrivateMatchTokens::default();
            store.insert(canister, &raw, expected.clone(), 1).unwrap();
            let persisted = msgpack::serialize_to_vec(&store).unwrap();
            if now == 19 {
                assert_eq!(
                    store.lookup(canister, &raw, now),
                    LookupResult::Valid(Box::new(expected.clone()))
                );
                assert_eq!(store.lookup(canister, &raw, now), LookupResult::Valid(Box::new(expected)));
                assert_eq!(msgpack::serialize_to_vec(&store).unwrap(), persisted);
                assert!(store.consume(canister, &raw));
            } else {
                assert_eq!(store.lookup(canister, &raw, now), LookupResult::Expired);
                assert!(!store.consume(canister, &raw));
            }
            assert_eq!(store.lookup(canister, &raw, now), LookupResult::NotFound);
        }
    }

    #[test]
    fn private_match_token_is_one_time_and_domain_separated_from_card_tokens() {
        let canister = Principal::from_slice(&[1]);
        let raw = [2; TOKEN_BYTES];
        let mut store = AiAppPrivateMatchTokens::default();
        store.insert(canister, &raw, capability(3, 4, 20), 1).unwrap();
        assert_ne!(
            AiAppPrivateMatchTokens::token_digest(canister, &raw),
            crate::model::ai_app_card_tokens::AiAppCardTokens::capability_digest(canister, &raw)
        );
        assert!(matches!(store.lookup(canister, &raw, 2), LookupResult::Valid(_)));
        assert!(store.consume(canister, &raw));
        assert_eq!(store.lookup(canister, &raw, 2), LookupResult::NotFound);
    }

    #[test]
    fn missing_or_wrong_internal_kind_fails_closed() {
        assert_eq!(CapabilityKind::default(), CapabilityKind::PrivateContext);
        let canister = Principal::from_slice(&[1]);
        let mut value = capability(3, 4, 20);
        value.kind = CapabilityKind::PrivateContext;
        assert_eq!(
            AiAppPrivateMatchTokens::default().insert(canister, &[2; TOKEN_BYTES], value, 1),
            Err(InsertError::WrongKind)
        );
    }

    #[test]
    fn private_match_has_its_own_small_user_quota_and_issuance_window() {
        let canister = Principal::from_slice(&[1]);
        let mut store = AiAppPrivateMatchTokens::default();
        for index in 0..MAX_OUTSTANDING_PER_USER {
            store
                .insert(canister, &(index as u64).to_be_bytes(), capability(3, 4, 20), 1)
                .unwrap();
        }
        assert_eq!(
            store.insert(canister, &[99; TOKEN_BYTES], capability(3, 4, 20), 1),
            Err(InsertError::UserLimitReached)
        );
        assert!(!store.prune_expired_bounded(20));
        assert!(
            store
                .insert(canister, &[100; TOKEN_BYTES], capability(3, 4, 80_001), 60_001)
                .is_ok()
        );
    }

    #[test]
    fn invalid_miss_throttle_never_blocks_lookup_of_a_real_bearer() {
        let canister = Principal::from_slice(&[1]);
        let caller = Principal::from_slice(&[8]);
        let raw = [2; TOKEN_BYTES];
        let mut store = AiAppPrivateMatchTokens::default();
        store.insert(canister, &raw, capability(3, 4, 20), 1).unwrap();
        for _ in 0..MAX_INVALID_REDEEMS_PER_CALLER {
            assert!(store.record_invalid_redeem(caller, 2).is_ok());
        }
        assert!(store.record_invalid_redeem(caller, 2).is_err());
        assert!(matches!(store.lookup(canister, &raw, 2), LookupResult::Valid(_)));
    }
}
