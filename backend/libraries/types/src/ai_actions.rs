use crate::{TimestampMillis, UserId};
use candid::CandidType;
use serde::{Deserialize, Serialize};
use ts_export::ts_export;

pub type AiActionId = u32;

pub type AiAppId = u32;

/// The caller-supplied part of an AI app registration: one manifest covering the app's identity, its
/// app-level delivery key and every action it offers. Registering the same `name` again (by the same
/// owner) upserts the whole manifest, so an external app can keep itself up to date with a single call
/// from a deploy script.
#[ts_export]
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct AiAppManifest {
    /// Stable, human-readable identifier, globally unique. Re-registering a name the caller already
    /// owns upserts; a name owned by someone else is rejected (except in test_mode, where the
    /// registration re-owns the entry as a dev convenience).
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub icon_url: Option<String>,
    /// P-256 SPKI PEM: the app-level delivery key confirmed actions are encrypted/verified against.
    /// May be empty when `per_user_keys` is set — delivery then always targets the acting user's own
    /// registered key and this app-level key is never read.
    pub consumer_public_key: String,
    /// When set, each user's confirmed actions are delivered encrypted to that user's own registered
    /// key (see `AiAppUserKey`) instead of the app-level `consumer_public_key`. A user with no key
    /// registered yet must link the app first (via a one-time link code) before actions can run.
    #[serde(default)]
    pub per_user_keys: bool,
    /// The actions this app offers. A per-action `consumer_public_key`, when set, overrides the app key.
    pub actions: Vec<AiActionDefinition>,
}

/// A single user's registered delivery key for one app: when the app's manifest sets
/// `per_user_keys`, that user's confirmed actions are encrypted to this key.
#[ts_export]
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct AiAppUserKey {
    pub app_id: AiAppId,
    /// P-256 SPKI PEM public key.
    pub public_key: String,
}

/// A registered AI app. The on-chain `id`, `owner` and timestamps are assigned by the canister.
#[ts_export]
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct AiAppRegistration {
    pub id: AiAppId,
    pub owner: UserId,
    pub manifest: AiAppManifest,
    pub created: TimestampMillis,
    pub updated: TimestampMillis,
}

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
    /// Optional extraction rules that steer the model's prompt and deterministically post-process its
    /// output on the client. Absent means no rules.
    #[serde(default)]
    pub rules: Vec<AiActionRule>,
}

/// A single, generic extraction rule. Rules are declared by whoever registers the action and are
/// interpreted entirely on the client: some contribute guidance lines to the prompt, others run as a
/// deterministic post-pass over the model's structured output.
#[ts_export]
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
// Per-variant renames (NOT rename_all): candid_derive ignores `rename_all` but honors per-variant
// `serde(rename)`, while serde's Deserialize honors both — explicit renames are the only way to make
// the candid type table and the serde decode path agree on the snake_case wire labels.
pub enum AiActionRule {
    #[serde(rename = "keyword_map")]
    KeywordMap(KeywordMapRule),
    #[serde(rename = "from_message")]
    FromMessage(FromMessageRule),
    #[serde(rename = "normalize")]
    Normalize(NormalizeRule),
    #[serde(rename = "instruction")]
    Instruction(InstructionRule),
    #[serde(rename = "context")]
    Context(ContextRule),
}

/// Maps keywords found in the user's message to a fixed value for one output field.
#[ts_export]
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct KeywordMapRule {
    /// Key in the model's JSON output this rule targets.
    pub field: String,
    pub mode: RuleMode,
    pub map: Vec<KeywordMapping>,
}

/// One value and the keywords whose presence in the message selects it.
#[ts_export]
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct KeywordMapping {
    pub value: String,
    pub keywords: Vec<String>,
}

/// Whether a rule merely guides the model (`Hint`) or deterministically overrides its output (`Override`).
#[ts_export]
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
// Per-variant renames — see AiActionRule for why rename_all cannot be used with candid.
pub enum RuleMode {
    #[serde(rename = "hint")]
    Hint,
    #[serde(rename = "override")]
    Override,
}

/// Fills one output field directly from the user's message text, bypassing the model.
#[ts_export]
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct FromMessageRule {
    /// Key in the model's JSON output this rule targets.
    pub field: String,
    /// Maximum length the copied text is truncated to (defaults to 200 on the client).
    #[serde(default)]
    pub max_length: Option<u32>,
}

/// Applies deterministic normalization operations, in order, to one output field.
#[ts_export]
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct NormalizeRule {
    /// Key in the model's JSON output this rule targets.
    pub field: String,
    pub ops: Vec<NormalizeOp>,
}

/// A single normalization operation applied to a field's value.
#[ts_export]
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
// Per-variant renames — see AiActionRule for why rename_all cannot be used with candid.
pub enum NormalizeOp {
    /// Converts strings like "26k" / "1.5m" into numbers (x1e3 / x1e6).
    #[serde(rename = "k_m_suffix")]
    KMSuffix,
    /// Strips currency symbols, commas and spaces, then parses a number when possible.
    #[serde(rename = "strip_symbols")]
    StripSymbols,
    #[serde(rename = "uppercase")]
    Uppercase,
    #[serde(rename = "lowercase")]
    Lowercase,
    #[serde(rename = "trim")]
    Trim,
}

/// Free-form guidance appended verbatim to the prompt.
#[ts_export]
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct InstructionRule {
    pub text: String,
}

/// Declares contextual values the client injects into the prompt.
#[ts_export]
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct ContextRule {
    pub provide: Vec<ContextItem>,
}

/// A contextual value the client can provide to the model.
#[ts_export]
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
// Per-variant rename — see AiActionRule for why rename_all cannot be used with candid.
pub enum ContextItem {
    /// Today's date, injected as "Today is <YYYY-MM-DD>."
    #[serde(rename = "today")]
    Today,
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
