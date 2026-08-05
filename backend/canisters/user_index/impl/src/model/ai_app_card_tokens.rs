use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use types::{AiAppCardContext, AiAppId, CanisterId, TimestampMillis, UserId};

pub const TOKEN_BYTES: usize = 32;
pub const MIN_RECIPIENT_PUBLIC_KEY_BYTES: usize = 16;
pub const MAX_RECIPIENT_PUBLIC_KEY_BYTES: usize = 512;
pub const MAX_OUTSTANDING_PER_USER: usize = 32;
pub const MAX_OUTSTANDING_PER_APP: usize = 1_000;
pub const MAX_OUTSTANDING_PROVENANCES_PER_APP: usize = 500;
pub const MAX_OUTSTANDING_TOTAL: usize = 10_000;
const MAX_EXPIRED_PRUNED_PER_CALL: usize = 64;
const CAPABILITY_ISSUANCE_WINDOW_MS: TimestampMillis = 60_000;
const MAX_CAPABILITY_ISSUANCES_PER_USER_APP: usize = 30;
const MAX_CAPABILITY_ISSUANCES_GLOBAL: usize = 10_000;
const PROVENANCE_DOMAIN: &[u8] = b"openchat.ai-app-card-provenance.v1\0";
const CAPABILITY_DOMAIN: &[u8] = b"openchat.ai-app-card-capability.v1\0";
const CONFIRMATION_GRANT_DOMAIN: &[u8] = b"openchat.ai-app-card-confirmation-grant.v1\0";

