use ic_stable_structures::{
    DefaultMemoryImpl, Memory as MemoryTrait,
    memory_manager::{MemoryId, MemoryManager, VirtualMemory},
};
use std::collections::BTreeMap;

const UPGRADES: MemoryId = MemoryId::new(0);
const ACTIONS: MemoryId = MemoryId::new(1);
const IDEMPOTENCY_TOMBSTONES: MemoryId = MemoryId::new(2);
const IDEMPOTENCY_TOMBSTONE_EXPIRY: MemoryId = MemoryId::new(3);
const ACTION_EXPIRY: MemoryId = MemoryId::new(4);
const ACTION_KEY_STATS: MemoryId = MemoryId::new(5);

pub type Memory = VirtualMemory<DefaultMemoryImpl>;

thread_local! {
    static MEMORY_MANAGER: MemoryManager<DefaultMemoryImpl>
        = MemoryManager::init_with_bucket_size(DefaultMemoryImpl::default(), 16);
}

pub fn get_upgrades_memory() -> Memory {
    get_memory(UPGRADES)
}

pub fn get_actions_memory() -> Memory {
    get_memory(ACTIONS)
}

pub fn get_idempotency_tombstones_memory() -> Memory {
    get_memory(IDEMPOTENCY_TOMBSTONES)
}

pub fn get_idempotency_tombstone_expiry_memory() -> Memory {
    get_memory(IDEMPOTENCY_TOMBSTONE_EXPIRY)
}

pub fn get_action_expiry_memory() -> Memory {
    get_memory(ACTION_EXPIRY)
}

pub fn get_action_key_stats_memory() -> Memory {
    get_memory(ACTION_KEY_STATS)
}

pub fn memory_sizes() -> BTreeMap<u8, u64> {
    (0u8..=5).map(|id| (id, get_memory(MemoryId::new(id)).size())).collect()
}

fn get_memory(id: MemoryId) -> Memory {
    MEMORY_MANAGER.with(|m| m.get(id))
}
