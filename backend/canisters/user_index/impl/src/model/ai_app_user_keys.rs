use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use types::{AiAppId, AiAppMemberKey, AiAppUserKey, UserId};

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

    /// Removes the key for one (user, app) pair. Returns true if a key was present. Backs
    /// `remove_my_ai_app_key` (a user disconnecting an app: after this OpenChat no longer delivers
    /// that user's confirmed actions to the app) and app-deletion cleanup. Idempotent.
    pub fn remove(&mut self, user_id: UserId, app_id: AiAppId) -> bool {
        self.keys.remove(&(user_id, app_id)).is_some()
    }

    /// Removes every entry whose registered key equals `public_key` exactly, returning how many
    /// were removed. Backs `revoke_ai_app_user_key` (the consumer app disconnecting on the user's
    /// behalf, authorized by knowledge of the PEM). Keys are per-user generated so in practice at
    /// most one entry matches.
    pub fn remove_by_key(&mut self, public_key: &str) -> u32 {
        let before = self.keys.len();
        self.keys.retain(|_, key| key != public_key);
        (before - self.keys.len()) as u32
    }

    /// The registered keys of the REQUESTED users for ONE app, in the input order (users with no
    /// key are simply absent). Backs the `ai_app_user_keys` fan-out lookup: public-key material
    /// only, so a proposer can address a confirmed action to every chat member with a key.
    pub fn keys_for_users(&self, app_id: AiAppId, user_ids: &[UserId]) -> Vec<AiAppMemberKey> {
        user_ids
            .iter()
            .filter_map(|u| {
                self.keys.get(&(*u, app_id)).map(|public_key| AiAppMemberKey {
                    user_id: *u,
                    public_key: public_key.clone(),
                })
            })
            .collect()
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
