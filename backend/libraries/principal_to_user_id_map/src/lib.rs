use ic_principal::Principal;
use serde::{Deserialize, Serialize};
use stable_memory_map::{LazyValue, PrincipalKeyPrefix, StableMemoryMap};
use types::UserId;

#[derive(Serialize, Deserialize)]
pub struct PrincipalToUserIdMap {
    prefix: PrincipalKeyPrefix,
    count: u32,
    /// Monotonic authorization epoch used to reject principal remap ABA across awaits.
    #[serde(default)]
    generation: u64,
}

impl StableMemoryMap<PrincipalKeyPrefix, UserId> for PrincipalToUserIdMap {
    fn prefix(&self) -> &PrincipalKeyPrefix {
        &self.prefix
    }

    fn value_to_bytes(value: UserId) -> Vec<u8> {
        value.as_slice().to_vec()
    }

    fn bytes_to_value(_key: &Principal, bytes: Vec<u8>) -> UserId {
        UserId::from(Principal::from_slice(&bytes))
    }

    fn on_inserted(&mut self, _key: &Principal, existing: &Option<LazyValue<Principal, UserId>>) {
        self.bump_generation();
        if existing.is_none() {
            self.count = self.count.saturating_add(1);
        }
    }

    fn on_removed(&mut self, _key: &Principal, _removed: &LazyValue<Principal, UserId>) {
        self.bump_generation();
        self.count = self.count.saturating_sub(1);
    }
}

impl PrincipalToUserIdMap {
    fn bump_generation(&mut self) {
        self.generation = self
            .generation
            .checked_add(1)
            .expect("principal authorization generation exhausted");
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn len(&self) -> u32 {
        self.count
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }
}

impl Default for PrincipalToUserIdMap {
    fn default() -> Self {
        PrincipalToUserIdMap {
            prefix: PrincipalKeyPrefix::new_for_principal_to_user_id_map(),
            count: 0,
            generation: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorization_generation_is_monotonic_and_fails_closed_on_exhaustion() {
        let mut map = PrincipalToUserIdMap::default();
        assert_eq!(map.generation(), 0);
        map.bump_generation();
        assert_eq!(map.generation(), 1);
        map.generation = u64::MAX;
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| map.bump_generation())).is_err());
        assert_eq!(map.generation(), u64::MAX);
    }
}
