use local_user_index_canister::LocalGroup;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use types::{BuildVersion, ChatId, CyclesTopUp, TimestampMillis, UserId};

#[derive(Serialize, Deserialize, Default)]
pub struct LocalGroupMap {
    groups: HashMap<ChatId, LocalGroup>,
    /// Monotonic allocator for active registration epochs. Keeping only active per-child entries
    /// avoids an unbounded tombstone map when groups are repeatedly created and deleted.
    #[serde(default)]
    registration_generation_counter: u64,
    #[serde(default)]
    registration_generations: HashMap<ChatId, u64>,
}

impl LocalGroupMap {
    pub fn add(&mut self, chat_id: ChatId, wasm_version: BuildVersion) {
        let next = self.issue_registration_generation();
        self.registration_generations.insert(chat_id, next);
        let group = LocalGroup::new(wasm_version);
        self.groups.insert(chat_id, group);
    }

    pub fn delete(&mut self, chat_id: &ChatId) -> bool {
        let removed = self.groups.remove(chat_id).is_some();
        if removed {
            self.registration_generations.remove(chat_id);
        }
        removed
    }

    fn issue_registration_generation(&mut self) -> u64 {
        // Compatibility with any unshipped intermediate snapshot that had per-child generations
        // but no allocator counter.
        if self.registration_generation_counter == 0 {
            self.registration_generation_counter = self.registration_generations.values().copied().max().unwrap_or_default();
        }
        let next = self
            .registration_generation_counter
            .checked_add(1)
            .expect("local group registration generation exhausted");
        self.registration_generation_counter = next;
        next
    }

    pub fn registration_generation(&self, chat_id: &ChatId) -> u64 {
        self.registration_generations.get(chat_id).copied().unwrap_or_default()
    }

    pub fn get(&self, chat_id: &ChatId) -> Option<&LocalGroup> {
        self.groups.get(chat_id)
    }

    pub fn get_mut(&mut self, chat_id: &ChatId) -> Option<&mut LocalGroup> {
        self.groups.get_mut(chat_id)
    }

    pub fn contains(&self, chat_id: &ChatId) -> bool {
        self.groups.contains_key(chat_id)
    }

    pub fn mark_activity(&mut self, chat_id: &ChatId, timestamp: TimestampMillis) -> bool {
        if let Some(group) = self.groups.get_mut(chat_id) {
            group.latest_activity = timestamp;
            group.latest_activity_per_user.clear();
            true
        } else {
            false
        }
    }

    pub fn mark_activity_for_user(&mut self, chat_id: &ChatId, user_id: UserId, timestamp: TimestampMillis) -> bool {
        if let Some(group) = self.groups.get_mut(chat_id) {
            group.latest_activity_per_user.insert(user_id, timestamp);
            true
        } else {
            false
        }
    }

    pub fn mark_cycles_top_up(&mut self, chat_id: &ChatId, top_up: CyclesTopUp) -> bool {
        if let Some(group) = self.groups.get_mut(chat_id) {
            group.mark_cycles_top_up(top_up);
            true
        } else {
            false
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = (&ChatId, &LocalGroup)> {
        self.groups.iter()
    }

    pub fn len(&self) -> usize {
        self.groups.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use candid::Principal;

    #[test]
    fn remove_and_readd_changes_the_exact_registration_generation() {
        let mut groups = LocalGroupMap::default();
        let id = ChatId::from(Principal::from_slice(&[63]));
        groups.add(id, BuildVersion::min());
        let first = groups.registration_generation(&id);
        assert!(groups.delete(&id));
        assert_eq!(groups.registration_generation(&id), 0);
        assert!(groups.registration_generations.is_empty());
        groups.add(id, BuildVersion::min());
        assert!(groups.registration_generation(&id) > first);
    }
}
