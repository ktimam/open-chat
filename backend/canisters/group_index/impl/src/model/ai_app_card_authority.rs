use group_index_canister::ai_app_card_authority::{AiAppCardAuthorityBindingV1, OpaqueHashPurposeV1, opaque_hash_v1};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use types::{CanisterId, ChatId, CommunityId, TimestampMillis};

pub const MAX_OUTSTANDING_AUTHORITIES: usize = 10_000;
pub const MAX_OUTSTANDING_AUTHORITIES_PER_CHILD: u16 = 64;
pub const MAX_TRACKED_CARD_ROUTES: usize = 1_000_000;
pub const MAX_EXPIRED_AUTHORITIES_CLEANED_PER_CALL: usize = 64;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CardRouteKey {
    Group(ChatId),
    Community(CommunityId),
}

#[derive(Serialize, Deserialize, Clone)]
struct RouteGeneration {
    owner: CanisterId,
    generation: u64,
}

#[derive(Serialize, Deserialize, Clone)]
struct AuthorityRecord {
    binding: AiAppCardAuthorityBindingV1,
    route: CardRouteKey,
    route_generation: u64,
    expires_at: TimestampMillis,
}

#[derive(Serialize, Deserialize, Default)]
pub struct AiAppCardAuthorityStore {
    #[serde(default)]
    canister_version: Option<u64>,
    records: HashMap<[u8; 32], AuthorityRecord>,
    expiry_index: BTreeSet<(TimestampMillis, [u8; 32])>,
    per_child_counts: HashMap<CardRouteKey, u16>,
    route_generations: HashMap<CardRouteKey, RouteGeneration>,
    next_route_generation: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum InsertError {
    TokenCollision,
    GlobalCapacity,
    ChildCapacity,
    RouteCapacity,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CheckResult {
    Valid,
    NotFound,
    Expired,
    InvalidBinding,
    RouteChanged,
}

impl AiAppCardAuthorityStore {
    /// Invalidates every short-lived authority and secondary index at a logical lifecycle
    /// transition. Route metadata is also reset to avoid reusing a restored route generation.
    pub fn invalidate_all(&mut self) {
        *self = Self::default();
    }

    pub fn stored_binding(&self, raw_token: &[u8]) -> Option<AiAppCardAuthorityBindingV1> {
        let token_hash = opaque_hash_v1(OpaqueHashPurposeV1::AuthorityToken, raw_token);
        self.records.get(&token_hash).map(|record| record.binding.clone())
    }

    pub fn observe_route(&mut self, route: CardRouteKey, owner: Option<CanisterId>) {
        let unchanged = owner.is_some_and(|owner| {
            self.route_generations
                .get(&route)
                .is_some_and(|current| current.owner == owner)
        });
        if unchanged {
            return;
        }
        let Some(next_generation) = self.next_route_generation.checked_add(1) else {
            // Never reuse a generation after wraparound. The affected route remains unavailable
            // for new authority issuance, which is safer than reviving a pre-change token.
            self.route_generations.remove(&route);
            return;
        };
        self.next_route_generation = next_generation.max(1);
        match owner {
            Some(owner)
                if self.route_generations.contains_key(&route) || self.route_generations.len() < MAX_TRACKED_CARD_ROUTES =>
            {
                self.route_generations.insert(
                    route,
                    RouteGeneration {
                        owner,
                        generation: self.next_route_generation,
                    },
                );
            }
            Some(_) => {}
            None => {
                self.route_generations.remove(&route);
            }
        }
    }

    pub fn insert(
        &mut self,
        raw_token: &[u8],
        binding: AiAppCardAuthorityBindingV1,
        route: CardRouteKey,
        current_owner: CanisterId,
        expires_at: TimestampMillis,
        now: TimestampMillis,
    ) -> Result<(), InsertError> {
        self.cleanup_expired(now, MAX_EXPIRED_AUTHORITIES_CLEANED_PER_CALL);
        self.observe_route(route, Some(current_owner));
        let Some(route_generation) = self.route_generations.get(&route) else {
            return Err(InsertError::RouteCapacity);
        };
        if route_generation.owner != current_owner || binding.local_user_index_canister_id != current_owner {
            return Err(InsertError::RouteCapacity);
        }
        if self.records.len() >= MAX_OUTSTANDING_AUTHORITIES {
            return Err(InsertError::GlobalCapacity);
        }
        if self.per_child_counts.get(&route).copied().unwrap_or_default() >= MAX_OUTSTANDING_AUTHORITIES_PER_CHILD {
            return Err(InsertError::ChildCapacity);
        }
        let token_hash = opaque_hash_v1(OpaqueHashPurposeV1::AuthorityToken, raw_token);
        if self.records.contains_key(&token_hash) {
            return Err(InsertError::TokenCollision);
        }
        self.records.insert(
            token_hash,
            AuthorityRecord {
                binding,
                route,
                route_generation: route_generation.generation,
                expires_at,
            },
        );
        self.expiry_index.insert((expires_at, token_hash));
        *self.per_child_counts.entry(route).or_default() += 1;
        Ok(())
    }

    pub fn check(
        &self,
        raw_token: &[u8],
        expected: &AiAppCardAuthorityBindingV1,
        current_owner: Option<CanisterId>,
        now: TimestampMillis,
    ) -> CheckResult {
        let token_hash = opaque_hash_v1(OpaqueHashPurposeV1::AuthorityToken, raw_token);
        let Some(record) = self.records.get(&token_hash) else {
            return CheckResult::NotFound;
        };
        if record.expires_at <= now {
            return CheckResult::Expired;
        }
        if &record.binding != expected {
            return CheckResult::InvalidBinding;
        }
        if current_owner != Some(expected.local_user_index_canister_id)
            || self.route_generations.get(&record.route).is_none_or(|route| {
                route.owner != expected.local_user_index_canister_id || route.generation != record.route_generation
            })
        {
            return CheckResult::RouteChanged;
        }
        CheckResult::Valid
    }

    pub fn consume(
        &mut self,
        raw_token: &[u8],
        expected: &AiAppCardAuthorityBindingV1,
        current_owner: Option<CanisterId>,
        now: TimestampMillis,
    ) -> CheckResult {
        let result = self.check(raw_token, expected, current_owner, now);
        if matches!(result, CheckResult::Valid | CheckResult::Expired | CheckResult::RouteChanged) {
            let token_hash = opaque_hash_v1(OpaqueHashPurposeV1::AuthorityToken, raw_token);
            self.remove_record(&token_hash);
        }
        self.cleanup_expired(now, MAX_EXPIRED_AUTHORITIES_CLEANED_PER_CALL);
        result
    }

    pub fn cleanup_expired_bounded(&mut self, now: TimestampMillis, limit: usize) -> bool {
        self.cleanup_expired(now, limit);
        self.expiry_index.first().is_some_and(|(expires_at, _)| *expires_at <= now)
    }

    fn cleanup_expired(&mut self, now: TimestampMillis, limit: usize) {
        let expired: Vec<_> = self
            .expiry_index
            .iter()
            .take_while(|(expires_at, _)| *expires_at <= now)
            .take(limit)
            .copied()
            .collect();
        for (_, token_hash) in expired {
            self.remove_record(&token_hash);
        }
    }

    fn remove_record(&mut self, token_hash: &[u8; 32]) {
        if let Some(record) = self.records.remove(token_hash) {
            self.expiry_index.remove(&(record.expires_at, *token_hash));
            if let Some(count) = self.per_child_counts.get_mut(&record.route) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    self.per_child_counts.remove(&record.route);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use candid::Principal;
    use group_index_canister::ai_app_card_authority::AiAppCardAuthorityOperationV1;
    use types::{AiAppCardContext, Chat, MessageId, UserId};

    fn binding(group: Principal, owner: Principal, user: u8) -> AiAppCardAuthorityBindingV1 {
        let user_id: UserId = Principal::from_slice(&[user]).into();
        AiAppCardAuthorityBindingV1 {
            local_user_index_canister_id: owner,
            context: AiAppCardContext {
                user_id,
                chat: Chat::Group(group.into()),
                chat_key: format!("group:{}", Principal::from(group)),
                thread_root_message_index: None,
                message_id: MessageId::from(1u64),
                app_id: 1,
                app_revision: 2,
                action_id: "generic.action".to_string(),
            },
            content_hash: [3; 32],
            operation: AiAppCardAuthorityOperationV1::ValidateProvenance {
                provenance_hash: [4; 32],
            },
        }
    }

    #[test]
    fn token_is_exact_one_time_and_cannot_cross_shards() {
        let group = Principal::from_slice(&[7]);
        let owner = Principal::from_slice(&[8]);
        let other = Principal::from_slice(&[9]);
        let route = CardRouteKey::Group(group.into());
        let expected = binding(group, owner, 10);
        let mut store = AiAppCardAuthorityStore::default();
        store.insert(&[1; 32], expected.clone(), route, owner, 20, 1).unwrap();
        assert_eq!(store.check(&[1; 32], &expected, Some(other), 2), CheckResult::RouteChanged);
        assert_eq!(store.consume(&[1; 32], &expected, Some(owner), 2), CheckResult::Valid);
        assert_eq!(store.consume(&[1; 32], &expected, Some(owner), 2), CheckResult::NotFound);
    }

    #[test]
    fn removal_and_same_owner_readd_changes_generation() {
        let group = Principal::from_slice(&[7]);
        let owner = Principal::from_slice(&[8]);
        let route = CardRouteKey::Group(group.into());
        let expected = binding(group, owner, 10);
        let mut store = AiAppCardAuthorityStore::default();
        store.insert(&[1; 32], expected.clone(), route, owner, 20, 1).unwrap();
        store.observe_route(route, None);
        store.observe_route(route, Some(owner));
        assert_eq!(store.consume(&[1; 32], &expected, Some(owner), 2), CheckResult::RouteChanged);
    }

    #[test]
    fn binding_mismatch_does_not_burn_an_unguessable_token() {
        let group = Principal::from_slice(&[7]);
        let owner = Principal::from_slice(&[8]);
        let route = CardRouteKey::Group(group.into());
        let expected = binding(group, owner, 10);
        let mut wrong = expected.clone();
        wrong.context.user_id = Principal::from_slice(&[11]).into();
        let mut store = AiAppCardAuthorityStore::default();
        store.insert(&[1; 32], expected.clone(), route, owner, 20, 1).unwrap();
        assert_eq!(store.consume(&[1; 32], &wrong, Some(owner), 2), CheckResult::InvalidBinding);
        assert_eq!(store.consume(&[1; 32], &expected, Some(owner), 2), CheckResult::Valid);
    }

    #[test]
    fn another_lui_cannot_present_the_owners_token_or_burn_it() {
        let group = Principal::from_slice(&[7]);
        let owner = Principal::from_slice(&[8]);
        let other = Principal::from_slice(&[9]);
        let route = CardRouteKey::Group(group.into());
        let expected = binding(group, owner, 10);
        let mut forged = expected.clone();
        forged.local_user_index_canister_id = other;
        let mut store = AiAppCardAuthorityStore::default();
        store.insert(&[1; 32], expected.clone(), route, owner, 20, 1).unwrap();
        assert_eq!(store.consume(&[1; 32], &forged, Some(owner), 2), CheckResult::InvalidBinding);
        assert_eq!(store.consume(&[1; 32], &expected, Some(owner), 2), CheckResult::Valid);
    }

    #[test]
    fn expiry_is_fail_closed_and_cleaned_before_new_issuance() {
        let group = Principal::from_slice(&[7]);
        let owner = Principal::from_slice(&[8]);
        let route = CardRouteKey::Group(group.into());
        let expected = binding(group, owner, 10);
        let mut store = AiAppCardAuthorityStore::default();
        store.insert(&[1; 32], expected.clone(), route, owner, 2, 1).unwrap();
        assert_eq!(store.check(&[1; 32], &expected, Some(owner), 2), CheckResult::Expired);
        store.insert(&[2; 32], expected.clone(), route, owner, 20, 2).unwrap();
        assert_eq!(store.check(&[1; 32], &expected, Some(owner), 2), CheckResult::NotFound);
        assert_eq!(store.check(&[2; 32], &expected, Some(owner), 2), CheckResult::Valid);
    }

    #[test]
    fn expired_consume_reports_expired_then_replay_is_not_found() {
        let group = Principal::from_slice(&[7]);
        let owner = Principal::from_slice(&[8]);
        let route = CardRouteKey::Group(group.into());
        let expected = binding(group, owner, 10);
        let mut store = AiAppCardAuthorityStore::default();
        store.insert(&[1; 32], expected.clone(), route, owner, 2, 1).unwrap();
        assert_eq!(store.consume(&[1; 32], &expected, Some(owner), 2), CheckResult::Expired);
        assert_eq!(store.consume(&[1; 32], &expected, Some(owner), 2), CheckResult::NotFound);
    }

    #[test]
    fn owner_move_invalidates_an_unconsumed_token() {
        let group = Principal::from_slice(&[7]);
        let owner = Principal::from_slice(&[8]);
        let other = Principal::from_slice(&[9]);
        let route = CardRouteKey::Group(group.into());
        let expected = binding(group, owner, 10);
        let mut store = AiAppCardAuthorityStore::default();
        store.insert(&[1; 32], expected.clone(), route, owner, 20, 1).unwrap();
        store.observe_route(route, Some(other));
        assert_eq!(store.consume(&[1; 32], &expected, Some(other), 2), CheckResult::RouteChanged);
    }

    #[test]
    fn route_generation_exhaustion_fails_closed_without_reuse() {
        let group = Principal::from_slice(&[7]);
        let owner = Principal::from_slice(&[8]);
        let route = CardRouteKey::Group(group.into());
        let expected = binding(group, owner, 10);
        let mut store = AiAppCardAuthorityStore::default();
        store.insert(&[1; 32], expected.clone(), route, owner, 20, 1).unwrap();
        store.next_route_generation = u64::MAX;
        store.observe_route(route, None);
        store.observe_route(route, Some(owner));
        assert_eq!(
            store.insert(&[2; 32], expected.clone(), route, owner, 20, 2),
            Err(InsertError::RouteCapacity)
        );
        assert_eq!(store.consume(&[1; 32], &expected, Some(owner), 2), CheckResult::RouteChanged);
    }

    #[test]
    fn per_child_and_global_caps_fail_closed() {
        let owner = Principal::from_slice(&[8]);
        let first_group = Principal::from_slice(&[1]);
        let first_route = CardRouteKey::Group(first_group.into());
        let first_binding = binding(first_group, owner, 10);
        let mut store = AiAppCardAuthorityStore::default();
        for index in 0..MAX_OUTSTANDING_AUTHORITIES_PER_CHILD {
            let token = (index as u64).to_be_bytes();
            store
                .insert(&token, first_binding.clone(), first_route, owner, 100, 1)
                .unwrap();
        }
        assert_eq!(
            store.insert(&[250; 32], first_binding, first_route, owner, 100, 1),
            Err(InsertError::ChildCapacity)
        );

        let mut store = AiAppCardAuthorityStore::default();
        for index in 0..MAX_OUTSTANDING_AUTHORITIES {
            let group = Principal::from_slice(&(index as u64 + 1).to_be_bytes());
            let route = CardRouteKey::Group(group.into());
            let token = (index as u64).to_be_bytes();
            store.insert(&token, binding(group, owner, 10), route, owner, 100, 1).unwrap();
        }
        let extra_group = Principal::from_slice(&u64::MAX.to_be_bytes());
        assert_eq!(
            store.insert(
                &[251; 32],
                binding(extra_group, owner, 10),
                CardRouteKey::Group(extra_group.into()),
                owner,
                100,
                1,
            ),
            Err(InsertError::GlobalCapacity)
        );
    }

    #[test]
    fn serialization_round_trip_keeps_hash_only_and_replay_state() {
        let group = Principal::from_slice(&[7]);
        let owner = Principal::from_slice(&[8]);
        let route = CardRouteKey::Group(group.into());
        let expected = binding(group, owner, 10);
        let raw_token = [0xA5; 32];
        let mut store = AiAppCardAuthorityStore::default();
        store.insert(&raw_token, expected.clone(), route, owner, 20, 1).unwrap();
        let bytes = msgpack::serialize_to_vec(&store).unwrap();
        assert!(!bytes.windows(raw_token.len()).any(|window| window == raw_token));
        let mut reopened: AiAppCardAuthorityStore = msgpack::deserialize(&bytes[..]).unwrap();
        assert_eq!(reopened.consume(&raw_token, &expected, Some(owner), 2), CheckResult::Valid);
        assert_eq!(reopened.consume(&raw_token, &expected, Some(owner), 2), CheckResult::NotFound);
    }

    #[test]
    fn bounded_cleanup_reports_more_until_backlog_is_drained() {
        let owner = Principal::from_slice(&[8]);
        let mut store = AiAppCardAuthorityStore::default();
        for index in 0..3u8 {
            let group = Principal::from_slice(&[index + 1]);
            store
                .insert(
                    &[index; 32],
                    binding(group, owner, 10),
                    CardRouteKey::Group(group.into()),
                    owner,
                    2,
                    1,
                )
                .unwrap();
        }
        assert!(store.cleanup_expired_bounded(2, 2));
        assert!(!store.cleanup_expired_bounded(2, 2));
    }

    #[test]
    fn lifecycle_invalidation_clears_every_authority_index() {
        let group = Principal::from_slice(&[7]);
        let owner = Principal::from_slice(&[8]);
        let route = CardRouteKey::Group(group.into());
        let expected = binding(group, owner, 10);
        let raw_token = [0xA5; 32];
        let mut store = AiAppCardAuthorityStore::default();

        store.insert(&raw_token, expected.clone(), route, owner, 20, 1).unwrap();
        store.invalidate_all();
        assert_eq!(store.check(&raw_token, &expected, Some(owner), 2), CheckResult::NotFound);
        assert!(store.records.is_empty());
        assert!(store.expiry_index.is_empty());
        assert!(store.per_child_counts.is_empty());
        assert!(store.route_generations.is_empty());
        assert_eq!(store.next_route_generation, 0);
    }
}
