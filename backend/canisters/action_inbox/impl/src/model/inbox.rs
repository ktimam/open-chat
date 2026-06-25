use action_inbox_canister::actions::StoredAction;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use std::collections::{BTreeMap, HashSet};
use types::TimestampMillis;

// Append-only store of opaque, encrypted confirmed actions, keyed by the consumer-key fingerprint. This
// canister never decrypts or interprets anything; it stores ciphertext + a platform signature.
#[derive(Serialize, Deserialize, Default)]
pub struct Inbox {
    actions: BTreeMap<Vec<u8>, Vec<StoredAction>>,
    seen: HashSet<(Vec<u8>, u64)>,
    next_id: u64,
}

impl Inbox {
    #[allow(clippy::too_many_arguments)]
    pub fn deposit(
        &mut self,
        fingerprint: Vec<u8>,
        idempotency_id: u64,
        ephemeral_public_key: ByteBuf,
        ciphertext: ByteBuf,
        oc_signature: ByteBuf,
        created_at: TimestampMillis,
    ) -> bool {
        if !self.seen.insert((fingerprint.clone(), idempotency_id)) {
            return false;
        }
        self.next_id += 1;
        let action = StoredAction { id: self.next_id, ephemeral_public_key, ciphertext, oc_signature, created_at };
        self.actions.entry(fingerprint).or_default().push(action);
        true
    }

    pub fn query(&self, fingerprint: &[u8], since_id: u64, max_results: usize) -> Vec<StoredAction> {
        self.actions
            .get(fingerprint)
            .map(|v| v.iter().filter(|a| a.id > since_id).take(max_results).cloned().collect())
            .unwrap_or_default()
    }
}