pub type TokenDigest = [u8; 32];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Provenance {
    pub context: AiAppCardContext,
    /// Full canonical card commitment vouched by the exact registered app canister.
    #[serde(default)]
    pub content_hash: [u8; 32],
    pub expires_at: TimestampMillis,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Capability {
    pub context: AiAppCardContext,
    /// Exact full-card commitment that the registered app vouched before the message was stored.
    #[serde(default)]
    pub content_hash: [u8; 32],
    pub app_canister_id: CanisterId,
    pub recipient_key_scheme: String,
    pub recipient_public_key: ByteBuf,
    /// When the app uses per-user linking, redemption is valid only while the exact canonical
    /// OpenChat-side binding used at mint still exists. Removal or replacement invalidates it.
    #[serde(default)]
    pub app_user_key_fingerprint: Option<[u8; 32]>,
    /// Monotonic epoch for the canonical per-user key binding. This prevents removing and then
    /// re-adding the same key material from reviving a capability minted before revocation.
    #[serde(default)]
    pub app_user_key_version: Option<u64>,
    pub scope: types::AiAppCardCapabilityScope,
    pub expires_at: TimestampMillis,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ConfirmationGrant {
    pub context: AiAppCardContext,
    pub content_hash: [u8; 32],
    pub confirm_payload_hash: [u8; 32],
    pub app_canister_id: CanisterId,
    #[serde(default)]
    pub app_user_key_fingerprint: Option<[u8; 32]>,
    #[serde(default)]
    pub app_user_key_version: Option<u64>,
    pub expires_at: TimestampMillis,
}

#[derive(Debug, Eq, PartialEq)]
pub enum InsertError {
    UserLimitReached,
    AppLimitReached,
    StoreFull,
    IssuanceRateLimitReached,
    TokenCollision,
}

#[derive(Debug, Eq, PartialEq)]
pub enum ConsumeProvenanceResult {
    Valid,
    AlreadyValidated,
    Expired,
    NotFound,
    ContextMismatch,
}

#[derive(Debug, Eq, PartialEq)]
pub enum ProvenanceStatus {
    Active,
    AlreadyValidated,
    Expired,
    NotFound,
    ContextMismatch,
}

#[derive(Debug, Eq, PartialEq)]
pub enum LookupCapabilityResult {
    Valid(Capability),
    Expired,
    NotFound,
}

#[derive(Debug, Eq, PartialEq)]
pub enum LookupConfirmationGrantResult {
    Valid(ConfirmationGrant),
    Expired,
    NotFound,
}

/// Short-lived bearer material for generic app-rendered cards. Only domain-separated SHA-256
/// digests are persisted; raw provenance and capability tokens are returned exactly once.
#[derive(Serialize, Deserialize, Default)]
pub struct AiAppCardTokens {
    provenances: HashMap<TokenDigest, Provenance>,
    provenance_by_user: HashMap<UserId, HashSet<TokenDigest>>,
    provenance_by_expiry: BTreeSet<(TimestampMillis, TokenDigest)>,
    #[serde(default)]
    provenance_by_app: HashMap<AiAppId, HashSet<TokenDigest>>,
    /// Exact-context tombstones make callback failure and duplicate ingress retries idempotent
    /// without making the bearer reusable for a different card.
    #[serde(default)]
    consumed_provenances: HashMap<TokenDigest, Provenance>,
    #[serde(default)]
    consumed_provenance_by_user: HashMap<UserId, HashSet<TokenDigest>>,
    #[serde(default)]
    consumed_provenance_by_expiry: BTreeSet<(TimestampMillis, TokenDigest)>,
    #[serde(default)]
    consumed_provenance_by_app: HashMap<AiAppId, HashSet<TokenDigest>>,
    capabilities: HashMap<TokenDigest, Capability>,
    capability_by_user: HashMap<UserId, HashSet<TokenDigest>>,
    capability_by_app: HashMap<AiAppId, HashSet<TokenDigest>>,
    capability_by_expiry: BTreeSet<(TimestampMillis, TokenDigest)>,
    #[serde(default)]
    confirmation_grants: HashMap<TokenDigest, ConfirmationGrant>,
    #[serde(default)]
    confirmation_grant_by_user: HashMap<UserId, HashSet<TokenDigest>>,
    #[serde(default)]
    confirmation_grant_by_app: HashMap<AiAppId, HashSet<TokenDigest>>,
    #[serde(default)]
    confirmation_grant_by_expiry: BTreeSet<(TimestampMillis, TokenDigest)>,
    /// Counts successful mints, including capabilities immediately redeemed by the app. Outstanding
    /// token quotas alone do not bound mint/redeem cycling.
    #[serde(default)]
    capability_issuance_by_user_app: HashMap<(UserId, AiAppId), VecDeque<TimestampMillis>>,
    #[serde(default)]
    capability_issuance_global: VecDeque<(TimestampMillis, UserId, AiAppId)>,
}

impl AiAppCardTokens {
    /// Invalidates all active and consumed short-lived card bearers after a canister-version
    /// change. Successful capability issuance history is intentionally preserved so an upgrade or
    /// snapshot restore cannot reset anti-churn limits.
    pub fn invalidate_all_bearers(&mut self) {
        self.provenances.clear();
        self.provenance_by_user.clear();
        self.provenance_by_expiry.clear();
        self.provenance_by_app.clear();
        self.consumed_provenances.clear();
        self.consumed_provenance_by_user.clear();
        self.consumed_provenance_by_expiry.clear();
        self.consumed_provenance_by_app.clear();
        self.capabilities.clear();
        self.capability_by_user.clear();
        self.capability_by_app.clear();
        self.capability_by_expiry.clear();
        self.confirmation_grants.clear();
        self.confirmation_grant_by_user.clear();
        self.confirmation_grant_by_app.clear();
        self.confirmation_grant_by_expiry.clear();
    }

    pub fn provenance_digest(canister_id: CanisterId, token: &[u8]) -> TokenDigest {
        token_digest(PROVENANCE_DOMAIN, canister_id, token)
    }

    pub fn capability_digest(canister_id: CanisterId, token: &[u8]) -> TokenDigest {
        token_digest(CAPABILITY_DOMAIN, canister_id, token)
    }

    pub fn confirmation_grant_digest(canister_id: CanisterId, token: &[u8]) -> TokenDigest {
        token_digest(CONFIRMATION_GRANT_DOMAIN, canister_id, token)
    }

    pub fn insert_provenance(
        &mut self,
        canister_id: CanisterId,
        token: &[u8],
        provenance: Provenance,
        now: TimestampMillis,
    ) -> Result<(), InsertError> {
        self.ensure_provenance_app_indexes();
        self.prune_expired(now);
        self.prune_expired_provenance_for_user(provenance.context.user_id, now);
        if self.provenances.len() + self.consumed_provenances.len() >= MAX_OUTSTANDING_TOTAL {
            return Err(InsertError::StoreFull);
        }
        if self
            .provenance_by_user
            .get(&provenance.context.user_id)
            .map_or(0, HashSet::len)
            + self
                .consumed_provenance_by_user
                .get(&provenance.context.user_id)
                .map_or(0, HashSet::len)
            >= MAX_OUTSTANDING_PER_USER
        {
            return Err(InsertError::UserLimitReached);
        }
        if self.provenance_by_app.get(&provenance.context.app_id).map_or(0, HashSet::len)
            + self
                .consumed_provenance_by_app
                .get(&provenance.context.app_id)
                .map_or(0, HashSet::len)
            >= MAX_OUTSTANDING_PROVENANCES_PER_APP
        {
            return Err(InsertError::AppLimitReached);
        }
        let digest = Self::provenance_digest(canister_id, token);
        if self.provenances.contains_key(&digest) || self.consumed_provenances.contains_key(&digest) {
            return Err(InsertError::TokenCollision);
        }
        self.provenance_by_user
            .entry(provenance.context.user_id)
            .or_default()
            .insert(digest);
        self.provenance_by_expiry.insert((provenance.expires_at, digest));
        self.provenance_by_app
            .entry(provenance.context.app_id)
            .or_default()
            .insert(digest);
        self.provenances.insert(digest, provenance);
        Ok(())
    }

    pub fn consume_provenance(
        &mut self,
        canister_id: CanisterId,
        token: &[u8],
        expected: &AiAppCardContext,
        expected_content_hash: &[u8; 32],
        now: TimestampMillis,
    ) -> ConsumeProvenanceResult {
        let digest = Self::provenance_digest(canister_id, token);
        match self.provenance_status(canister_id, token, expected, expected_content_hash, now) {
            ProvenanceStatus::Active => {
                let value = self.remove_provenance(&digest).expect("active provenance disappeared");
                self.consumed_provenance_by_user
                    .entry(value.context.user_id)
                    .or_default()
                    .insert(digest);
                self.consumed_provenance_by_expiry.insert((value.expires_at, digest));
                self.consumed_provenance_by_app
                    .entry(value.context.app_id)
                    .or_default()
                    .insert(digest);
                self.consumed_provenances.insert(digest, value);
                ConsumeProvenanceResult::Valid
            }
            ProvenanceStatus::AlreadyValidated => ConsumeProvenanceResult::AlreadyValidated,
            ProvenanceStatus::Expired => ConsumeProvenanceResult::Expired,
            ProvenanceStatus::NotFound => ConsumeProvenanceResult::NotFound,
            ProvenanceStatus::ContextMismatch => ConsumeProvenanceResult::ContextMismatch,
        }
    }

    pub fn provenance_status(
        &mut self,
        canister_id: CanisterId,
        token: &[u8],
        expected: &AiAppCardContext,
        expected_content_hash: &[u8; 32],
        now: TimestampMillis,
    ) -> ProvenanceStatus {
        let digest = Self::provenance_digest(canister_id, token);
        if let Some(value) = self.provenances.get(&digest) {
            if value.expires_at <= now {
                self.remove_provenance(&digest);
                self.prune_expired(now);
                return ProvenanceStatus::Expired;
            }
            return if value.context == *expected && value.content_hash == *expected_content_hash {
                ProvenanceStatus::Active
            } else {
                ProvenanceStatus::ContextMismatch
            };
        }
        if let Some(value) = self.consumed_provenances.get(&digest) {
            if value.expires_at <= now {
                self.remove_consumed_provenance(&digest);
                self.prune_expired(now);
                return ProvenanceStatus::Expired;
            }
            return if value.context == *expected && value.content_hash == *expected_content_hash {
                ProvenanceStatus::AlreadyValidated
            } else {
                ProvenanceStatus::ContextMismatch
            };
        }
        self.prune_expired(now);
        ProvenanceStatus::NotFound
    }

    pub fn insert_capability(
        &mut self,
        canister_id: CanisterId,
        token: &[u8],
        capability: Capability,
        now: TimestampMillis,
    ) -> Result<(), InsertError> {
        self.prune_expired(now);
        self.prune_expired_capability_for_user(capability.context.user_id, now);
        self.prune_capability_issuance(now);
        let issuance_key = (capability.context.user_id, capability.context.app_id);
        if self
            .capability_issuance_by_user_app
            .get(&issuance_key)
            .map_or(0, VecDeque::len)
            >= MAX_CAPABILITY_ISSUANCES_PER_USER_APP
            || self.capability_issuance_global.len() >= MAX_CAPABILITY_ISSUANCES_GLOBAL
        {
            return Err(InsertError::IssuanceRateLimitReached);
        }
        if self.capabilities.len() >= MAX_OUTSTANDING_TOTAL {
            return Err(InsertError::StoreFull);
        }
        if self
            .capability_by_user
            .get(&capability.context.user_id)
            .map_or(0, HashSet::len)
            >= MAX_OUTSTANDING_PER_USER
        {
            return Err(InsertError::UserLimitReached);
        }
        if self.capability_by_app.get(&capability.context.app_id).map_or(0, HashSet::len) >= MAX_OUTSTANDING_PER_APP {
            return Err(InsertError::AppLimitReached);
        }
        let digest = Self::capability_digest(canister_id, token);
        if self.capabilities.contains_key(&digest) {
            return Err(InsertError::TokenCollision);
        }
        self.capability_by_user
            .entry(capability.context.user_id)
            .or_default()
            .insert(digest);
        self.capability_by_app
            .entry(capability.context.app_id)
            .or_default()
            .insert(digest);
        self.capability_by_expiry.insert((capability.expires_at, digest));
        self.capabilities.insert(digest, capability);
        self.capability_issuance_by_user_app
            .entry(issuance_key)
            .or_default()
            .push_back(now);
        self.capability_issuance_global
            .push_back((now, issuance_key.0, issuance_key.1));
        Ok(())
    }

    pub fn lookup_capability(&mut self, canister_id: CanisterId, token: &[u8], now: TimestampMillis) -> LookupCapabilityResult {
        let digest = Self::capability_digest(canister_id, token);
        let Some(value) = self.capabilities.get(&digest).cloned() else {
            self.prune_expired(now);
            return LookupCapabilityResult::NotFound;
        };
        if value.expires_at <= now {
            self.remove_capability(&digest);
            self.prune_expired(now);
            LookupCapabilityResult::Expired
        } else {
            LookupCapabilityResult::Valid(value)
        }
    }

    pub fn consume_capability(&mut self, canister_id: CanisterId, token: &[u8]) -> bool {
        self.remove_capability(&Self::capability_digest(canister_id, token)).is_some()
    }

    pub fn insert_confirmation_grant(
        &mut self,
        canister_id: CanisterId,
        token: &[u8],
        grant: ConfirmationGrant,
        now: TimestampMillis,
    ) -> Result<(), InsertError> {
        self.prune_expired(now);
        if self.confirmation_grants.len() >= MAX_OUTSTANDING_TOTAL {
            return Err(InsertError::StoreFull);
        }
        if self
            .confirmation_grant_by_user
            .get(&grant.context.user_id)
            .map_or(0, HashSet::len)
            >= MAX_OUTSTANDING_PER_USER
        {
            return Err(InsertError::UserLimitReached);
        }
        if self
            .confirmation_grant_by_app
            .get(&grant.context.app_id)
            .map_or(0, HashSet::len)
            >= MAX_OUTSTANDING_PER_APP
        {
            return Err(InsertError::AppLimitReached);
        }
        let digest = Self::confirmation_grant_digest(canister_id, token);
        if self.confirmation_grants.contains_key(&digest) {
            return Err(InsertError::TokenCollision);
        }
        self.confirmation_grant_by_user
            .entry(grant.context.user_id)
            .or_default()
            .insert(digest);
        self.confirmation_grant_by_app
            .entry(grant.context.app_id)
            .or_default()
            .insert(digest);
        self.confirmation_grant_by_expiry.insert((grant.expires_at, digest));
        self.confirmation_grants.insert(digest, grant);
        Ok(())
    }

    pub fn lookup_confirmation_grant(
        &mut self,
        canister_id: CanisterId,
        token: &[u8],
        now: TimestampMillis,
    ) -> LookupConfirmationGrantResult {
        let digest = Self::confirmation_grant_digest(canister_id, token);
        let Some(value) = self.confirmation_grants.get(&digest).cloned() else {
            self.prune_expired(now);
            return LookupConfirmationGrantResult::NotFound;
        };
        if value.expires_at <= now {
            self.remove_confirmation_grant(&digest);
            self.prune_expired(now);
            LookupConfirmationGrantResult::Expired
        } else {
            LookupConfirmationGrantResult::Valid(value)
        }
    }

    pub fn consume_confirmation_grant(&mut self, canister_id: CanisterId, token: &[u8]) -> bool {
        self.remove_confirmation_grant(&Self::confirmation_grant_digest(canister_id, token))
            .is_some()
    }

    /// Invalidates every outstanding private-context capability for one exact user/app tuple.
    /// Work is bounded by the per-user outstanding-token cap. Issuance history is retained so a
    /// disconnect/relink loop cannot reset the mint rate limit.
    pub fn remove_capabilities_for_user_app(&mut self, user_id: UserId, app_id: AiAppId) -> usize {
        let digests: Vec<_> = self
            .capability_by_user
            .get(&user_id)
            .into_iter()
            .flat_map(|digests| digests.iter().copied())
            .filter(|digest| {
                self.capabilities
                    .get(digest)
                    .is_some_and(|capability| capability.context.app_id == app_id)
            })
            .collect();
        let mut removed = 0;
        for digest in digests {
            removed += usize::from(self.remove_capability(&digest).is_some());
        }
        let grant_digests: Vec<_> = self
            .confirmation_grant_by_user
            .get(&user_id)
            .into_iter()
            .flat_map(|digests| digests.iter().copied())
            .filter(|digest| {
                self.confirmation_grants
                    .get(digest)
                    .is_some_and(|grant| grant.context.app_id == app_id)
            })
            .collect();
        for digest in grant_digests {
            removed += usize::from(self.remove_confirmation_grant(&digest).is_some());
        }
        removed
    }

    /// Invalidates all outstanding card authorization state for one permanently removed app id.
    ///
    /// Every collection is reached through its per-app index, so work is capped by the existing
    /// per-app quotas: active/consumed provenance records, capabilities, and confirmation grants.
    /// Capability issuance history is deliberately retained for its short anti-churn window; the
    /// periodic bounded pruner removes it after the window expires.
    pub fn remove_app(&mut self, app_id: AiAppId) -> usize {
        self.ensure_provenance_app_indexes();

        let provenance_digests: Vec<_> = self
            .provenance_by_app
            .get(&app_id)
            .into_iter()
            .flat_map(|digests| digests.iter().copied())
            .take(MAX_OUTSTANDING_PROVENANCES_PER_APP)
            .collect();
        let remaining_provenance_budget = MAX_OUTSTANDING_PROVENANCES_PER_APP.saturating_sub(provenance_digests.len());
        let consumed_provenance_digests: Vec<_> = self
            .consumed_provenance_by_app
            .get(&app_id)
            .into_iter()
            .flat_map(|digests| digests.iter().copied())
            .take(remaining_provenance_budget)
            .collect();
        let capability_digests: Vec<_> = self
            .capability_by_app
            .get(&app_id)
            .into_iter()
            .flat_map(|digests| digests.iter().copied())
            .take(MAX_OUTSTANDING_PER_APP)
            .collect();
        let confirmation_grant_digests: Vec<_> = self
            .confirmation_grant_by_app
            .get(&app_id)
            .into_iter()
            .flat_map(|digests| digests.iter().copied())
            .take(MAX_OUTSTANDING_PER_APP)
            .collect();

        let mut removed = 0;
        for digest in provenance_digests {
            removed += usize::from(self.remove_provenance(&digest).is_some());
        }
        for digest in consumed_provenance_digests {
            removed += usize::from(self.remove_consumed_provenance(&digest).is_some());
        }
        for digest in capability_digests {
            removed += usize::from(self.remove_capability(&digest).is_some());
        }
        for digest in confirmation_grant_digests {
            removed += usize::from(self.remove_confirmation_grant(&digest).is_some());
        }
        removed
    }

    fn prune_expired(&mut self, now: TimestampMillis) {
        let _ = self.prune_expired_bounded(now);
    }

    /// Removes a bounded amount of expired PR2-only bearer state even when no app or user sends
    /// traffic. Returns true while another immediate maintenance pass is required.
    pub fn prune_expired_bounded(&mut self, now: TimestampMillis) -> bool {
        for _ in 0..MAX_EXPIRED_PRUNED_PER_CALL {
            let Some((expires, digest)) = self.provenance_by_expiry.first().copied() else {
                break;
            };
            if expires > now {
                break;
            }
            self.remove_provenance(&digest);
        }
        for _ in 0..MAX_EXPIRED_PRUNED_PER_CALL {
            let Some((expires, digest)) = self.consumed_provenance_by_expiry.first().copied() else {
                break;
            };
            if expires > now {
                break;
            }
            self.remove_consumed_provenance(&digest);
        }
        for _ in 0..MAX_EXPIRED_PRUNED_PER_CALL {
            let Some((expires, digest)) = self.capability_by_expiry.first().copied() else {
                break;
            };
            if expires > now {
                break;
            }
            self.remove_capability(&digest);
        }
        for _ in 0..MAX_EXPIRED_PRUNED_PER_CALL {
            let Some((expires, digest)) = self.confirmation_grant_by_expiry.first().copied() else {
                break;
            };
            if expires > now {
                break;
            }
            self.remove_confirmation_grant(&digest);
        }

        self.prune_capability_issuance(now);

        self.provenance_by_expiry.first().is_some_and(|(expires, _)| *expires <= now)
            || self
                .consumed_provenance_by_expiry
                .first()
                .is_some_and(|(expires, _)| *expires <= now)
            || self.capability_by_expiry.first().is_some_and(|(expires, _)| *expires <= now)
            || self
                .confirmation_grant_by_expiry
                .first()
                .is_some_and(|(expires, _)| *expires <= now)
            || self
                .capability_issuance_global
                .front()
                .is_some_and(|(timestamp, _, _)| *timestamp <= now.saturating_sub(CAPABILITY_ISSUANCE_WINDOW_MS))
    }

    fn prune_capability_issuance(&mut self, now: TimestampMillis) {
        let cutoff = now.saturating_sub(CAPABILITY_ISSUANCE_WINDOW_MS);
        for _ in 0..MAX_EXPIRED_PRUNED_PER_CALL {
            if !self
                .capability_issuance_global
                .front()
                .is_some_and(|(timestamp, _, _)| *timestamp <= cutoff)
            {
                break;
            }
            let (timestamp, user_id, app_id) = self.capability_issuance_global.pop_front().unwrap();
            let key = (user_id, app_id);
            let empty = self.capability_issuance_by_user_app.get_mut(&key).is_some_and(|events| {
                if events.front() == Some(&timestamp) {
                    events.pop_front();
                } else if let Some(position) = events.iter().position(|candidate| *candidate == timestamp) {
                    events.remove(position);
                }
                events.is_empty()
            });
            if empty {
                self.capability_issuance_by_user_app.remove(&key);
            }
        }
    }

    fn ensure_provenance_app_indexes(&mut self) {
        if (!self.provenances.is_empty() || !self.consumed_provenances.is_empty())
            && self.provenance_by_app.is_empty()
            && self.consumed_provenance_by_app.is_empty()
        {
            for (digest, value) in &self.provenances {
                self.provenance_by_app
                    .entry(value.context.app_id)
                    .or_default()
                    .insert(*digest);
            }
            for (digest, value) in &self.consumed_provenances {
                self.consumed_provenance_by_app
                    .entry(value.context.app_id)
                    .or_default()
                    .insert(*digest);
            }
        }
    }

    fn prune_expired_provenance_for_user(&mut self, user_id: UserId, now: TimestampMillis) {
        let expired: Vec<_> = self
            .provenance_by_user
            .get(&user_id)
            .into_iter()
            .flat_map(|tokens| tokens.iter())
            .filter(|digest| self.provenances.get(*digest).is_some_and(|entry| entry.expires_at <= now))
            .copied()
            .collect();
        for digest in expired {
            self.remove_provenance(&digest);
        }
        let consumed_expired: Vec<_> = self
            .consumed_provenance_by_user
            .get(&user_id)
            .into_iter()
            .flat_map(|tokens| tokens.iter())
            .filter(|digest| {
                self.consumed_provenances
                    .get(*digest)
                    .is_some_and(|entry| entry.expires_at <= now)
            })
            .copied()
            .collect();
        for digest in consumed_expired {
            self.remove_consumed_provenance(&digest);
        }
    }

    fn prune_expired_capability_for_user(&mut self, user_id: UserId, now: TimestampMillis) {
        let expired: Vec<_> = self
            .capability_by_user
            .get(&user_id)
            .into_iter()
            .flat_map(|tokens| tokens.iter())
            .filter(|digest| self.capabilities.get(*digest).is_some_and(|entry| entry.expires_at <= now))
            .copied()
            .collect();
        for digest in expired {
            self.remove_capability(&digest);
        }
    }

    fn remove_provenance(&mut self, digest: &TokenDigest) -> Option<Provenance> {
        let value = self.provenances.remove(digest)?;
        self.provenance_by_expiry.remove(&(value.expires_at, *digest));
        let empty = self.provenance_by_user.get_mut(&value.context.user_id).is_some_and(|tokens| {
            tokens.remove(digest);
            tokens.is_empty()
        });
        if empty {
            self.provenance_by_user.remove(&value.context.user_id);
        }
        let app_empty = self.provenance_by_app.get_mut(&value.context.app_id).is_some_and(|tokens| {
            tokens.remove(digest);
            tokens.is_empty()
        });
        if app_empty {
            self.provenance_by_app.remove(&value.context.app_id);
        }
        Some(value)
    }

    fn remove_consumed_provenance(&mut self, digest: &TokenDigest) -> Option<Provenance> {
        let value = self.consumed_provenances.remove(digest)?;
        self.consumed_provenance_by_expiry.remove(&(value.expires_at, *digest));
        let empty = self
            .consumed_provenance_by_user
            .get_mut(&value.context.user_id)
            .is_some_and(|tokens| {
                tokens.remove(digest);
                tokens.is_empty()
            });
        if empty {
            self.consumed_provenance_by_user.remove(&value.context.user_id);
        }
        let app_empty = self
            .consumed_provenance_by_app
            .get_mut(&value.context.app_id)
            .is_some_and(|tokens| {
                tokens.remove(digest);
                tokens.is_empty()
            });
        if app_empty {
            self.consumed_provenance_by_app.remove(&value.context.app_id);
        }
        Some(value)
    }

    fn remove_capability(&mut self, digest: &TokenDigest) -> Option<Capability> {
        let value = self.capabilities.remove(digest)?;
        self.capability_by_expiry.remove(&(value.expires_at, *digest));
        let user_empty = self.capability_by_user.get_mut(&value.context.user_id).is_some_and(|tokens| {
            tokens.remove(digest);
            tokens.is_empty()
        });
        if user_empty {
            self.capability_by_user.remove(&value.context.user_id);
        }
        let app_empty = self.capability_by_app.get_mut(&value.context.app_id).is_some_and(|tokens| {
            tokens.remove(digest);
            tokens.is_empty()
        });
        if app_empty {
            self.capability_by_app.remove(&value.context.app_id);
        }
        Some(value)
    }

    fn remove_confirmation_grant(&mut self, digest: &TokenDigest) -> Option<ConfirmationGrant> {
        let value = self.confirmation_grants.remove(digest)?;
        self.confirmation_grant_by_expiry.remove(&(value.expires_at, *digest));
        let user_empty = self
            .confirmation_grant_by_user
            .get_mut(&value.context.user_id)
            .is_some_and(|tokens| {
                tokens.remove(digest);
                tokens.is_empty()
            });
        if user_empty {
            self.confirmation_grant_by_user.remove(&value.context.user_id);
        }
        let app_empty = self
            .confirmation_grant_by_app
            .get_mut(&value.context.app_id)
            .is_some_and(|tokens| {
                tokens.remove(digest);
                tokens.is_empty()
            });
        if app_empty {
            self.confirmation_grant_by_app.remove(&value.context.app_id);
        }
        Some(value)
    }
}

fn token_digest(domain: &[u8], canister_id: CanisterId, token: &[u8]) -> TokenDigest {
    let mut input = Vec::with_capacity(domain.len() + canister_id.as_slice().len() + token.len());
    input.extend_from_slice(domain);
    input.extend_from_slice(canister_id.as_slice());
    input.extend_from_slice(token);
    sha256::sha256(&input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use candid::Principal;
    use types::{Chat, ChatId, MessageId};

    #[derive(Serialize)]
    struct LegacyCapability {
        context: AiAppCardContext,
        app_canister_id: CanisterId,
        recipient_key_scheme: String,
        recipient_public_key: ByteBuf,
        scope: types::AiAppCardCapabilityScope,
        expires_at: TimestampMillis,
    }

    fn context(user_byte: u8, app_id: AiAppId) -> AiAppCardContext {
        let user_id: UserId = Principal::from_slice(&[user_byte]).into();
        let group: ChatId = Principal::from_slice(&[9]).into();
        AiAppCardContext {
            user_id,
            chat: Chat::Group(group),
            chat_key: format!("group:{group}"),
            thread_root_message_index: None,
            message_id: MessageId::from(44u64),
            app_id,
            app_revision: 7,
            action_id: "generic.action".to_string(),
        }
    }

    fn confirmation_grant(user_byte: u8, app_id: AiAppId, expires_at: TimestampMillis) -> ConfirmationGrant {
        ConfirmationGrant {
            context: context(user_byte, app_id),
            content_hash: [6; 32],
            confirm_payload_hash: [7; 32],
            app_canister_id: Principal::from_slice(&[88]),
            app_user_key_fingerprint: Some([8; 32]),
            app_user_key_version: Some(1),
            expires_at,
        }
    }

    fn seed_all_card_state(store: &mut AiAppCardTokens, canister: CanisterId, app_id: AiAppId, seed: u8) {
        let provenance = Provenance {
            context: context(1, app_id),
            content_hash: [app_id as u8; 32],
            expires_at: 100,
        };
        store
            .insert_provenance(canister, &[seed; TOKEN_BYTES], provenance.clone(), 1)
            .unwrap();
        store
            .insert_provenance(canister, &[seed + 1; TOKEN_BYTES], provenance.clone(), 1)
            .unwrap();
        assert_eq!(
            store.consume_provenance(
                canister,
                &[seed + 1; TOKEN_BYTES],
                &provenance.context,
                &provenance.content_hash,
                2,
            ),
            ConsumeProvenanceResult::Valid
        );
        store
            .insert_capability(
                canister,
                &[seed + 2; TOKEN_BYTES],
                Capability {
                    context: context(1, app_id),
                    content_hash: [app_id as u8; 32],
                    app_canister_id: Principal::from_slice(&[88]),
                    recipient_key_scheme: "opaque-v1".to_string(),
                    recipient_public_key: ByteBuf::from(vec![5; 48]),
                    app_user_key_fingerprint: None,
                    app_user_key_version: None,
                    scope: types::AiAppCardCapabilityScope::PrivateContext,
                    expires_at: 100,
                },
                1,
            )
            .unwrap();
        store
            .insert_confirmation_grant(canister, &[seed + 3; TOKEN_BYTES], confirmation_grant(1, app_id, 100), 1)
            .unwrap();
    }

    #[test]
    fn raw_tokens_are_not_serialized_and_domains_are_distinct() {
        let canister = Principal::from_slice(&[77]);
        let raw = vec![0xA5; TOKEN_BYTES];
        assert_ne!(
            AiAppCardTokens::provenance_digest(canister, &raw),
            AiAppCardTokens::capability_digest(canister, &raw)
        );
        assert_ne!(
            AiAppCardTokens::capability_digest(canister, &raw),
            AiAppCardTokens::capability_digest(Principal::from_slice(&[78]), &raw)
        );
        let mut store = AiAppCardTokens::default();
        store
            .insert_provenance(
                canister,
                &raw,
                Provenance {
                    context: context(1, 2),
                    content_hash: [1; 32],
                    expires_at: 100,
                },
                1,
            )
            .unwrap();
        let encoded = msgpack::serialize_to_vec(&store).unwrap();
        assert!(!encoded.windows(raw.len()).any(|window| window == raw));
    }

    #[test]
    fn provenance_is_exact_context_idempotent_and_mismatch_does_not_consume() {
        let canister = Principal::from_slice(&[77]);
        let raw = vec![3; TOKEN_BYTES];
        let expected = context(1, 2);
        let mut store = AiAppCardTokens::default();
        store
            .insert_provenance(
                canister,
                &raw,
                Provenance {
                    context: expected.clone(),
                    content_hash: [1; 32],
                    expires_at: 100,
                },
                1,
            )
            .unwrap();
        let mut spoofed = expected.clone();
        spoofed.message_id = MessageId::from(45u64);
        assert_eq!(
            store.consume_provenance(canister, &raw, &spoofed, &[1; 32], 2),
            ConsumeProvenanceResult::ContextMismatch
        );
        assert_eq!(
            store.consume_provenance(canister, &raw, &expected, &[9; 32], 2),
            ConsumeProvenanceResult::ContextMismatch
        );
        assert_eq!(
            store.consume_provenance(canister, &raw, &expected, &[1; 32], 2),
            ConsumeProvenanceResult::Valid
        );
        assert_eq!(
            store.consume_provenance(canister, &raw, &expected, &[1; 32], 2),
            ConsumeProvenanceResult::AlreadyValidated
        );
        let mut wrong_thread = expected.clone();
        wrong_thread.thread_root_message_index = Some(1.into());
        assert_eq!(
            store.consume_provenance(canister, &raw, &wrong_thread, &[1; 32], 2),
            ConsumeProvenanceResult::ContextMismatch
        );
        assert_eq!(
            store.consume_provenance(canister, &raw, &expected, &[1; 32], 100),
            ConsumeProvenanceResult::Expired
        );
        assert_eq!(
            store.consume_provenance(canister, &raw, &expected, &[1; 32], 101),
            ConsumeProvenanceResult::NotFound
        );
    }

    #[test]
    fn wrong_recipient_can_be_rejected_without_consuming_capability() {
        let canister = Principal::from_slice(&[77]);
        let raw = vec![4; TOKEN_BYTES];
        let capability = Capability {
            context: context(1, 2),
            content_hash: [6; 32],
            app_canister_id: Principal::from_slice(&[88]),
            recipient_key_scheme: "opaque-v1".to_string(),
            recipient_public_key: ByteBuf::from(vec![5; 48]),
            app_user_key_fingerprint: None,
            app_user_key_version: None,
            scope: types::AiAppCardCapabilityScope::PrivateContext,
            expires_at: 100,
        };
        let mut store = AiAppCardTokens::default();
        store.insert_capability(canister, &raw, capability.clone(), 1).unwrap();
        assert_eq!(
            store.lookup_capability(canister, &raw, 2),
            LookupCapabilityResult::Valid(capability.clone())
        );
        assert_eq!(
            store.lookup_capability(canister, &raw, 2),
            LookupCapabilityResult::Valid(capability)
        );
        assert!(store.consume_capability(canister, &raw));
        assert_eq!(store.lookup_capability(canister, &raw, 2), LookupCapabilityResult::NotFound);
    }

    #[test]
    fn confirmation_grant_is_one_time_and_a_wrong_binding_check_does_not_burn_it() {
        let canister = Principal::from_slice(&[77]);
        let raw = vec![9; TOKEN_BYTES];
        let grant = confirmation_grant(1, 2, 100);
        let mut store = AiAppCardTokens::default();
        store.insert_confirmation_grant(canister, &raw, grant.clone(), 1).unwrap();

        let looked_up = match store.lookup_confirmation_grant(canister, &raw, 2) {
            LookupConfirmationGrantResult::Valid(value) => value,
            other => panic!("expected a live grant, got {other:?}"),
        };
        assert_ne!(looked_up.confirm_payload_hash, [0; 32]);
        assert_eq!(
            store.lookup_confirmation_grant(canister, &raw, 2),
            LookupConfirmationGrantResult::Valid(grant),
            "checking a mismatched binding must not consume the bearer"
        );
        assert!(store.consume_confirmation_grant(canister, &raw));
        assert!(!store.consume_confirmation_grant(canister, &raw));
        assert_eq!(
            store.lookup_confirmation_grant(canister, &raw, 2),
            LookupConfirmationGrantResult::NotFound
        );
    }

    #[test]
    fn expired_confirmation_grant_is_removed_and_cannot_be_consumed() {
        let canister = Principal::from_slice(&[77]);
        let raw = vec![10; TOKEN_BYTES];
        let mut store = AiAppCardTokens::default();
        store
            .insert_confirmation_grant(canister, &raw, confirmation_grant(1, 2, 10), 1)
            .unwrap();
        assert_eq!(
            store.lookup_confirmation_grant(canister, &raw, 10),
            LookupConfirmationGrantResult::Expired
        );
        assert!(!store.consume_confirmation_grant(canister, &raw));
    }

    #[test]
    fn exact_user_app_revocation_removes_only_matching_confirmation_grants() {
        let canister = Principal::from_slice(&[77]);
        let mut store = AiAppCardTokens::default();
        store
            .insert_confirmation_grant(canister, &[11; TOKEN_BYTES], confirmation_grant(1, 2, 100), 1)
            .unwrap();
        store
            .insert_confirmation_grant(canister, &[12; TOKEN_BYTES], confirmation_grant(1, 3, 100), 1)
            .unwrap();
        store
            .insert_confirmation_grant(canister, &[13; TOKEN_BYTES], confirmation_grant(2, 2, 100), 1)
            .unwrap();

        assert_eq!(
            store.remove_capabilities_for_user_app(Principal::from_slice(&[1]).into(), 2),
            1
        );
        assert_eq!(
            store.lookup_confirmation_grant(canister, &[11; TOKEN_BYTES], 2),
            LookupConfirmationGrantResult::NotFound
        );
        assert!(matches!(
            store.lookup_confirmation_grant(canister, &[12; TOKEN_BYTES], 2),
            LookupConfirmationGrantResult::Valid(_)
        ));
        assert!(matches!(
            store.lookup_confirmation_grant(canister, &[13; TOKEN_BYTES], 2),
            LookupConfirmationGrantResult::Valid(_)
        ));
    }

    #[test]
    fn mint_redeem_cycling_is_bounded_by_success_inclusive_user_app_window() {
        let canister = Principal::from_slice(&[77]);
        let capability = Capability {
            context: context(1, 2),
            content_hash: [6; 32],
            app_canister_id: Principal::from_slice(&[88]),
            recipient_key_scheme: "opaque-v1".to_string(),
            recipient_public_key: ByteBuf::from(vec![5; 48]),
            app_user_key_fingerprint: None,
            app_user_key_version: None,
            scope: types::AiAppCardCapabilityScope::PrivateContext,
            expires_at: CAPABILITY_ISSUANCE_WINDOW_MS + 10_000,
        };
        let mut store = AiAppCardTokens::default();
        for seed in 0..MAX_CAPABILITY_ISSUANCES_PER_USER_APP {
            let mut raw = vec![0; TOKEN_BYTES];
            raw[..8].copy_from_slice(&(seed as u64).to_le_bytes());
            store.insert_capability(canister, &raw, capability.clone(), 1).unwrap();
            assert!(store.consume_capability(canister, &raw));
        }
        let mut blocked = vec![0; TOKEN_BYTES];
        blocked[..8].copy_from_slice(&u64::MAX.to_le_bytes());
        assert_eq!(
            store.insert_capability(canister, &blocked, capability.clone(), 1),
            Err(InsertError::IssuanceRateLimitReached)
        );
        assert_eq!(
            store.insert_capability(canister, &blocked, capability, CAPABILITY_ISSUANCE_WINDOW_MS + 2),
            Ok(())
        );
    }

    #[test]
    fn legacy_capability_deserializes_without_a_key_fingerprint_for_fail_closed_redeem() {
        let legacy = LegacyCapability {
            context: context(1, 2),
            app_canister_id: Principal::from_slice(&[88]),
            recipient_key_scheme: "opaque-v1".to_string(),
            recipient_public_key: ByteBuf::from(vec![5; 48]),
            scope: types::AiAppCardCapabilityScope::PrivateContext,
            expires_at: 100,
        };
        let restored: Capability = msgpack::deserialize_then_unwrap(&msgpack::serialize_to_vec(&legacy).unwrap());
        assert_eq!(restored.app_user_key_fingerprint, None);
        assert_eq!(restored.app_user_key_version, None);
    }

    #[test]
    fn exact_user_app_capability_invalidation_preserves_other_accounts_and_apps() {
        let canister = Principal::from_slice(&[77]);
        let user_a_app_2 = Capability {
            context: context(1, 2),
            content_hash: [6; 32],
            app_canister_id: Principal::from_slice(&[88]),
            recipient_key_scheme: "opaque-v1".to_string(),
            recipient_public_key: ByteBuf::from(vec![5; 48]),
            app_user_key_fingerprint: Some([2; 32]),
            app_user_key_version: Some(1),
            scope: types::AiAppCardCapabilityScope::PrivateContext,
            expires_at: 100,
        };
        let mut user_a_app_3 = user_a_app_2.clone();
        user_a_app_3.context.app_id = 3;
        let mut user_b_app_2 = user_a_app_2.clone();
        user_b_app_2.context.user_id = Principal::from_slice(&[2]).into();
        let mut store = AiAppCardTokens::default();
        store.insert_capability(canister, &[1; TOKEN_BYTES], user_a_app_2, 1).unwrap();
        store.insert_capability(canister, &[2; TOKEN_BYTES], user_a_app_3, 1).unwrap();
        store.insert_capability(canister, &[3; TOKEN_BYTES], user_b_app_2, 1).unwrap();

        assert_eq!(
            store.remove_capabilities_for_user_app(Principal::from_slice(&[1]).into(), 2),
            1
        );
        assert_eq!(
            store.lookup_capability(canister, &[1; TOKEN_BYTES], 2),
            LookupCapabilityResult::NotFound
        );
        assert!(matches!(
            store.lookup_capability(canister, &[2; TOKEN_BYTES], 2),
            LookupCapabilityResult::Valid(_)
        ));
        assert!(matches!(
            store.lookup_capability(canister, &[3; TOKEN_BYTES], 2),
            LookupCapabilityResult::Valid(_)
        ));
    }

    #[test]
    fn exact_app_removal_revokes_all_card_state_and_preserves_other_apps() {
        let canister = Principal::from_slice(&[77]);
        let mut store = AiAppCardTokens::default();
        seed_all_card_state(&mut store, canister, 2, 40);
        seed_all_card_state(&mut store, canister, 3, 50);
        assert_eq!(store.remove_app(2), 4);
        assert_eq!(store.remove_app(2), 0);
        let removed = context(1, 2);
        assert_eq!(
            store.provenance_status(canister, &[40; TOKEN_BYTES], &removed, &[2; 32], 2),
            ProvenanceStatus::NotFound
        );
        assert_eq!(
            store.provenance_status(canister, &[41; TOKEN_BYTES], &removed, &[2; 32], 2),
            ProvenanceStatus::NotFound
        );
        assert_eq!(
            store.lookup_capability(canister, &[42; TOKEN_BYTES], 2),
            LookupCapabilityResult::NotFound
        );
        assert_eq!(
            store.lookup_confirmation_grant(canister, &[43; TOKEN_BYTES], 2),
            LookupConfirmationGrantResult::NotFound
        );
        let retained = context(1, 3);
        assert_eq!(
            store.provenance_status(canister, &[50; TOKEN_BYTES], &retained, &[3; 32], 2),
            ProvenanceStatus::Active
        );
        assert_eq!(
            store.provenance_status(canister, &[51; TOKEN_BYTES], &retained, &[3; 32], 2),
            ProvenanceStatus::AlreadyValidated
        );
        assert!(matches!(
            store.lookup_capability(canister, &[52; TOKEN_BYTES], 2),
            LookupCapabilityResult::Valid(_)
        ));
        assert!(matches!(
            store.lookup_confirmation_grant(canister, &[53; TOKEN_BYTES], 2),
            LookupConfirmationGrantResult::Valid(_)
        ));
    }

    #[test]
    fn current_schema_round_trip_preserves_card_state_and_issuance_window() {
        let canister = Principal::from_slice(&[77]);
        let mut store = AiAppCardTokens::default();
        seed_all_card_state(&mut store, canister, 2, 40);
        let mut capability = store.capabilities.values().next().unwrap().clone();
        capability.expires_at = CAPABILITY_ISSUANCE_WINDOW_MS + 10_000;
        for seed in 0..(MAX_CAPABILITY_ISSUANCES_PER_USER_APP - 1) {
            let mut token = [0; TOKEN_BYTES];
            token[..8].copy_from_slice(&(seed as u64).to_le_bytes());
            store.insert_capability(canister, &token, capability.clone(), 1).unwrap();
            assert!(store.consume_capability(canister, &token));
        }
        let encoded = msgpack::serialize_to_vec(&store).unwrap();
        let mut restored: AiAppCardTokens = msgpack::deserialize_then_unwrap(&encoded);
        let expected = context(1, 2);
        assert_eq!(
            restored.provenance_status(canister, &[40; TOKEN_BYTES], &expected, &[2; 32], 2),
            ProvenanceStatus::Active
        );
        assert_eq!(
            restored.provenance_status(canister, &[41; TOKEN_BYTES], &expected, &[2; 32], 2),
            ProvenanceStatus::AlreadyValidated
        );
        assert!(matches!(
            restored.lookup_capability(canister, &[42; TOKEN_BYTES], 2),
            LookupCapabilityResult::Valid(_)
        ));
        assert!(matches!(
            restored.lookup_confirmation_grant(canister, &[43; TOKEN_BYTES], 2),
            LookupConfirmationGrantResult::Valid(_)
        ));
        let blocked = [0xFE; TOKEN_BYTES];
        assert_eq!(
            restored.insert_capability(canister, &blocked, capability.clone(), 2),
            Err(InsertError::IssuanceRateLimitReached)
        );
        assert_eq!(
            restored.insert_capability(canister, &blocked, capability, CAPABILITY_ISSUANCE_WINDOW_MS + 2,),
            Ok(())
        );
    }

    #[test]
    fn periodic_maintenance_removes_expired_private_state_without_new_traffic() {
        let canister = Principal::from_slice(&[77]);
        let mut store = AiAppCardTokens::default();
        store
            .insert_provenance(
                canister,
                &[21; TOKEN_BYTES],
                Provenance {
                    context: context(1, 2),
                    content_hash: [2; 32],
                    expires_at: 10,
                },
                1,
            )
            .unwrap();
        store
            .insert_capability(
                canister,
                &[22; TOKEN_BYTES],
                Capability {
                    context: context(1, 2),
                    content_hash: [6; 32],
                    app_canister_id: Principal::from_slice(&[88]),
                    recipient_key_scheme: "opaque-v1".to_string(),
                    recipient_public_key: ByteBuf::from(vec![5; 48]),
                    app_user_key_fingerprint: Some([8; 32]),
                    app_user_key_version: Some(1),
                    scope: types::AiAppCardCapabilityScope::PrivateContext,
                    expires_at: 10,
                },
                1,
            )
            .unwrap();
        store
            .insert_confirmation_grant(canister, &[23; TOKEN_BYTES], confirmation_grant(1, 2, 10), 1)
            .unwrap();

        assert!(!store.prune_expired_bounded(10));
        assert!(store.provenances.is_empty());
        assert!(store.capabilities.is_empty());
        assert!(store.confirmation_grants.is_empty());
        assert!(store.provenance_by_expiry.is_empty());
        assert!(store.capability_by_expiry.is_empty());
        assert!(store.confirmation_grant_by_expiry.is_empty());
    }

    #[test]
    fn periodic_maintenance_is_bounded_and_reports_more_work() {
        let canister = Principal::from_slice(&[77]);
        let mut store = AiAppCardTokens::default();
        for seed in 0..=MAX_EXPIRED_PRUNED_PER_CALL {
            let mut raw = [0; TOKEN_BYTES];
            raw[..8].copy_from_slice(&(seed as u64).to_le_bytes());
            store
                .insert_provenance(
                    canister,
                    &raw,
                    Provenance {
                        context: context(1 + (seed / MAX_OUTSTANDING_PER_USER) as u8, 2),
                        content_hash: [2; 32],
                        expires_at: 10,
                    },
                    1,
                )
                .unwrap();
        }

        assert!(store.prune_expired_bounded(10));
        assert_eq!(store.provenances.len(), 1);
        assert!(!store.prune_expired_bounded(10));
        assert!(store.provenances.is_empty());
    }

    #[test]
    fn many_users_cannot_exhaust_global_provenance_capacity_through_one_app() {
        let canister = Principal::from_slice(&[77]);
        let mut store = AiAppCardTokens::default();
        for seed in 0..MAX_OUTSTANDING_PROVENANCES_PER_APP {
            let mut raw = vec![0; TOKEN_BYTES];
            raw[..8].copy_from_slice(&(seed as u64).to_le_bytes());
            let user_byte = 1 + (seed / MAX_OUTSTANDING_PER_USER) as u8;
            store
                .insert_provenance(
                    canister,
                    &raw,
                    Provenance {
                        context: context(user_byte, 2),
                        content_hash: [2; 32],
                        expires_at: 100,
                    },
                    1,
                )
                .unwrap();
        }
        let blocked = vec![0xEE; TOKEN_BYTES];
        assert_eq!(
            store.insert_provenance(
                canister,
                &blocked,
                Provenance {
                    context: context(99, 2),
                    content_hash: [2; 32],
                    expires_at: 100,
                },
                1,
            ),
            Err(InsertError::AppLimitReached)
        );
        assert_eq!(
            store.insert_provenance(
                canister,
                &blocked,
                Provenance {
                    context: context(99, 3),
                    content_hash: [3; 32],
                    expires_at: 100,
                },
                1,
            ),
            Ok(())
        );
    }

    #[test]
    fn canister_version_invalidation_revokes_all_bearers_but_preserves_issuance_history() {
        let canister = Principal::from_slice(&[77]);
        let mut store = AiAppCardTokens::default();
        seed_all_card_state(&mut store, canister, 2, 40);
        let expected = context(1, 2);
        let mut capability = store.capabilities.values().next().unwrap().clone();
        capability.expires_at = CAPABILITY_ISSUANCE_WINDOW_MS + 100;

        // The seeded active capability is the first successful issuance. Fill the remainder of the
        // exact user/app window, consuming each token so outstanding-token quotas cannot explain
        // the later rejection.
        for seed in 0..(MAX_CAPABILITY_ISSUANCES_PER_USER_APP - 1) {
            let mut token = [0; TOKEN_BYTES];
            token[..8].copy_from_slice(&(seed as u64).to_le_bytes());
            store.insert_capability(canister, &token, capability.clone(), 1).unwrap();
            assert!(store.consume_capability(canister, &token));
        }

        store.invalidate_all_bearers();

        assert_eq!(
            store.provenance_status(canister, &[40; TOKEN_BYTES], &expected, &[2; 32], 2),
            ProvenanceStatus::NotFound
        );
        assert_eq!(
            store.provenance_status(canister, &[41; TOKEN_BYTES], &expected, &[2; 32], 2),
            ProvenanceStatus::NotFound
        );
        assert!(matches!(
            store.lookup_capability(canister, &[42; TOKEN_BYTES], 2),
            LookupCapabilityResult::NotFound
        ));
        assert!(matches!(
            store.lookup_confirmation_grant(canister, &[43; TOKEN_BYTES], 2),
            LookupConfirmationGrantResult::NotFound
        ));
        assert_eq!(
            store.insert_capability(canister, &[0xFE; TOKEN_BYTES], capability.clone(), 2),
            Err(InsertError::IssuanceRateLimitReached)
        );
        assert_eq!(
            store.insert_capability(canister, &[0xFD; TOKEN_BYTES], capability, CAPABILITY_ISSUANCE_WINDOW_MS + 2,),
            Ok(())
        );
    }
}
