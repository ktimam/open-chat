use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use types::{AiActionDefinition, AiActionId, AiActionRegistration, TimestampMillis, UserId};

/// On-chain registry of generic "AI actions" — app-supplied configs that let a client-side model propose a
/// confirmable, authenticated in-chat action. Heap state, serialized across upgrades like the other models.
#[derive(Serialize, Deserialize, Default)]
pub struct AiActionRegistry {
    actions: HashMap<AiActionId, AiActionRegistration>,
    next_id: AiActionId,
}

impl AiActionRegistry {
    pub fn register(
        &mut self,
        registered_by: UserId,
        definition: AiActionDefinition,
        now: TimestampMillis,
    ) -> AiActionRegistration {
        // An action's name is unique per owner: re-registering the same name upserts the existing
        // entry (keeping its id and created timestamp) rather than accumulating duplicates that
        // would then shadow each other unpredictably in list()/pickAction.
        if let Some(existing) = self
            .actions
            .values_mut()
            .find(|r| r.registered_by == registered_by && r.definition.name == definition.name)
        {
            existing.definition = definition;
            existing.updated = now;
            return existing.clone();
        }

        self.next_id += 1;
        let registration = AiActionRegistration {
            id: self.next_id,
            registered_by,
            definition,
            created: now,
            updated: now,
        };
        self.actions.insert(registration.id, registration.clone());
        registration
    }

    pub fn update(
        &mut self,
        id: AiActionId,
        caller: UserId,
        definition: AiActionDefinition,
        now: TimestampMillis,
    ) -> Result<AiActionRegistration, &'static str> {
        let registration = self.actions.get_mut(&id).ok_or("ai action not found")?;
        if registration.registered_by != caller {
            return Err("caller does not own this ai action");
        }
        registration.definition = definition;
        registration.updated = now;
        Ok(registration.clone())
    }

    pub fn get(&self, id: AiActionId) -> Option<&AiActionRegistration> {
        self.actions.get(&id)
    }

    pub fn list(&self) -> Vec<AiActionRegistration> {
        // Deterministic (oldest-first) ordering — HashMap iteration order is arbitrary and clients
        // pick the first runnable action.
        let mut actions: Vec<_> = self.actions.values().cloned().collect();
        actions.sort_unstable_by_key(|r| r.id);
        actions
    }
}
