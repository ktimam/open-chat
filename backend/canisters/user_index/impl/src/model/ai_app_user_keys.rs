use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use types::{AiAppId, AiAppUserKey, UserId};

/// Per-(user, app) delivery keys: when an app's manifest sets `per_user_keys`, each user's confirmed
/// actions are encrypted to that user's own key registered here rather than the app-level key.
/// Heap state, serialized across upgrades like the other models.
#[derive(Serialize, Deserialize, Default)]
pub struct AiAppUserKeys {
    keys: HashMap<(UserId, AiAppId), String>,
}

impl AiAppUserKeys {
    /// Upserts the key for one (user, app) pair.
    pub fn set(&mut self, user_id: UserId, app_id: AiAppId, public_key: String) {
        self.keys.insert((user_id, app_id), public_key);
    }

    /// All of one user's registered keys, ordered by app id (HashMap iteration order is arbitrary
    /// and clients present these deterministically).
    pub fn keys_for_user(&self, user_id: UserId) -> Vec<AiAppUserKey> {
        let mut keys: Vec<_> = self
            .keys
            .iter()
            .filter(|((user, _), _)| *user == user_id)
            .map(|((_, app_id), public_key)| AiAppUserKey {
                app_id: *app_id,
                public_key: public_key.clone(),
            })
            .collect();
        keys.sort_unstable_by_key(|k| k.app_id);
        keys
    }
}
