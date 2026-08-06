use candid::Principal;
use group_index_canister::ai_app_chat_link_authority::AiAppChatLinkAuthorityBindingV1;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};
use types::{CanisterId, Chat, TimestampMillis};

pub const MAX_AUTHORITIES: usize = 10_000;
pub const MAX_AUTHORITIES_PER_CHILD: usize = 1_000;
const MAX_EXPIRED_PRUNED_PER_CALL: usize = 64;
const DIGEST_VERSION: u8 = 1;
const DIGEST_DOMAIN: &[u8] = b"openchat.ai-app-chat-link-authority.v1\0";
type Digest = [u8; 32];

#[derive(Serialize, Deserialize, Clone)]
struct Entry {
    binding: AiAppChatLinkAuthorityBindingV1,
    expires_at: TimestampMillis,
}

#[derive(Serialize, Deserialize)]
pub struct AiAppChatLinkAuthorityStore {
    #[serde(default)]
    entries: HashMap<Digest, Entry>,
    #[serde(default)]
    by_child: HashMap<CanisterId, HashSet<Digest>>,
    #[serde(default)]
    by_expiry: BTreeSet<(TimestampMillis, Digest)>,
    #[serde(default)]
    digest_version: u8,
}

impl Default for AiAppChatLinkAuthorityStore {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            by_child: HashMap::new(),
            by_expiry: BTreeSet::new(),
            digest_version: DIGEST_VERSION,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum InsertError {
    TokenCollision,
    ChildCapacity,
    GlobalCapacity,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ConsumeResult {
    Valid,
    NotFound,
    Expired,
    BindingMismatch,
}

impl AiAppChatLinkAuthorityStore {
    pub fn insert(
        &mut self,
        canister_id: CanisterId,
        raw_token: &[u8],
        binding: AiAppChatLinkAuthorityBindingV1,
        expires_at: TimestampMillis,
        now: TimestampMillis,
    ) -> Result<(), InsertError> {
        self.ensure_current();
        self.prune_expired_bounded(now);
        let digest = digest(canister_id, raw_token);
        if self.entries.contains_key(&digest) {
            return Err(InsertError::TokenCollision);
        }
        let child = authoritative_child(binding.chat);
        if self.by_child.get(&child).map_or(0, HashSet::len) >= MAX_AUTHORITIES_PER_CHILD {
            return Err(InsertError::ChildCapacity);
        }
        if self.entries.len() >= MAX_AUTHORITIES {
            return Err(InsertError::GlobalCapacity);
        }
        self.entries.insert(digest, Entry { binding, expires_at });
        self.by_child.entry(child).or_default().insert(digest);
        self.by_expiry.insert((expires_at, digest));
        Ok(())
    }

    pub fn consume(
        &mut self,
        canister_id: CanisterId,
        raw_token: &[u8],
        expected: &AiAppChatLinkAuthorityBindingV1,
        now: TimestampMillis,
    ) -> ConsumeResult {
        self.ensure_current();
        let digest = digest(canister_id, raw_token);
        let result = match self.entries.get(&digest) {
            None => ConsumeResult::NotFound,
            Some(entry) if entry.expires_at <= now => {
                self.remove(&digest);
                ConsumeResult::Expired
            }
            Some(entry) if &entry.binding != expected => ConsumeResult::BindingMismatch,
            Some(_) => {
                self.remove(&digest);
                ConsumeResult::Valid
            }
        };
        self.prune_expired_bounded(now);
        result
    }

    pub fn invalidate_all(&mut self) {
        self.entries.clear();
        self.by_child.clear();
        self.by_expiry.clear();
        self.digest_version = DIGEST_VERSION;
    }

    pub fn len(&self) -> usize {
        self.entries.len()
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
            self.remove(&digest);
        }
    }

    fn remove(&mut self, digest: &Digest) -> Option<Entry> {
        let entry = self.entries.remove(digest)?;
        self.by_expiry.remove(&(entry.expires_at, *digest));
        let child = authoritative_child(entry.binding.chat);
        let remove_child = self.by_child.get_mut(&child).is_some_and(|values| {
            values.remove(digest);
            values.is_empty()
        });
        if remove_child {
            self.by_child.remove(&child);
        }
        Some(entry)
    }
}

fn authoritative_child(chat: Chat) -> Principal {
    match chat {
        Chat::Group(chat_id) => chat_id.into(),
        Chat::Channel(community_id, _) => community_id.into(),
        Chat::Direct(_) => Principal::anonymous(),
    }
}

fn digest(canister_id: CanisterId, raw_token: &[u8]) -> Digest {
    let mut bytes = Vec::with_capacity(DIGEST_DOMAIN.len() + canister_id.as_slice().len() + raw_token.len() + 1);
    bytes.extend_from_slice(DIGEST_DOMAIN);
    bytes.push(canister_id.as_slice().len() as u8);
    bytes.extend_from_slice(canister_id.as_slice());
    bytes.extend_from_slice(raw_token);
    sha256::sha256(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use types::UserId;

    fn binding(seed: u8) -> AiAppChatLinkAuthorityBindingV1 {
        let group = Principal::from_slice(&[20]);
        AiAppChatLinkAuthorityBindingV1 {
            local_user_index_canister_id: Principal::from_slice(&[1]),
            user_id: UserId::from(Principal::from_slice(&[seed])),
            chat: Chat::Group(group.into()),
            app_id: 7,
            app_revision: 8,
        }
    }

    #[test]
    fn wrong_chat_app_and_revision_do_not_burn_then_exact_consume_is_one_time() {
        let canister = Principal::from_slice(&[2]);
        let raw = [3; 32];
        let exact = binding(4);
        let mut store = AiAppChatLinkAuthorityStore::default();
        store.insert(canister, &raw, exact.clone(), 100, 1).unwrap();
        let mut wrong_chat = exact.clone();
        wrong_chat.chat = Chat::Group(Principal::from_slice(&[21]).into());
        let mut wrong_app = exact.clone();
        wrong_app.app_id += 1;
        let mut wrong_revision = exact.clone();
        wrong_revision.app_revision += 1;
        for wrong in [&wrong_chat, &wrong_app, &wrong_revision] {
            assert_eq!(store.consume(canister, &raw, wrong, 2), ConsumeResult::BindingMismatch);
            assert_eq!(store.len(), 1);
        }
        assert_eq!(store.consume(canister, &raw, &exact, 2), ConsumeResult::Valid);
        assert_eq!(store.consume(canister, &raw, &exact, 2), ConsumeResult::NotFound);
    }

    #[test]
    fn expiry_cleans_every_index_and_raw_bearer_is_never_serialized() {
        let canister = Principal::from_slice(&[2]);
        let raw = [0xAB; 32];
        let exact = binding(4);
        let mut store = AiAppChatLinkAuthorityStore::default();
        store.insert(canister, &raw, exact.clone(), 10, 1).unwrap();
        let encoded = msgpack::serialize_to_vec(&store).unwrap();
        assert!(!encoded.windows(raw.len()).any(|window| window == raw));
        assert_eq!(store.consume(canister, &raw, &exact, 10), ConsumeResult::Expired);
        assert_eq!(store.len(), 0);
        store.insert(canister, &[5; 32], exact, 20, 11).unwrap();
    }

    #[test]
    fn per_child_capacity_is_exact_and_cleanup_recovers() {
        let canister = Principal::from_slice(&[2]);
        let mut store = AiAppChatLinkAuthorityStore::default();
        for seed in 0..MAX_AUTHORITIES_PER_CHILD {
            let mut raw = [0; 32];
            raw[..8].copy_from_slice(&(seed as u64).to_be_bytes());
            store.insert(canister, &raw, binding((seed % 250) as u8 + 1), 10, 1).unwrap();
        }
        assert_eq!(
            store.insert(canister, &[0xFF; 32], binding(9), 10, 1),
            Err(InsertError::ChildCapacity)
        );
        store.insert(canister, &[0xFE; 32], binding(9), 20, 10).unwrap();
    }
}
