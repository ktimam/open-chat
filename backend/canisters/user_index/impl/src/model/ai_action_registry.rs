use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use types::{AiActionDefinition, TimestampMillis, UserId};

type LegacyAiActionId = u32;

/// Decode-only shape retained so upgrades from experimental fork builds do not discard stable
/// state. The retired registry is deliberately not exposed through OpenChat's public types/API.
#[derive(Clone, Serialize, Deserialize)]
struct LegacyAiActionRegistration {
    id: LegacyAiActionId,
    registered_by: UserId,
    definition: AiActionDefinition,
    created: TimestampMillis,
    updated: TimestampMillis,
}

/// Legacy heap field retained solely for stable-state compatibility.
#[derive(Serialize, Deserialize, Default)]
pub struct AiActionRegistry {
    actions: HashMap<LegacyAiActionId, LegacyAiActionRegistration>,
    next_id: LegacyAiActionId,
}
