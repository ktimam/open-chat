use local_user_index_canister::LocalCommunity;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use types::{BuildVersion, CommunityId, CyclesTopUp, TimestampMillis, UserId};

#[derive(Serialize, Deserialize, Default)]
pub struct LocalCommunityMap {
    communities: HashMap<CommunityId, LocalCommunity>,
    /// Monotonic allocator for active registration epochs; deleted IDs leave no tombstones.
    #[serde(default)]
    registration_generation_counter: u64,
    #[serde(default)]
    registration_generations: HashMap<CommunityId, u64>,
}

impl LocalCommunityMap {
    pub fn add(&mut self, community_id: CommunityId, wasm_version: BuildVersion) {
        let next = self.issue_registration_generation();
        self.registration_generations.insert(community_id, next);
        let community = LocalCommunity::new(wasm_version);
        self.communities.insert(community_id, community);
    }

    pub fn delete(&mut self, community_id: &CommunityId) -> bool {
        let removed = self.communities.remove(community_id).is_some();
        if removed {
            self.registration_generations.remove(community_id);
        }
        removed
    }

    fn issue_registration_generation(&mut self) -> u64 {
        if self.registration_generation_counter == 0 {
            self.registration_generation_counter = self.registration_generations.values().copied().max().unwrap_or_default();
        }
        let next = self
            .registration_generation_counter
            .checked_add(1)
            .expect("local community registration generation exhausted");
        self.registration_generation_counter = next;
        next
    }

    pub fn registration_generation(&self, community_id: &CommunityId) -> u64 {
        self.registration_generations.get(community_id).copied().unwrap_or_default()
    }

    pub fn get(&self, community_id: &CommunityId) -> Option<&LocalCommunity> {
        self.communities.get(community_id)
    }

    pub fn get_mut(&mut self, community_id: &CommunityId) -> Option<&mut LocalCommunity> {
        self.communities.get_mut(community_id)
    }

    pub fn contains(&self, community_id: &CommunityId) -> bool {
        self.communities.contains_key(community_id)
    }

    pub fn mark_activity(&mut self, community_id: &CommunityId, timestamp: TimestampMillis) -> bool {
        if let Some(community) = self.communities.get_mut(community_id) {
            community.latest_activity = timestamp;
            community.latest_activity_per_user.clear();
            true
        } else {
            false
        }
    }

    pub fn mark_activity_for_user(&mut self, community_id: &CommunityId, user_id: UserId, timestamp: TimestampMillis) -> bool {
        if let Some(community) = self.communities.get_mut(community_id) {
            community.latest_activity_per_user.insert(user_id, timestamp);
            true
        } else {
            false
        }
    }

    pub fn mark_cycles_top_up(&mut self, community_id: &CommunityId, top_up: CyclesTopUp) -> bool {
        if let Some(community) = self.communities.get_mut(community_id) {
            community.mark_cycles_top_up(top_up);
            true
        } else {
            false
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = (&CommunityId, &LocalCommunity)> {
        self.communities.iter()
    }

    pub fn len(&self) -> usize {
        self.communities.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use candid::Principal;

    #[test]
    fn remove_and_readd_changes_the_exact_registration_generation() {
        let mut communities = LocalCommunityMap::default();
        let id = CommunityId::from(Principal::from_slice(&[64]));
        communities.add(id, BuildVersion::min());
        let first = communities.registration_generation(&id);
        assert!(communities.delete(&id));
        assert_eq!(communities.registration_generation(&id), 0);
        assert!(communities.registration_generations.is_empty());
        communities.add(id, BuildVersion::min());
        assert!(communities.registration_generation(&id) > first);
    }
}
