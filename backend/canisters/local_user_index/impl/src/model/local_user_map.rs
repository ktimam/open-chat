use candid::Principal;
use constants::MINUTE_IN_MS;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::collections::hash_map::Entry::{Occupied, Vacant};
use types::{BuildVersion, CyclesTopUp, TimestampMillis, UserId};

#[derive(Serialize, Deserialize, Default)]
pub struct LocalUserMap {
    users: HashMap<UserId, LocalUser>,
    registration_in_progress: HashMap<Principal, TimestampMillis>,
    /// Monotonic allocator for active registration epochs; deleted IDs leave no tombstones.
    #[serde(default)]
    registration_generation_counter: u64,
    #[serde(default)]
    registration_generations: HashMap<UserId, u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remove_and_readd_changes_the_exact_registration_generation() {
        let mut users = LocalUserMap::default();
        let principal = Principal::from_slice(&[65]);
        let id = UserId::from(principal);
        users.add(id, principal, BuildVersion::min(), 1);
        let first = users.registration_generation(&id);
        assert!(users.remove(&id));
        assert_eq!(users.registration_generation(&id), 0);
        assert!(users.registration_generations.is_empty());
        users.add(id, principal, BuildVersion::min(), 2);
        assert!(users.registration_generation(&id) > first);
    }
}

impl LocalUserMap {
    pub fn add(&mut self, user_id: UserId, principal: Principal, wasm_version: BuildVersion, now: TimestampMillis) {
        let next = self.issue_registration_generation();
        self.registration_generations.insert(user_id, next);
        let user = LocalUser::new(now, wasm_version);
        self.users.insert(user_id, user);
        self.registration_in_progress.remove(&principal);
    }

    pub fn get(&self, user_id: &UserId) -> Option<&LocalUser> {
        self.users.get(user_id)
    }

    pub fn get_mut(&mut self, user_id: &UserId) -> Option<&mut LocalUser> {
        self.users.get_mut(user_id)
    }

    pub fn contains(&self, user_id: &UserId) -> bool {
        self.users.contains_key(user_id)
    }

    pub fn remove(&mut self, user_id: &UserId) -> bool {
        let removed = self.users.remove(user_id).is_some();
        if removed {
            self.registration_generations.remove(user_id);
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
            .expect("local user registration generation exhausted");
        self.registration_generation_counter = next;
        next
    }

    pub fn registration_generation(&self, user_id: &UserId) -> u64 {
        self.registration_generations.get(user_id).copied().unwrap_or_default()
    }

    pub fn mark_cycles_top_up(&mut self, user_id: &UserId, top_up: CyclesTopUp) -> bool {
        if let Some(user) = self.users.get_mut(user_id) {
            user.mark_cycles_top_up(top_up);
            true
        } else {
            false
        }
    }

    pub fn mark_registration_in_progress(&mut self, principal: Principal, now: TimestampMillis) -> bool {
        match self.registration_in_progress.entry(principal) {
            Vacant(e) => {
                e.insert(now);
                true
            }
            Occupied(mut e) if *e.get() < now.saturating_sub(5 * MINUTE_IN_MS) => {
                e.insert(now);
                true
            }
            Occupied(_) => false,
        }
    }

    pub fn mark_registration_failed(&mut self, principal: &Principal) {
        self.registration_in_progress.remove(principal);
    }

    pub fn iter(&self) -> impl Iterator<Item = (&UserId, &LocalUser)> {
        self.users.iter()
    }

    pub fn len(&self) -> usize {
        self.users.len()
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
pub struct LocalUser {
    pub date_created: TimestampMillis,
    pub wasm_version: BuildVersion,
    pub upgrade_in_progress: bool,
    pub cycle_top_ups: Vec<CyclesTopUp>,
}

impl LocalUser {
    pub fn set_canister_upgrade_status(&mut self, upgrade_in_progress: bool, new_version: Option<BuildVersion>) {
        self.upgrade_in_progress = upgrade_in_progress;
        if let Some(version) = new_version {
            self.wasm_version = version;
        }
    }

    pub fn mark_cycles_top_up(&mut self, top_up: CyclesTopUp) {
        self.cycle_top_ups.push(top_up)
    }
}

impl LocalUser {
    pub fn new(now: TimestampMillis, wasm_version: BuildVersion) -> LocalUser {
        LocalUser {
            date_created: now,
            wasm_version,
            upgrade_in_progress: false,
            cycle_top_ups: Vec::new(),
        }
    }
}
