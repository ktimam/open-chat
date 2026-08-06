use candid::Principal;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};
use types::{AiAppId, CanisterId, Chat, TimestampMillis, UserId};

pub const TOKEN_BYTES: usize = 32;
pub const MAX_OUTSTANDING_PER_USER: usize = 20;
pub const MAX_OUTSTANDING_PER_APP: usize = 1_000;
pub const MAX_OUTSTANDING: usize = 10_000;
pub const MAX_REDEEMED_RECEIPTS: usize = 10_000;
pub const MAX_RECEIPTS_PER_USER: usize = 100;
pub const MAX_RECEIPTS_PER_APP: usize = 2_000;
pub const RECEIPT_RECOVERY_WINDOW_MS: TimestampMillis = 60 * 60 * 1_000;
pub const ISSUANCE_WINDOW_MS: TimestampMillis = 10 * 60 * 1_000;
pub const MAX_ISSUED_PER_USER_APP_WINDOW: u16 = 20;
const MAX_EXPIRED_PRUNED_PER_CALL: usize = 64;
const DIGEST_VERSION: u8 = 1;
const TOKEN_DIGEST_DOMAIN: &[u8] = b"openchat.ai-app-chat-link-token.v1\0";

pub type TokenDigest = [u8; 32];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct AiAppChatLinkToken {
    pub user_id: UserId,
    pub chat: Chat,
    pub app_id: AiAppId,
    pub app_revision: TimestampMillis,
    pub app_canister_id: CanisterId,
    /// The exact LUI that relayed this mint. Legacy in-flight entries deserialize fail-closed for
    /// issuer cancellation while remaining redeemable until their short TTL.
    #[serde(default = "anonymous_canister_id")]
    pub issuer_local_user_index_canister_id: CanisterId,
    pub app_user_key_fingerprint: [u8; 32],
    pub app_user_key_version: u64,
    pub app_subject: [u8; 32],
    pub chat_handle: [u8; 32],
    pub expires_at: TimestampMillis,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
struct IssuanceWindow {
    started_at: TimestampMillis,
    count: u16,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
struct RedeemedReceipt {
    token: AiAppChatLinkToken,
    replay_until: TimestampMillis,
}

#[derive(Serialize, Deserialize)]
pub struct AiAppChatLinkTokens {
    /// Only canister-bound, domain-separated digests are persisted; raw URL bearers never are.
    #[serde(default)]
    tokens: HashMap<TokenDigest, AiAppChatLinkToken>,
    #[serde(default)]
    by_user: HashMap<UserId, HashSet<TokenDigest>>,
    #[serde(default)]
    by_app: HashMap<AiAppId, HashSet<TokenDigest>>,
    #[serde(default)]
    by_expiry: BTreeSet<(TimestampMillis, TokenDigest)>,
    /// Completed redemptions retained through a bounded post-commit recovery window.
    #[serde(default)]
    redeemed_receipts: HashMap<TokenDigest, RedeemedReceipt>,
    #[serde(default)]
    receipts_by_expiry: BTreeSet<(TimestampMillis, TokenDigest)>,
    #[serde(default)]
    receipts_by_user: HashMap<UserId, HashSet<TokenDigest>>,
    #[serde(default)]
    receipts_by_app: HashMap<AiAppId, HashSet<TokenDigest>>,
    #[serde(default)]
    issuance_windows: HashMap<(UserId, AiAppId), IssuanceWindow>,
    /// A zero value denotes a pre-feature or incompatible snapshot and is invalidated fail-closed.
    #[serde(default)]
    digest_version: u8,
}

impl Default for AiAppChatLinkTokens {
    fn default() -> Self {
        Self {
            tokens: HashMap::new(),
            by_user: HashMap::new(),
            by_app: HashMap::new(),
            by_expiry: BTreeSet::new(),
            redeemed_receipts: HashMap::new(),
            receipts_by_expiry: BTreeSet::new(),
            receipts_by_user: HashMap::new(),
            receipts_by_app: HashMap::new(),
            issuance_windows: HashMap::new(),
            digest_version: DIGEST_VERSION,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum InsertError {
    TokenCollision,
    UserCapacity,
    AppCapacity,
    GlobalCapacity,
    RateLimited,
}

#[derive(Debug, PartialEq, Eq)]
pub enum LookupResult {
    Valid(AiAppChatLinkToken),
    Redeemed(AiAppChatLinkToken),
    Expired,
    NotFound,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RedeemResult {
    Success(AiAppChatLinkToken),
    Replay(AiAppChatLinkToken),
    Expired,
    NotFound,
    ReceiptCapacity,
}

impl AiAppChatLinkTokens {
    /// Performs the same bounded local admission checks as insertion, but does not reserve a
    /// bearer or consume the issuance window. Call this before remote authority consumption so a
    /// caller already at a local limit cannot force another UI -> GroupIndex round trip.
    pub fn check_admission(&mut self, user_id: UserId, app_id: AiAppId, now: TimestampMillis) -> Result<(), InsertError> {
        self.ensure_current();
        self.prune_expired_bounded(now);
        if self.by_user.get(&user_id).map_or(0, HashSet::len) >= MAX_OUTSTANDING_PER_USER {
            return Err(InsertError::UserCapacity);
        }
        if self.by_app.get(&app_id).map_or(0, HashSet::len) >= MAX_OUTSTANDING_PER_APP {
            return Err(InsertError::AppCapacity);
        }
        if self.tokens.len() >= MAX_OUTSTANDING {
            return Err(InsertError::GlobalCapacity);
        }
        let current_count = self
            .issuance_windows
            .get(&(user_id, app_id))
            .filter(|window| now.saturating_sub(window.started_at) < ISSUANCE_WINDOW_MS)
            .map_or(0, |window| window.count);
        if current_count >= MAX_ISSUED_PER_USER_APP_WINDOW {
            return Err(InsertError::RateLimited);
        }
        Ok(())
    }

    pub fn insert(
        &mut self,
        canister_id: CanisterId,
        raw_token: &[u8],
        entry: AiAppChatLinkToken,
        now: TimestampMillis,
    ) -> Result<(), InsertError> {
        self.ensure_current();
        self.prune_expired_bounded(now);
        let digest = token_digest(canister_id, raw_token);
        if self.tokens.contains_key(&digest) || self.redeemed_receipts.contains_key(&digest) {
            return Err(InsertError::TokenCollision);
        }
        self.check_admission(entry.user_id, entry.app_id, now)?;
        let window_key = (entry.user_id, entry.app_id);

        self.by_user.entry(entry.user_id).or_default().insert(digest);
        self.by_app.entry(entry.app_id).or_default().insert(digest);
        self.by_expiry.insert((entry.expires_at, digest));
        self.tokens.insert(digest, entry);
        self.issuance_windows
            .entry(window_key)
            .and_modify(|window| {
                if now.saturating_sub(window.started_at) >= ISSUANCE_WINDOW_MS {
                    *window = IssuanceWindow {
                        started_at: now,
                        count: 1,
                    };
                } else {
                    window.count = window.count.saturating_add(1);
                }
            })
            .or_insert(IssuanceWindow {
                started_at: now,
                count: 1,
            });
        Ok(())
    }

    /// Non-consuming lookup permits exact app/subject/key checks before the atomic receipt transition.
    pub fn lookup(&mut self, canister_id: CanisterId, raw_token: &[u8], now: TimestampMillis) -> LookupResult {
        self.ensure_current();
        let digest = token_digest(canister_id, raw_token);
        let result = if let Some(entry) = self.tokens.get(&digest).cloned() {
            if entry.expires_at > now {
                LookupResult::Valid(entry)
            } else {
                self.remove_digest(&digest);
                LookupResult::Expired
            }
        } else if let Some(receipt) = self.redeemed_receipts.get(&digest).cloned() {
            if receipt.replay_until > now {
                LookupResult::Redeemed(receipt.token)
            } else {
                self.remove_receipt(&digest);
                LookupResult::Expired
            }
        } else {
            LookupResult::NotFound
        };
        self.prune_expired_bounded(now);
        result
    }

    pub fn redeem(&mut self, canister_id: CanisterId, raw_token: &[u8], now: TimestampMillis) -> RedeemResult {
        self.ensure_current();
        self.prune_expired_bounded(now);
        let digest = token_digest(canister_id, raw_token);
        if let Some(receipt) = self.redeemed_receipts.get(&digest).cloned() {
            return if receipt.replay_until > now {
                RedeemResult::Replay(receipt.token)
            } else {
                self.remove_receipt(&digest);
                RedeemResult::Expired
            };
        }
        let Some(entry) = self.tokens.get(&digest).cloned() else {
            return RedeemResult::NotFound;
        };
        if entry.expires_at <= now {
            self.remove_digest(&digest);
            return RedeemResult::Expired;
        }
        if self.receipts_by_user.get(&entry.user_id).map_or(0, HashSet::len) >= MAX_RECEIPTS_PER_USER
            || self.receipts_by_app.get(&entry.app_id).map_or(0, HashSet::len) >= MAX_RECEIPTS_PER_APP
            || self.redeemed_receipts.len() >= MAX_REDEEMED_RECEIPTS
        {
            return RedeemResult::ReceiptCapacity;
        }
        let entry = self.remove_digest(&digest).expect("live token disappeared");
        let replay_until = entry.expires_at.max(now.saturating_add(RECEIPT_RECOVERY_WINDOW_MS));
        self.receipts_by_expiry.insert((replay_until, digest));
        self.receipts_by_user.entry(entry.user_id).or_default().insert(digest);
        self.receipts_by_app.entry(entry.app_id).or_default().insert(digest);
        self.redeemed_receipts.insert(
            digest,
            RedeemedReceipt {
                token: entry.clone(),
                replay_until,
            },
        );
        RedeemResult::Success(entry)
    }

    /// Idempotent and ownership-hiding: only the exact owner's still-live bearer is removed.
    pub fn cancel(&mut self, canister_id: CanisterId, raw_token: &[u8], user_id: UserId, now: TimestampMillis) -> bool {
        self.ensure_current();
        if raw_token.len() != TOKEN_BYTES {
            return false;
        }
        let digest = token_digest(canister_id, raw_token);
        let owned = self.tokens.get(&digest).is_some_and(|entry| entry.user_id == user_id);
        let removed = owned && self.remove_digest(&digest).is_some();
        self.prune_expired_bounded(now);
        removed
    }

    /// Idempotent, ownership-hiding cleanup for a relay whose post-await revalidation failed.
    /// Every non-secret binding is checked as well as the exact issuer so one local child/LUI
    /// cannot cancel another route's bearer even if it somehow learns the raw token.
    #[allow(clippy::too_many_arguments)]
    pub fn cancel_from_issuer(
        &mut self,
        canister_id: CanisterId,
        raw_token: &[u8],
        issuer_local_user_index_canister_id: CanisterId,
        user_id: UserId,
        chat: Chat,
        app_id: AiAppId,
        app_revision: TimestampMillis,
        now: TimestampMillis,
    ) -> bool {
        self.ensure_current();
        if raw_token.len() != TOKEN_BYTES {
            return false;
        }
        let digest = token_digest(canister_id, raw_token);
        let exact = self.tokens.get(&digest).is_some_and(|entry| {
            entry.issuer_local_user_index_canister_id == issuer_local_user_index_canister_id
                && entry.user_id == user_id
                && entry.chat == chat
                && entry.app_id == app_id
                && entry.app_revision == app_revision
        });
        let removed = exact && self.remove_digest(&digest).is_some();
        self.prune_expired_bounded(now);
        removed
    }

    pub fn remove_user_app(&mut self, user_id: UserId, app_id: AiAppId) -> usize {
        self.ensure_current();
        let active: Vec<_> = self
            .by_user
            .get(&user_id)
            .into_iter()
            .flat_map(|values| values.iter().copied())
            .filter(|digest| self.tokens.get(digest).is_some_and(|entry| entry.app_id == app_id))
            .collect();
        let receipts: Vec<_> = self
            .receipts_by_user
            .get(&user_id)
            .into_iter()
            .flat_map(|values| values.iter().copied())
            .filter(|digest| {
                self.redeemed_receipts
                    .get(digest)
                    .is_some_and(|receipt| receipt.token.app_id == app_id)
            })
            .collect();
        let removed_active = active.iter().filter(|digest| self.remove_digest(digest).is_some()).count();
        let removed_receipts = receipts.iter().filter(|digest| self.remove_receipt(digest).is_some()).count();
        self.issuance_windows.remove(&(user_id, app_id));
        removed_active + removed_receipts
    }

    pub fn remove_app(&mut self, app_id: AiAppId) -> usize {
        self.ensure_current();
        let active: Vec<_> = self
            .by_app
            .get(&app_id)
            .into_iter()
            .flat_map(|values| values.iter().copied())
            .collect();
        let receipts: Vec<_> = self
            .receipts_by_app
            .get(&app_id)
            .into_iter()
            .flat_map(|values| values.iter().copied())
            .collect();
        let removed_active = active.iter().filter(|digest| self.remove_digest(digest).is_some()).count();
        let removed_receipts = receipts.iter().filter(|digest| self.remove_receipt(digest).is_some()).count();
        self.issuance_windows.retain(|(_, candidate), _| *candidate != app_id);
        removed_active + removed_receipts
    }

    pub fn invalidate_active_bearers(&mut self) {
        self.tokens.clear();
        self.by_user.clear();
        self.by_app.clear();
        self.by_expiry.clear();
    }

    pub fn invalidate_all(&mut self) {
        self.invalidate_active_bearers();
        self.issuance_windows.clear();
        self.redeemed_receipts.clear();
        self.receipts_by_expiry.clear();
        self.receipts_by_user.clear();
        self.receipts_by_app.clear();
        self.digest_version = DIGEST_VERSION;
    }

    pub fn len(&self) -> usize {
        self.tokens.len()
    }

    fn ensure_current(&mut self) {
        if self.digest_version != DIGEST_VERSION {
            self.invalidate_all();
        }
    }

    fn prune_expired_bounded(&mut self, now: TimestampMillis) {
        for _ in 0..MAX_EXPIRED_PRUNED_PER_CALL {
            let Some((expires_at, digest)) = self.by_expiry.first().copied() else {
                break;
            };
            if expires_at > now {
                break;
            }
            self.remove_digest(&digest);
        }
        for _ in 0..MAX_EXPIRED_PRUNED_PER_CALL {
            let Some((expires_at, digest)) = self.receipts_by_expiry.first().copied() else {
                break;
            };
            if expires_at > now {
                break;
            }
            self.remove_receipt(&digest);
        }
    }

    fn remove_digest(&mut self, digest: &TokenDigest) -> Option<AiAppChatLinkToken> {
        let entry = self.tokens.remove(digest)?;
        self.by_expiry.remove(&(entry.expires_at, *digest));
        remove_index(&mut self.by_user, entry.user_id, digest);
        remove_index(&mut self.by_app, entry.app_id, digest);
        Some(entry)
    }

    fn remove_receipt(&mut self, digest: &TokenDigest) -> Option<AiAppChatLinkToken> {
        let receipt = self.redeemed_receipts.remove(digest)?;
        self.receipts_by_expiry.remove(&(receipt.replay_until, *digest));
        remove_index(&mut self.receipts_by_user, receipt.token.user_id, digest);
        remove_index(&mut self.receipts_by_app, receipt.token.app_id, digest);
        Some(receipt.token)
    }

    #[cfg(test)]
    pub fn receipt_len(&self) -> usize {
        self.redeemed_receipts.len()
    }
}

fn remove_index<K: std::hash::Hash + Eq + Copy>(index: &mut HashMap<K, HashSet<TokenDigest>>, key: K, digest: &TokenDigest) {
    let remove_key = index.get_mut(&key).is_some_and(|values| {
        values.remove(digest);
        values.is_empty()
    });
    if remove_key {
        index.remove(&key);
    }
}

fn token_digest(canister_id: CanisterId, raw_token: &[u8]) -> TokenDigest {
    let mut preimage = Vec::with_capacity(TOKEN_DIGEST_DOMAIN.len() + canister_id.as_slice().len() + raw_token.len() + 1);
    preimage.extend_from_slice(TOKEN_DIGEST_DOMAIN);
    preimage.push(canister_id.as_slice().len() as u8);
    preimage.extend_from_slice(canister_id.as_slice());
    preimage.extend_from_slice(raw_token);
    sha256::sha256(&preimage)
}

fn anonymous_canister_id() -> CanisterId {
    Principal::anonymous()
}

#[cfg(test)]
mod tests {
    use super::*;
    use candid::Principal;

    fn user(seed: u8) -> UserId {
        Principal::from_slice(&[seed]).into()
    }

    fn unique_user(seed: u64) -> UserId {
        Principal::from_slice(&seed.to_be_bytes()).into()
    }

    fn raw(seed: u64) -> [u8; TOKEN_BYTES] {
        let mut value = [0; TOKEN_BYTES];
        value[..8].copy_from_slice(&seed.to_be_bytes());
        value
    }

    fn entry(user_id: UserId, app_id: AiAppId, expires_at: TimestampMillis) -> AiAppChatLinkToken {
        AiAppChatLinkToken {
            user_id,
            chat: Chat::Group(Principal::from_slice(&[20]).into()),
            app_id,
            app_revision: 3,
            app_canister_id: Principal::from_slice(&[8]),
            issuer_local_user_index_canister_id: Principal::from_slice(&[9]),
            app_user_key_fingerprint: [4; 32],
            app_user_key_version: 5,
            app_subject: [6; 32],
            chat_handle: [7; 32],
            expires_at,
        }
    }

    #[test]
    fn live_bearer_is_digest_only_and_canister_bound() {
        let canister = Principal::from_slice(&[1]);
        let raw = [0xAB; TOKEN_BYTES];
        let mut tokens = AiAppChatLinkTokens::default();
        tokens.insert(canister, &raw, entry(user(2), 7, 100), 1).unwrap();
        let encoded = msgpack::serialize_to_vec(&tokens).unwrap();
        assert!(!encoded.windows(raw.len()).any(|window| window == raw));
        assert!(matches!(tokens.lookup(canister, &raw, 2), LookupResult::Valid(_)));
        assert!(matches!(
            tokens.lookup(Principal::from_slice(&[9]), &raw, 2),
            LookupResult::NotFound
        ));
    }

    #[test]
    fn redemption_is_idempotent_through_post_commit_grace_and_cancellation_cannot_remove_receipt() {
        let canister = Principal::from_slice(&[1]);
        let raw = [3; TOKEN_BYTES];
        let mut tokens = AiAppChatLinkTokens::default();
        tokens.insert(canister, &raw, entry(user(2), 7, 100), 1).unwrap();
        assert!(matches!(tokens.lookup(canister, &raw, 2), LookupResult::Valid(_)));
        assert!(matches!(tokens.lookup(canister, &raw, 2), LookupResult::Valid(_)));
        assert!(matches!(tokens.redeem(canister, &raw, 2), RedeemResult::Success(_)));
        assert!(matches!(tokens.lookup(canister, &raw, 101), LookupResult::Redeemed(_)));
        assert!(!tokens.cancel(canister, &raw, user(2), 101));
        assert!(matches!(tokens.redeem(canister, &raw, 101), RedeemResult::Replay(_)));
        assert!(matches!(
            tokens.lookup(canister, &raw, 2 + RECEIPT_RECOVERY_WINDOW_MS),
            LookupResult::Expired
        ));
    }

    #[test]
    fn expiry_and_exact_owner_cancellation_fail_closed() {
        let canister = Principal::from_slice(&[1]);
        let raw = [4; TOKEN_BYTES];
        let mut tokens = AiAppChatLinkTokens::default();
        tokens.insert(canister, &raw, entry(user(2), 7, 10), 1).unwrap();
        assert!(!tokens.cancel(canister, &raw, user(3), 2));
        assert!(tokens.cancel(canister, &raw, user(2), 2));
        assert!(matches!(tokens.lookup(canister, &raw, 2), LookupResult::NotFound));

        let expired = [5; TOKEN_BYTES];
        tokens.insert(canister, &expired, entry(user(2), 7, 10), 1).unwrap();
        assert!(matches!(tokens.lookup(canister, &expired, 10), LookupResult::Expired));
        assert!(matches!(tokens.redeem(canister, &expired, 10), RedeemResult::NotFound));
    }

    #[test]
    fn issuer_cleanup_requires_every_exact_route_binding() {
        let canister = Principal::from_slice(&[1]);
        let issuer = Principal::from_slice(&[9]);
        let owner = user(2);
        let chat = Chat::Group(Principal::from_slice(&[20]).into());
        let raw = [0xE1; TOKEN_BYTES];
        let mut tokens = AiAppChatLinkTokens::default();
        tokens.insert(canister, &raw, entry(owner, 7, 100), 1).unwrap();

        assert!(!tokens.cancel_from_issuer(canister, &raw, Principal::from_slice(&[10]), owner, chat, 7, 3, 2,));
        assert!(!tokens.cancel_from_issuer(canister, &raw, issuer, user(3), chat, 7, 3, 2));
        assert!(!tokens.cancel_from_issuer(
            canister,
            &raw,
            issuer,
            owner,
            Chat::Group(Principal::from_slice(&[21]).into()),
            7,
            3,
            2,
        ));
        assert!(!tokens.cancel_from_issuer(canister, &raw, issuer, owner, chat, 8, 3, 2));
        assert!(!tokens.cancel_from_issuer(canister, &raw, issuer, owner, chat, 7, 4, 2));
        assert!(matches!(tokens.lookup(canister, &raw, 2), LookupResult::Valid(_)));
        assert!(tokens.cancel_from_issuer(canister, &raw, issuer, owner, chat, 7, 3, 2));
        assert!(matches!(tokens.lookup(canister, &raw, 2), LookupResult::NotFound));
    }

    #[test]
    fn issuance_rate_limit_counts_successes_and_recovers_after_window() {
        let canister = Principal::from_slice(&[1]);
        let owner = user(2);
        let mut tokens = AiAppChatLinkTokens::default();
        for seed in 0..MAX_ISSUED_PER_USER_APP_WINDOW {
            let mut raw = [0; TOKEN_BYTES];
            raw[..2].copy_from_slice(&seed.to_be_bytes());
            tokens.insert(canister, &raw, entry(owner, 7, 100), 1).unwrap();
            assert!(matches!(tokens.redeem(canister, &raw, 2), RedeemResult::Success(_)));
        }
        assert_eq!(
            tokens.insert(canister, &[99; TOKEN_BYTES], entry(owner, 7, 100), 2),
            Err(InsertError::RateLimited)
        );
        assert_eq!(tokens.check_admission(owner, 7, 2), Err(InsertError::RateLimited));
        assert_eq!(
            tokens.insert(
                canister,
                &[100; TOKEN_BYTES],
                entry(owner, 7, ISSUANCE_WINDOW_MS + 200),
                ISSUANCE_WINDOW_MS + 2,
            ),
            Ok(())
        );
    }

    #[test]
    fn redeemed_receipt_round_trip_is_digest_only_and_replays() {
        let canister = Principal::from_slice(&[1]);
        let raw = [0xCD; TOKEN_BYTES];
        let mut tokens = AiAppChatLinkTokens::default();
        tokens.insert(canister, &raw, entry(user(2), 7, 100), 1).unwrap();
        assert!(matches!(tokens.redeem(canister, &raw, 99), RedeemResult::Success(_)));
        let encoded = msgpack::serialize_to_vec(&tokens).unwrap();
        assert!(!encoded.windows(raw.len()).any(|window| window == raw));
        let mut restored: AiAppChatLinkTokens = msgpack::deserialize_then_unwrap(&encoded);
        assert!(matches!(restored.lookup(canister, &raw, 101), LookupResult::Redeemed(_)));
        assert!(matches!(restored.redeem(canister, &raw, 101), RedeemResult::Replay(_)));
    }

    #[test]
    fn legacy_token_without_issuer_binding_deserializes_fail_closed_for_cleanup() {
        #[derive(Serialize)]
        struct LegacyToken {
            user_id: UserId,
            chat: Chat,
            app_id: AiAppId,
            app_revision: TimestampMillis,
            app_canister_id: CanisterId,
            app_user_key_fingerprint: [u8; 32],
            app_user_key_version: u64,
            app_subject: [u8; 32],
            chat_handle: [u8; 32],
            expires_at: TimestampMillis,
        }
        let current = entry(user(2), 7, 100);
        let bytes = msgpack::serialize_to_vec(&LegacyToken {
            user_id: current.user_id,
            chat: current.chat,
            app_id: current.app_id,
            app_revision: current.app_revision,
            app_canister_id: current.app_canister_id,
            app_user_key_fingerprint: current.app_user_key_fingerprint,
            app_user_key_version: current.app_user_key_version,
            app_subject: current.app_subject,
            chat_handle: current.chat_handle,
            expires_at: current.expires_at,
        })
        .unwrap();
        let restored: AiAppChatLinkToken = msgpack::deserialize_then_unwrap(&bytes);
        assert_eq!(restored.issuer_local_user_index_canister_id, Principal::anonymous());
    }

    #[test]
    fn outstanding_user_app_and_global_caps_are_exact() {
        let canister = Principal::from_slice(&[1]);

        let mut per_user = AiAppChatLinkTokens::default();
        for seed in 0..MAX_OUTSTANDING_PER_USER as u64 {
            per_user.insert(canister, &raw(seed), entry(user(2), 7, 100), 1).unwrap();
        }
        assert_eq!(
            per_user.insert(canister, &raw(10_001), entry(user(2), 8, 100), 1),
            Err(InsertError::UserCapacity)
        );

        let mut per_app = AiAppChatLinkTokens::default();
        for seed in 0..MAX_OUTSTANDING_PER_APP as u64 {
            per_app
                .insert(canister, &raw(seed), entry(unique_user(seed + 1), 7, 100), 1)
                .unwrap();
        }
        assert_eq!(
            per_app.insert(canister, &raw(20_001), entry(unique_user(20_001), 7, 100), 1),
            Err(InsertError::AppCapacity)
        );

        let mut global = AiAppChatLinkTokens::default();
        for seed in 0..MAX_OUTSTANDING as u64 {
            let app_id = (seed / MAX_OUTSTANDING_PER_APP as u64) as AiAppId;
            global
                .insert(canister, &raw(seed), entry(unique_user(seed + 1), app_id, 100), 1)
                .unwrap();
        }
        assert_eq!(
            global.insert(canister, &raw(30_001), entry(unique_user(30_001), 99, 100), 1),
            Err(InsertError::GlobalCapacity)
        );
    }

    #[test]
    fn receipt_caps_preserve_active_bearers_and_expiry_reclaims_capacity() {
        let canister = Principal::from_slice(&[1]);

        let owner = user(2);
        let mut per_user = AiAppChatLinkTokens::default();
        for seed in 0..MAX_RECEIPTS_PER_USER as u64 {
            let bearer = raw(seed);
            per_user
                .insert(canister, &bearer, entry(owner, seed as AiAppId, 100), 1)
                .unwrap();
            assert!(matches!(per_user.redeem(canister, &bearer, 2), RedeemResult::Success(_)));
        }
        let blocked = raw(100_001);
        per_user
            .insert(canister, &blocked, entry(owner, 500, RECEIPT_RECOVERY_WINDOW_MS + 1_000), 2)
            .unwrap();
        assert_eq!(per_user.redeem(canister, &blocked, 2), RedeemResult::ReceiptCapacity);
        assert!(matches!(per_user.lookup(canister, &blocked, 2), LookupResult::Valid(_)));
        assert!(matches!(
            per_user.redeem(canister, &blocked, 2 + RECEIPT_RECOVERY_WINDOW_MS),
            RedeemResult::Success(_)
        ));

        let mut per_app = AiAppChatLinkTokens::default();
        for seed in 0..MAX_RECEIPTS_PER_APP as u64 {
            let bearer = raw(seed);
            per_app
                .insert(canister, &bearer, entry(unique_user(seed + 1), 7, 100), 1)
                .unwrap();
            assert!(matches!(per_app.redeem(canister, &bearer, 2), RedeemResult::Success(_)));
        }
        let blocked = raw(200_001);
        per_app
            .insert(canister, &blocked, entry(unique_user(200_001), 7, 100), 2)
            .unwrap();
        assert_eq!(per_app.redeem(canister, &blocked, 2), RedeemResult::ReceiptCapacity);
        assert!(matches!(per_app.lookup(canister, &blocked, 2), LookupResult::Valid(_)));

        let mut global = AiAppChatLinkTokens::default();
        for seed in 0..MAX_REDEEMED_RECEIPTS as u64 {
            let bearer = raw(seed);
            let app_id = (seed / MAX_RECEIPTS_PER_APP as u64) as AiAppId;
            global
                .insert(canister, &bearer, entry(unique_user(seed + 1), app_id, 100), 1)
                .unwrap();
            assert!(matches!(global.redeem(canister, &bearer, 2), RedeemResult::Success(_)));
        }
        let blocked = raw(300_001);
        global
            .insert(canister, &blocked, entry(unique_user(300_001), 99, 100), 2)
            .unwrap();
        assert_eq!(global.redeem(canister, &blocked, 2), RedeemResult::ReceiptCapacity);
        assert!(matches!(global.lookup(canister, &blocked, 2), LookupResult::Valid(_)));
    }

    #[test]
    fn explicit_user_app_and_app_cleanup_remove_exact_receipt_indexes() {
        let canister = Principal::from_slice(&[1]);
        let user_a = user(2);
        let user_b = user(3);
        let cases = [
            (raw(1), entry(user_a, 7, 100)),
            (raw(2), entry(user_a, 8, 100)),
            (raw(3), entry(user_b, 7, 100)),
        ];
        let mut tokens = AiAppChatLinkTokens::default();
        for (bearer, token) in &cases {
            tokens.insert(canister, bearer, token.clone(), 1).unwrap();
            assert!(matches!(tokens.redeem(canister, bearer, 2), RedeemResult::Success(_)));
        }
        assert_eq!(tokens.receipt_len(), 3);
        assert_eq!(tokens.remove_user_app(user_a, 7), 1);
        assert!(matches!(tokens.lookup(canister, &raw(1), 2), LookupResult::NotFound));
        assert!(matches!(tokens.lookup(canister, &raw(2), 2), LookupResult::Redeemed(_)));
        assert!(matches!(tokens.lookup(canister, &raw(3), 2), LookupResult::Redeemed(_)));
        assert_eq!(tokens.remove_app(7), 1);
        assert!(matches!(tokens.lookup(canister, &raw(3), 2), LookupResult::NotFound));
        assert!(matches!(tokens.lookup(canister, &raw(2), 2), LookupResult::Redeemed(_)));
        assert_eq!(tokens.receipt_len(), 1);
    }

    #[test]
    fn serde_default_state_is_invalidated_instead_of_reviving_unknown_bearers() {
        #[derive(Serialize)]
        struct Legacy {
            tokens: HashMap<TokenDigest, AiAppChatLinkToken>,
        }
        let raw = [8; TOKEN_BYTES];
        let canister = Principal::from_slice(&[1]);
        let digest = token_digest(canister, &raw);
        let bytes = msgpack::serialize_to_vec(&Legacy {
            tokens: HashMap::from([(digest, entry(user(2), 7, 100))]),
        })
        .unwrap();
        let mut restored: AiAppChatLinkTokens = msgpack::deserialize_then_unwrap(&bytes);
        assert!(matches!(restored.lookup(canister, &raw, 2), LookupResult::NotFound));
        assert_eq!(restored.len(), 0);
    }
}
