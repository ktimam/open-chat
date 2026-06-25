use crate::{TimestampMillis, UserId};
use candid::CandidType;
use serde::{Deserialize, Serialize};
use ts_export::ts_export;

pub type AiActionId = u32;

/// A registered, reusable "AI action": a generic, app-supplied configuration that lets a client-side model
/// propose a *confirmable, authenticated* in-chat action. Nothing here is specific to any one app — the
/// prompt, output schema, card layout and delivery endpoint are all supplied by whoever registers the
/// action, so the same mechanism serves any consumer.
#[ts_export]
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct AiActionRegistration {
    pub id: AiActionId,
    pub registered_by: UserId,
    pub definition: AiActionDefinition,
    pub created: TimestampMillis,
    pub updated: TimestampMillis,
}

/// The caller-supplied part of a registration. The on-chain `id`, `registered_by` and timestamps are
/// assigned by the canister.
#[ts_export]
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct AiActionDefinition {
    /// Stable, human-readable identifier (e.g. "expense.import"), unique per owner.
    pub name: String,
    pub description: String,
    /// Prompt the on-device model is run with; the client substitutes the user's input before inference.
    pub prompt_template: String,
    /// JSON Schema the model's structured output must conform to.
    pub response_schema: String,
    /// How to turn the model's output into a confirmable card shown to the user.
    pub card: AiActionCardTemplate,
    /// Where a confirmed action is delivered — the consumer's signed webhook endpoint.
    pub endpoint: String,
    /// Optional public key (PEM) the consumer advertises so the payload can be verified end-to-end.
    pub consumer_public_key: Option<String>,
}

/// Generic, app-agnostic template describing the confirmable card produced from the model's output.
#[ts_export]
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct AiActionCardTemplate {
    pub title: String,
    pub confirm_label: String,
    pub cancel_label: String,
    pub rows: Vec<AiActionCardRowTemplate>,
    pub disclosure: Option<String>,
}

#[ts_export]
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct AiActionCardRowTemplate {
    /// Key in the model's JSON output to read this row's value from.
    pub field: String,
    /// Human-readable label shown on the card row.
    pub label: String,
}
