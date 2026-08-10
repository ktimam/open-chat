// Generic in-OpenChat AI-action runner.
//
// A registered app declares an AiAction (prompt + output schema + a card template + delivery metadata).
// The runner takes a message's content (image/text), runs the
// user's selected ON-DEVICE model against the declared prompt, parses the structured result, and builds a
// confirmable ActionCard whose rows come from the template. Nothing here is app-specific — every
// app-specific value comes from the registration. At confirmation the canisters use immutable app
// provenance plus authoritative membership to resolve the inbox and recipient keys; card-carried
// routing fields remain compatibility data, never authority.

import { Principal } from "@icp-sdk/core/principal";
import type { ActionCardContent, ActionCardRow, ChatIdentifier } from "./chat/chat";
import type { InferenceRequest, InferenceResult } from "./onDeviceModel";

// These are defense-in-depth limits at the untrusted manifest/model boundary. The registry enforces
// compatible per-field bounds, but clients must remain safe when reading legacy, cached, or malformed
// data and when a model emits an unexpectedly large candidate list.
export const MAX_AI_ACTION_CANDIDATES = 32;
// These byte/character ceilings mirror the card-attestation and chat-ingress protocol. Keep them
// client-visible so a model/manual extraction fails before provenance is minted instead of relying
// on a later canister rejection for limits the browser can compute exactly.
export const MAX_AI_ACTION_CARD_TITLE_CHARS = 200;
export const MAX_AI_ACTION_CARD_ROW_VALUE_CHARS = 4_096;
export const MAX_AI_APP_CONFIRM_PAYLOAD_BYTES = 16 * 1_024;
export const MAX_ATTESTED_ACTION_CARD_BYTES = 64 * 1_024;
const MAX_AI_ACTION_MODEL_OUTPUT_CHARS = 131_072;
const MAX_AI_ACTION_RULES = 20;
const MAX_AI_ACTION_KEYWORD_MAPPINGS = 50;
const MAX_AI_ACTION_KEYWORDS_PER_MAPPING = 50;
const MAX_AI_ACTION_KEYWORD_CHECKS = 500;
const MAX_AI_ACTION_RULE_STRING_LENGTH = 64;
const MAX_AI_ACTION_INSTRUCTION_LENGTH = 1_000;
const MAX_AI_ACTION_MESSAGE_SCAN_CHARS = 10_000;
const MAX_AI_ACTION_FROM_MESSAGE_LENGTH = 2_000;
const MAX_AI_ACTION_CARD_ROWS = 32;
const MAX_AI_ACTION_CARD_LABEL_LENGTH = 128;
const SAFE_AI_ACTION_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const AI_ACTION_WORD_CHAR = /[\p{L}\p{N}]/u;
const DISPLAY_CONTROL = /[\p{Cc}\p{Cf}]/u;
const FORBIDDEN_AI_ACTION_FIELDS = new Set(["__proto__", "prototype", "constructor"]);

export function isSafeAiActionFieldName(field: string): boolean {
    return SAFE_AI_ACTION_FIELD.test(field) && !FORBIDDEN_AI_ACTION_FIELDS.has(field);
}

function normalizedCardRows(
    rows: readonly AiActionCardRowTemplate[],
): AiActionCardRowTemplate[] | undefined {
    if (rows.length === 0 || rows.length > MAX_AI_ACTION_CARD_ROWS) return undefined;
    const labels = new Set<string>();
    const fields = new Set<string>();
    const normalized: AiActionCardRowTemplate[] = [];
    for (const row of rows) {
        const label = row.label.trim();
        if (
            !isSafeAiActionFieldName(row.valueKey) ||
            label.length === 0 ||
            label.length > MAX_AI_ACTION_CARD_LABEL_LENGTH ||
            DISPLAY_CONTROL.test(label) ||
            label.startsWith("__oc_") ||
            labels.has(label) ||
            fields.has(row.valueKey)
        ) {
            return undefined;
        }
        labels.add(label);
        fields.add(row.valueKey);
        normalized.push({ label, valueKey: row.valueKey });
    }
    return normalized;
}

// A row of the card, declaratively bound to a key in the model's structured output.
export interface AiActionCardRowTemplate {
    label: string;
    // The key in the extracted JSON object whose value fills this row.
    valueKey: string;
}

export interface AiActionCardTemplate {
    title: string;
    rows: AiActionCardRowTemplate[];
    confirmLabel: string;
    cancelLabel: string;
    disclosure?: string;
}

// Declarative extraction rules a registering app can attach to its action. Rules serve two purposes:
// they compile into prompt guidance for the model (compileRules) and they run as a deterministic
// post-pass over the model's extraction (applyRulesPostPass). All rules are generic — field names,
// values and keywords come from the registration.
export type AiActionRuleMode = "hint" | "override";
export type AiActionNormalizeOp =
    | "k_m_suffix"
    | "strip_symbols"
    | "uppercase"
    | "lowercase"
    | "trim";
export type AiActionRule =
    | {
          kind: "keyword_map";
          field: string;
          mode: AiActionRuleMode;
          map: { value: string; keywords: string[] }[];
      }
    | { kind: "from_message"; field: string; maxLength?: number }
    | { kind: "normalize"; field: string; ops: AiActionNormalizeOp[] }
    | { kind: "instruction"; text: string }
    // Optional non-source context. `today` is supplied only alongside nonempty text evidence; it is
    // never injected into an image-only prompt where a model could mistake it for visible content.
    | { kind: "context"; provide: "today"[] };

// The frontend mirror of the on-chain AiActionDefinition (types/src/ai_actions.rs). All values are supplied by
// the registering app; OpenChat treats them opaquely.
export interface AiActionDefinition {
    // Stable id, used as the card's actionId.
    name: string;
    description: string;
    // CALLER-SUPPLIED extraction prompt handed verbatim to the on-device model.
    promptTemplate: string;
    // Optional JSON schema the model is asked (best-effort) to conform to.
    responseSchema?: object;
    card: AiActionCardTemplate;
    // Optional legacy webhook (relay path); unused for the on-chain inbox delivery.
    endpoint?: string;
    // P-256 SPKI PEM — the recipient OpenChat encrypts confirmed actions to. Required for inbox delivery.
    consumerPublicKey?: string;
    // Optional extraction rules (absent === []).
    rules?: AiActionRule[];
    // True if the action can extract from an IMAGE message; drives the auto-propose image chip
    // (only image-capable actions are offered on images). Absent === false (the mapper defaults it).
    acceptsImage?: boolean;
}

// --- AI-app directory (Phase A) --------------------------------------------------------------------------------
// An app registers ONE manifest (name, description, delivery key, its actions) with the user_index; chat
// owners/admins then enable the app per chat. The manifest-level consumerPublicKey is the app's delivery
// key; an action's own consumerPublicKey, when set, overrides it.

// How OpenChat presents a declared surface.
//   "sheet"    = embedded in-app (an iframe hosted in a bottom sheet)
//   "external" = opened in the system browser / a new tab
export type AiAppSurfaceDisplay = "sheet" | "external";

// The frontend mirror of the on-chain AiAppSurface (types/src/ai_actions.rs): a URL OpenChat can open
// on the app's behalf. `kind` says what the surface is for — "chat_link" = configure/link a chat inside
// the app (OpenChat opens it after the first confirmed action in a chat); other kinds are app-defined
// and OpenChat ignores kinds it does not know. The URL may contain only the public {appId}
// placeholder. Raw chat/message/user coordinates are never substituted into external URLs.
export interface AiAppSurface {
    kind: string;
    url: string;
    display: AiAppSurfaceDisplay;
}

// Canonical, generic rendering of a chat identity for surface URLs. MUST byte-match the backend
// renderer (backend/canisters/local_user_index/impl/src/action_deposit_envelope.rs `chat_key`) because
// apps correlate this value with the delivery provenance (`context.chat`) of confirmed actions:
//   "group:<group canister principal text>"
//   "channel:<community canister principal text>:<channel id decimal>"
// Direct chats bind the sorted pair of viewer + counterpart. This makes the same logical chat
// byte-identical from both participants' perspectives without exposing a session credential.
export type AiAppCardChatContext =
    | { kind: "group"; groupId: string }
    | { kind: "channel"; communityId: string; channelId: number }
    | { kind: "direct"; userIds: [string, string] };

function comparePrincipalBytes(left: string, right: string): number {
    const a = Principal.fromText(left).toUint8Array();
    const b = Principal.fromText(right).toUint8Array();
    const length = Math.min(a.length, b.length);
    for (let i = 0; i < length; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return a.length - b.length;
}

export function aiAppCardChatContext(
    chatId: ChatIdentifier,
    currentUserId: string,
): AiAppCardChatContext | undefined {
    switch (chatId.kind) {
        case "group_chat":
            return { kind: "group", groupId: chatId.groupId };
        case "channel":
            return {
                kind: "channel",
                communityId: chatId.communityId,
                channelId: chatId.channelId,
            };
        case "direct_chat": {
            if (currentUserId === chatId.userId) return undefined;
            try {
                const userIds = [currentUserId, chatId.userId].sort(comparePrincipalBytes) as [
                    string,
                    string,
                ];
                return { kind: "direct", userIds };
            } catch {
                return undefined;
            }
        }
    }
}

export function chatKeyFor(chatId: ChatIdentifier, currentUserId?: string): string | undefined {
    switch (chatId.kind) {
        case "group_chat":
            return `group:${chatId.groupId}`;
        case "channel":
            return `channel:${chatId.communityId}:${chatId.channelId}`;
        case "direct_chat":
            // Both participants derive the same sorted two-principal identity. Missing viewer
            // context fails closed rather than falling back to the old ambiguous counterpart key.
            if (currentUserId === undefined) return undefined;
            const context = aiAppCardChatContext(chatId, currentUserId);
            return context?.kind === "direct"
                ? `direct:${context.userIds[0]}:${context.userIds[1]}`
                : undefined;
    }
}

// The frontend mirror of the on-chain AiAppManifest (types/src/ai_actions.rs).
export interface AiAppManifest {
    // Unique per owner; the stable id used for upsert-by-(owner, name).
    name: string;
    description: string;
    iconUrl?: string;
    // P-256 SPKI PEM: the app-level delivery key confirmed actions are encrypted to.
    consumerPublicKey: string;
    // When true, each user's confirmed actions are delivered encrypted to THAT user's own registered
    // key (see AiAppUserKey) instead of the manifest/action key; a user with no registered key must
    // first pair via a link code. Absent === false (legacy single-key delivery).
    perUserKeys?: boolean;
    actions: AiActionDefinition[];
    // Surfaces the app declares (absent === []).
    surfaces?: AiAppSurface[];
    // Optional per-app inbox canister (text principal, decoded by the agent layer). When set, the
    // card-builder routes this app's confirmed actions here instead of the global action_inbox.
    inboxCanisterId?: string;
}

// The frontend mirror of the on-chain AiAppRegistration returned by bounded UserIndex app queries.
export interface AiAppRegistration {
    id: number;
    owner: string;
    manifest: AiAppManifest;
    created: bigint;
    updated: bigint;
    // Directory visibility (Phase B): unpublished apps are visible only to their owner.
    published: boolean;
}

// The calling user's own registered delivery key for one app, as the user_index `my_ai_app_keys`
// query returns it. For a per-user-keys app this key (not the manifest key) is the effective
// recipient of that user's confirmed actions.
export interface AiAppUserKey {
    appId: number;
    publicKey: string;
}

// One row of the guarded user_index `ai_app_user_keys` C2C lookup: a chat MEMBER's registered
// delivery key for one app. The local_user_index requests these at confirmation using member ids
// supplied by the authoritative chat canister; browser callers cannot enumerate another user's keys.
export interface AiAppMemberKey {
    userId: string;
    publicKey: string;
}

// A one-time high-entropy claim token (user_index `create_ai_app_link_code`): the user enters it in
// the app, whose exact registered app canister calls `c2c_claim_ai_app_link_code` with the code and
// public key. Success returns `{ app_subject, subject_version, app_id, app_revision, app_canister_id,
// key_version }`; the app must retain that exact app-scoped binding tuple. Revocation sends the same
// app-subject/app/key_version/public-key tuple,
// a fresh timestamp, and its 64-byte P-256 proof to `revoke_ai_app_user_key`. The deprecated public
// `claim_ai_app_link_code` method is never an integration path. The code is single-use and expires at
// `expiresAt` (epoch millis).
export interface AiAppLinkCode {
    code: string;
    expiresAt: bigint;
}

// A short-lived, one-time bearer minted by the authoritative chat canister for one exact
// app/revision/chat tuple. The raw 32 bytes are kept only long enough to build or cancel the
// chat_link URL; they must never be persisted or logged.
export interface AiAppChatLinkToken {
    token: Uint8Array;
    expiresAt: bigint;
}

// Short-lived, viewer/card/recipient-key-bound authority for a private app-card context. The UI
// represents the opaque token as unpadded base64url solely for delivery to the exact sandboxed
// WindowProxy after source + opaque-origin + per-load nonce checks.
export interface AppScopedCardContext {
    contextVersion: 1;
    appSubject: string;
    chatHandle: string;
    messageHandle: string;
    appId: number;
    appRevision: bigint;
    actionId: string;
}

export interface AiAppCardCapability {
    capability: string;
    expiresAt: bigint;
    context: AppScopedCardContext;
}

// The browser envelope deliberately mirrors a card capability, while this named alias makes the
// isolated private-match mint/redeem path explicit at its call sites.
export type AiAppPrivateMatchCapability = AiAppCardCapability;

// Opaque one-time server/app attestation over one exact final confirmation payload. Kept as raw
// bytes because the client returns it only to the authoritative chat canister alongside the exact
// payload bytes; it is never exposed to the iframe, URL, storage, or logs.
export interface AiAppCardConfirmationGrant {
    grant: Uint8Array;
    expiresAt: bigint;
}

export interface AiAppCardProvenance {
    provenance: Uint8Array;
    expiresAt: bigint;
}

// Exact sender-visible and confirmable V1 content vouched for by the registered app canister before
// UserIndex mints card provenance. Authenticated viewer/chat/message/app coordinates are supplied by
// UserIndex; routing, recipient keys, provenance, and private context are deliberately excluded.
export interface AiAppCardContentV1 {
    title: string;
    rows: ActionCardRow[];
    confirmLabel: string;
    cancelLabel: string;
    actionId: string;
    disclosure?: string;
    expiresAt?: bigint;
    confirmPayload?: Uint8Array;
}

export type RunAiActionResult =
    | { kind: "ready"; card: ActionCardContent; extracted: Record<string, unknown> }
    // Several valid entries extracted from one message: one card with one frozen JSON-array payload.
    | { kind: "ready_multi"; card: ActionCardContent; extracted: Record<string, unknown>[] }
    // No native runtime / no model selected — the caller must degrade gracefully (no autonomous fallback).
    | { kind: "unavailable"; reason: string }
    // The input contains image bytes, but this app action did not opt into image extraction.
    | { kind: "image_not_accepted" }
    // The model ran but produced nothing parseable as the declared structured output.
    | { kind: "no_extraction"; raw: string }
    // Structured output existed, but at least one candidate lacked an app-required field.
    | {
          kind: "incomplete_extraction";
          raw: string;
          missingFields: string[];
          candidateCount: number;
          validCandidateCount: number;
      }
    | { kind: "error"; error: string };

function formatValue(v: unknown): string {
    if (v === undefined || v === null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
    return JSON.stringify(v);
}

// Tolerantly pull the first JSON object out of a model's text (it may wrap it in prose or ```json fences).
export function parseExtraction(text: string): Record<string, unknown> | undefined {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : text;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try {
        const obj: unknown = JSON.parse(candidate.slice(start, end + 1));
        return obj !== null && typeof obj === "object"
            ? (obj as Record<string, unknown>)
            : undefined;
    } catch {
        return undefined;
    }
}

// Tolerantly pull a LIST of candidate objects out of a model's text. The model may emit either a
// single object (one transaction) or a JSON ARRAY of objects (several transactions in one message).
// An array that opens before any bare object is treated as the multi-entry form; only its object
// elements are kept. Anything else falls back to the single-object parse (wrapped in a one-element
// list), so the single-entry path is byte-identical to `parseExtraction`. Returns undefined when
// nothing object-shaped is found.
export function parseExtractionList(text: string): Record<string, unknown>[] | undefined {
    if (text.length > MAX_AI_ACTION_MODEL_OUTPUT_CHARS) return undefined;
    // Scan the WHOLE reply. Every earlier version stopped at the first promising REGION and kept only
    // what it found there, which is how three transactions arrived as two:
    //
    //   - the fence match was non-greedy, so a model emitting TWO ```json blocks had only its first
    //     one read;
    //   - the array fast path returned the moment one array parsed cleanly, so an afterthought object
    //     past the "]" ("[{a},{b}] and also {c}") was never looked at.
    //
    // Both dropped entries in SILENCE — the card simply had fewer rows than the message had amounts,
    // which nobody notices unless they count. scanJsonObjects tracks BRACE depth only, so "[" and "]"
    // never move it: array elements are already found as top-level objects and the fast path bought
    // nothing this does not. Fence markers carry no braces either, so reading straight through them
    // costs nothing and recovers transactions stranded outside the fence.
    //
    // Degrades exactly as before on a truncated generation (the unterminated tail object is dropped,
    // the completed ones survive) and on trailing commas between elements.
    // Keep one overflow sentinel (33) so the runner can distinguish "too many" from the valid
    // 32-candidate boundary, then stop before rules/schema/card work is performed for attacker-sized
    // output. Wrapper objects are bounded too; `flatMap` here previously expanded each nested list.
    const scanned: Record<string, unknown>[] = [];
    for (const object of scanJsonObjects(text)) {
        for (const entry of unwrapEntryList(object)) {
            scanned.push(entry);
            if (scanned.length > MAX_AI_ACTION_CANDIDATES) return scanned;
        }
    }
    if (scanned.length > 0) return scanned;
    // Last resort: parseExtraction slices from the first "{" to the last "}". It cannot handle a
    // multi-object emission, but it does salvage a lone object the scanner could not balance.
    const obj = parseExtraction(text);
    return obj === undefined ? undefined : [obj];
}

// A model asked for "a JSON array of transactions" often returns that array under a KEY instead:
// {"transactions":[{…},{…},{…}]}. The scanner sees ONE top-level object (the inner ones are nested),
// so the whole message used to extract to a single candidate — which then failed the required-field
// gate, because a wrapper has no amount, and surfaced as a long wait ending in "nothing to process".
//
// Unwrapped only for the unambiguous shape: exactly one property, holding a non-empty array of
// objects. A real extraction carries more than one field, so this cannot swallow one. Something like
// {"schedule":[…]} would be unwrapped too, but a bare schedule is not a valid entry either way — the
// same required-field gate drops it before and after.
function unwrapEntryList(obj: Record<string, unknown>): Record<string, unknown>[] {
    const values = Object.values(obj);
    if (values.length !== 1 || !Array.isArray(values[0])) return [obj];
    const objs: Record<string, unknown>[] = [];
    for (const entry of values[0]) {
        if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
            objs.push(entry as Record<string, unknown>);
            if (objs.length > MAX_AI_ACTION_CANDIDATES) break;
        }
    }
    return objs.length > 0 ? objs : [obj];
}

// Collect every balanced top-level {...} substring that parses as a JSON object, in order.
// String-aware (a brace inside a quoted value must not move the depth) and escape-aware, so a note
// like {"note":"paid 50 } later"} does not derail the scan. An unterminated trailing object is simply
// dropped — which is what makes a truncated generation degrade to "the objects that DID complete"
// instead of to nothing.
function scanJsonObjects(text: string): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
        } else if (ch === "{") {
            if (depth === 0) start = i;
            depth++;
        } else if (ch === "}") {
            if (depth > 0) {
                depth--;
                if (depth === 0 && start >= 0) {
                    try {
                        const parsed: unknown = JSON.parse(text.slice(start, i + 1));
                        if (
                            parsed !== null &&
                            typeof parsed === "object" &&
                            !Array.isArray(parsed)
                        ) {
                            out.push(parsed as Record<string, unknown>);
                            if (out.length > MAX_AI_ACTION_CANDIDATES) return out;
                        }
                    } catch {
                        // a malformed object is skipped; the others still count
                    }
                    start = -1;
                }
            }
        }
    }
    return out;
}

// --- Rules ---------------------------------------------------------------------------------------------------

function isBoundedRuleString(value: string): boolean {
    return (
        value.length > 0 &&
        value.length <= MAX_AI_ACTION_RULE_STRING_LENGTH &&
        !DISPLAY_CONTROL.test(value)
    );
}

// Sanitize even domain-typed rules: values may originate in legacy/cached registry entries or a
// programmatic caller that bypassed the wire mapper. The aggregate keyword budget bounds both prompt
// construction and deterministic message scans across all rules.
function boundedRules(rules: readonly AiActionRule[]): AiActionRule[] {
    const bounded: AiActionRule[] = [];
    let remainingKeywords = MAX_AI_ACTION_KEYWORD_CHECKS;
    for (const rule of rules.slice(0, MAX_AI_ACTION_RULES)) {
        switch (rule.kind) {
            case "instruction":
                if (rule.text.length <= MAX_AI_ACTION_INSTRUCTION_LENGTH) bounded.push(rule);
                break;
            case "context":
                bounded.push({
                    kind: "context",
                    provide: rule.provide.filter((p) => p === "today"),
                });
                break;
            case "from_message":
                if (isSafeAiActionFieldName(rule.field)) {
                    const maxLength =
                        rule.maxLength === undefined || !Number.isFinite(rule.maxLength)
                            ? undefined
                            : Math.min(
                                  MAX_AI_ACTION_FROM_MESSAGE_LENGTH,
                                  Math.max(0, Math.trunc(rule.maxLength)),
                              );
                    bounded.push({ kind: "from_message", field: rule.field, maxLength });
                }
                break;
            case "normalize":
                if (isSafeAiActionFieldName(rule.field)) {
                    bounded.push({
                        kind: "normalize",
                        field: rule.field,
                        ops: rule.ops
                            .filter((op) => NORMALIZE_OPS.includes(op))
                            .slice(0, NORMALIZE_OPS.length),
                    });
                }
                break;
            case "keyword_map": {
                if (!isSafeAiActionFieldName(rule.field) || remainingKeywords === 0) break;
                const map: { value: string; keywords: string[] }[] = [];
                for (const mapping of rule.map.slice(0, MAX_AI_ACTION_KEYWORD_MAPPINGS)) {
                    if (!isBoundedRuleString(mapping.value) || remainingKeywords === 0) continue;
                    const keywords: string[] = [];
                    for (const keyword of mapping.keywords.slice(
                        0,
                        MAX_AI_ACTION_KEYWORDS_PER_MAPPING,
                    )) {
                        if (remainingKeywords === 0) break;
                        if (!isBoundedRuleString(keyword)) continue;
                        keywords.push(keyword);
                        remainingKeywords--;
                    }
                    if (keywords.length > 0) map.push({ value: mapping.value, keywords });
                }
                if (map.length > 0) {
                    bounded.push({ kind: "keyword_map", field: rule.field, mode: rule.mode, map });
                }
                break;
            }
        }
    }
    return bounded;
}

// Compile the declared rules into prompt guidance lines. Only rules that need the model's cooperation
// produce a line — normalize is deterministic (post-pass only), while context/today is conditionally
// supplied by runAiAction when the invocation also carries nonempty text evidence. `from_message`
// guidance is likewise meaningful only when message text exists; image-only extraction has no source
// text for its deterministic post-pass to copy.
export function compileRules(
    rules: AiActionRule[],
    options: { hasMessageText?: boolean } = {},
): string[] {
    const lines: string[] = [];
    const hasMessageText = options.hasMessageText ?? true;
    for (const rule of boundedRules(rules)) {
        switch (rule.kind) {
            case "instruction":
                lines.push(rule.text);
                break;
            case "keyword_map":
                for (const m of rule.map) {
                    lines.push(
                        `Set "${rule.field}" to "${m.value}" when the message mentions any of: ${m.keywords.join(", ")}`,
                    );
                }
                break;
            case "from_message":
                if (hasMessageText) {
                    lines.push(`Set "${rule.field}" to a short phrase taken from the message.`);
                }
                break;
            case "normalize":
            case "context":
                break;
        }
    }
    return lines;
}

// "26k" / "1.5m" (optional commas/spaces) -> number; plain numeric strings -> number; real numbers
// untouched. The number is matched at the START of the string, tolerating trailing text a model may
// append — most importantly a currency code folded into the amount: "2000 usd" / "2000usd" -> 2000.
// Without this, such a value stays a string and the schema-conformance pass DROPS it (a `number` field
// can't hold a string), so the consumer receives no amount at all. Anchored at `^` so a number is never
// plucked from the middle of a word.
function normalizeKMSuffix(v: unknown): unknown {
    if (typeof v !== "string") return v;
    const compact = v.trim().replace(/[,\s]/g, "");
    const m = compact.match(/^([+-]?\d+(?:\.\d+)?)([kKmM])?/);
    if (m === null) return v;
    const n = parseFloat(m[1]);
    if (Number.isNaN(n)) return v;
    const suffix = m[2]?.toLowerCase();
    if (suffix === "k") return n * 1e3;
    if (suffix === "m") return n * 1e6;
    return n;
}

// Strip currency symbols / commas / spaces from a string, then parse as a number when what remains is numeric.
function normalizeStripSymbols(v: unknown): unknown {
    if (typeof v !== "string") return v;
    const stripped = v.replace(/[\p{Sc},\s]/gu, "");
    return /^[+-]?\d+(?:\.\d+)?$/.test(stripped) ? parseFloat(stripped) : stripped;
}

function applyNormalizeOp(op: AiActionNormalizeOp, v: unknown): unknown {
    switch (op) {
        case "k_m_suffix":
            return normalizeKMSuffix(v);
        case "strip_symbols":
            return normalizeStripSymbols(v);
        case "uppercase":
            return typeof v === "string" ? v.toUpperCase() : v;
        case "lowercase":
            return typeof v === "string" ? v.toLowerCase() : v;
        case "trim":
            return typeof v === "string" ? v.trim() : v;
    }
}

function isStrictCalendarDate(value: string): boolean {
    if (value.length !== 10 || value[4] !== "-" || value[7] !== "-") return false;
    for (let index = 0; index < value.length; index++) {
        if (index === 4 || index === 7) continue;
        const code = value.charCodeAt(index);
        if (code < 48 || code > 57) return false;
    }
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    if (year < 1 || month < 1 || month > 12 || day < 1) return false;
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day <= daysInMonth[month - 1];
}

function conformsToSafeStringFormat(format: unknown, value: string): boolean {
    switch (format) {
        case "date":
            return isStrictCalendarDate(value);
        case "ascii-uppercase":
            return [...value].every((character) => {
                const code = character.charCodeAt(0);
                return code >= 65 && code <= 90;
            });
        case "no-nul":
            return !value.includes(String.fromCharCode(0));
        case "utf8-no-nul": {
            // JavaScript strings may contain lone UTF-16 surrogates, but Rust/serde strings and
            // Candid text are Unicode scalar values. Reject them here so exact-card provenance
            // cannot be minted for bytes the app boundary is structurally unable to decode.
            for (let index = 0; index < value.length; index++) {
                const code = value.charCodeAt(index);
                if (code === 0) return false;
                if (code >= 0xd800 && code <= 0xdbff) {
                    if (index + 1 >= value.length) return false;
                    const next = value.charCodeAt(index + 1);
                    if (next < 0xdc00 || next > 0xdfff) return false;
                    index++;
                } else if (code >= 0xdc00 && code <= 0xdfff) {
                    return false;
                }
            }
            return true;
        }
        default:
            // JSON Schema permits implementation-defined formats. Unknown formats remain annotations.
            return true;
    }
}

// Tiny local schema conformance pass (type/enum/numeric bounds, bounded string lengths, standard
// format: "date", and deterministic allowlisted string formats only — deliberately not a full
// JSON-schema validator and no added dependency). utf8-no-nul additionally keeps exact payloads
// representable at Rust/Candid app boundaries. Drops keys the schema doesn't declare and DELETES
// fields that violate their declared constraint: visible omission beats silent wrongness.
function conformToSchema(
    extracted: Record<string, unknown>,
    schema: object | undefined,
): Record<string, unknown> {
    if (schema === undefined) return extracted;
    const props: unknown = (schema as { properties?: unknown }).properties;
    if (props === null || typeof props !== "object" || Array.isArray(props)) return extracted;
    const properties = props as Record<string, unknown>;
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of Object.entries(extracted)) {
        if (!isSafeAiActionFieldName(key) || !Object.hasOwn(properties, key)) continue;
        const propSchema: unknown = properties[key];
        // Drop keys the schema doesn't declare.
        if (propSchema === undefined) continue;
        if (propSchema === null || typeof propSchema !== "object") {
            out[key] = value;
            continue;
        }
        const p = propSchema as {
            type?: unknown;
            enum?: unknown;
            pattern?: unknown;
            minimum?: unknown;
            exclusiveMinimum?: unknown;
            maximum?: unknown;
            minLength?: unknown;
            maxLength?: unknown;
            format?: unknown;
        };
        if (p.type === "number" && typeof value !== "number") continue;
        if (p.type === "string" && typeof value !== "string") continue;
        if (Array.isArray(p.enum) && !p.enum.some((e) => e === value)) continue;
        // Numeric lower bounds constrain number values only, exactly like JSON schema. A model can
        // emit a degenerate value that IS the declared type (e.g. amount 0 against exclusiveMinimum
        // 0, live-reproduced from the message "hi") — deleting it here lets the required-fields
        // check refuse the whole extraction instead of posting an unusable card.
        if (typeof p.minimum === "number" && typeof value === "number" && value < p.minimum) {
            continue;
        }
        if (
            typeof p.exclusiveMinimum === "number" &&
            typeof value === "number" &&
            value <= p.exclusiveMinimum
        ) {
            continue;
        }
        if (typeof p.maximum === "number" && typeof value === "number" && value > p.maximum) {
            continue;
        }
        if (typeof value === "string") {
            const length = [...value].length;
            if (
                typeof p.minLength === "number" &&
                Number.isSafeInteger(p.minLength) &&
                p.minLength >= 0 &&
                length < p.minLength
            ) {
                continue;
            }
            if (
                typeof p.maxLength === "number" &&
                Number.isSafeInteger(p.maxLength) &&
                p.maxLength >= 0 &&
                length > p.maxLength
            ) {
                continue;
            }
            if (!conformsToSafeStringFormat(p.format, value)) continue;
        }
        // Manifest patterns are untrusted and JavaScript's backtracking RegExp engine has no timeout.
        // Fail closed for any patterned field rather than execute a potential ReDoS expression such
        // as `(a+)+$`. A future implementation may re-enable patterns through a bounded RE2 engine.
        if (typeof p.pattern === "string") continue;
        out[key] = value;
    }
    return out;
}

// Does the message mention this keyword as a WHOLE WORD? Case-insensitive.
//
// Raw `text.includes(keyword)` fired INSIDE other words, which made short keywords unusable: an app
// listing "owe" (as a ledger app might do) could still be told that OpenChat matched on word
// boundaries — true of the auto-propose chip, false of this deterministic override) force-classified
// "I lost power yesterday" as a debt entry. A keyword_map override cannot be argued with by the model or the
// user, so a stray substring hit silently mislabels the entry.
//
// \b is not usable: keywords may legitimately begin or end with punctuation or spaces (multi-word
// phrases), so assert a non-alphanumeric character — or the string edge — on each side. \p{L}/\p{N}
// keep this correct for non-ASCII messages.
//
// The auto-propose chip has its own copy of this rule in app/src/utils/keywordMatch.ts (it cannot
// import openchat-shared without dragging in the client graph). The two MUST agree: a chip that
// appears on a message this pass then refuses to classify is the confusing half-state.
export function matchesKeyword(text: string, keyword: string): boolean {
    if (!isBoundedRuleString(keyword)) return false;
    const haystack = text.slice(0, MAX_AI_ACTION_MESSAGE_SCAN_CHARS).toLowerCase();
    const needle = keyword.toLowerCase();
    let from = 0;
    while (from <= haystack.length - needle.length) {
        const index = haystack.indexOf(needle, from);
        if (index < 0) return false;
        let before = "";
        if (index > 0) {
            let beforeStart = index - 1;
            const last = haystack.charCodeAt(beforeStart);
            if (
                last >= 0xdc00 &&
                last <= 0xdfff &&
                beforeStart > 0 &&
                haystack.charCodeAt(beforeStart - 1) >= 0xd800 &&
                haystack.charCodeAt(beforeStart - 1) <= 0xdbff
            ) {
                beforeStart--;
            }
            before = haystack.slice(beforeStart, index);
        }
        const afterIndex = index + needle.length;
        const after =
            afterIndex >= haystack.length
                ? ""
                : String.fromCodePoint(haystack.codePointAt(afterIndex) ?? 0);
        if (!AI_ACTION_WORD_CHAR.test(before) && !AI_ACTION_WORD_CHAR.test(after)) return true;
        from = index + Math.max(needle.length, 1);
    }
    return false;
}

// Build one deterministic, aggregate-bounded text view of image-model output for an override rule.
// The raw target field is intentionally first: it may contain the model's human phrase before schema
// conformance rejects it for not yet being the app-declared enum value. Common explanatory fields are
// next, then every other safe string field in lexical order so JSON property order cannot affect the
// decision. Newline separators prevent a keyword phrase from being synthesized across field edges.
function extractedStringEvidence(extracted: Record<string, unknown>, targetField: string): string {
    const priority = [targetField, "message", "note"];
    const remaining = Object.keys(extracted)
        .filter((field) => isSafeAiActionFieldName(field) && !priority.includes(field))
        .sort();
    const fields = [...priority, ...remaining];
    const seen = new Set<string>();
    let evidence = "";
    for (const field of fields) {
        if (seen.has(field)) continue;
        seen.add(field);
        const value = extracted[field];
        if (typeof value !== "string") continue;

        const separator = evidence.length === 0 ? "" : "\n";
        const available = MAX_AI_ACTION_MESSAGE_SCAN_CHARS - evidence.length;
        if (available <= separator.length) break;
        evidence += separator;
        evidence += value.slice(0, MAX_AI_ACTION_MESSAGE_SCAN_CHARS - evidence.length);
        if (evidence.length === MAX_AI_ACTION_MESSAGE_SCAN_CHARS) break;
    }
    return evidence;
}

// Deterministic post-pass over the model's extraction, applied in a fixed order:
//   1. from_message rules fill their field from the message text itself (trimmed, truncated).
//   2. keyword_map rules with mode "override" scan authoritative message text, or a bounded stable
//      concatenation of raw extracted string fields only for image input without text (case-insensitive
//      WHOLE-WORD match per keyword); the first mapping with any match wins. Mode "hint" is
//      prompt-guidance only.
//   3. normalize ops run in order on the field when it is present.
//   4. schema conformance (type/enum/numeric bounds/safe string lengths/bounded string formats)
//      deletes violating fields and drops undeclared keys. Untrusted regex patterns fail closed and
//      are never executed.
export function applyRulesPostPass(
    rules: AiActionRule[],
    extracted: Record<string, unknown>,
    messageText: string | undefined,
    responseSchema?: object,
    source: { hasImage?: boolean } = {},
): Record<string, unknown> {
    const safeRules = boundedRules(rules);
    let out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of Object.entries(extracted)) {
        if (isSafeAiActionFieldName(key)) out[key] = value;
    }

    if (messageText !== undefined) {
        for (const rule of safeRules) {
            if (rule.kind === "from_message") {
                out[rule.field] = messageText
                    .slice(0, MAX_AI_ACTION_MESSAGE_SCAN_CHARS)
                    .trim()
                    .slice(0, rule.maxLength ?? 200);
            }
        }
    }

    for (const rule of safeRules) {
        if (rule.kind === "keyword_map" && rule.mode === "override") {
            // Supplied source text is authoritative even when no keyword matches it. Falling through
            // to model-generated strings in a mixed invocation would let the model overrule the user.
            const evidence =
                messageText !== undefined
                    ? messageText.slice(0, MAX_AI_ACTION_MESSAGE_SCAN_CHARS)
                    : source.hasImage === true
                      ? extractedStringEvidence(extracted, rule.field)
                      : undefined;
            if (evidence === undefined) continue;
            const hit = rule.map.find((m) => m.keywords.some((k) => matchesKeyword(evidence, k)));
            if (hit !== undefined) {
                out[rule.field] = hit.value;
            }
        }
    }

    for (const rule of safeRules) {
        if (rule.kind === "normalize" && Object.hasOwn(out, rule.field)) {
            let v = out[rule.field];
            for (const op of rule.ops) {
                v = applyNormalizeOp(op, v);
            }
            out[rule.field] = v;
        }
    }

    out = conformToSchema(out, responseSchema);
    return out;
}

// The schema's `required` field names absent (or undefined) in the extraction — checked AFTER the
// conformance pass, so a field conformance deleted counts as missing. Generic JSON-schema mechanics
// only: no schema, or no (array) `required`, means nothing is required. Callers gate on a non-empty
// result to refuse a degenerate extraction instead of posting a card the consumer must reject.
export function missingRequired(
    extraction: Record<string, unknown>,
    schema: object | undefined,
): string[] {
    if (schema === undefined) return [];
    const required: unknown = (schema as { required?: unknown }).required;
    if (!Array.isArray(required)) return [];
    return required.filter(
        (name): name is string =>
            typeof name === "string" &&
            (!isSafeAiActionFieldName(name) ||
                !Object.hasOwn(extraction, name) ||
                extraction[name] === undefined),
    );
}

// A property schema may explicitly opt out of image-only extraction by setting
// `x-openchat-omit-for-image-only` to the boolean `true`. This is deliberately generic: an app can
// use it for any OPTIONAL field whose value cannot be trusted unless the user also supplied source
// text. Unknown formats remain ordinary schema annotations, and malformed/non-boolean extension
// values do nothing. Build a fresh object so neither the conformed candidate nor the registered
// schema is mutated while processing one or many candidates.
function omitImageOnlySchemaProperties(
    extraction: Record<string, unknown>,
    schema: object | undefined,
): Record<string, unknown> {
    if (schema === undefined) return extraction;
    const props: unknown = (schema as { properties?: unknown }).properties;
    if (props === null || typeof props !== "object" || Array.isArray(props)) return extraction;
    const properties = props as Record<string, unknown>;
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const [field, value] of Object.entries(extraction)) {
        const propertySchema = Object.hasOwn(properties, field) ? properties[field] : undefined;
        const omitted =
            propertySchema !== null &&
            typeof propertySchema === "object" &&
            !Array.isArray(propertySchema) &&
            Object.hasOwn(propertySchema, "x-openchat-omit-for-image-only") &&
            (propertySchema as Record<string, unknown>)["x-openchat-omit-for-image-only"] === true;
        if (!omitted) out[field] = value;
    }
    return out;
}

// A registering app may require a model-produced STRING field to be evidenced by authoritative
// source text by setting `x-openchat-require-text-evidence: true` on that property. The normalized
// claim itself is accepted as a whole token. A same-field keyword_map may declare aliases (including
// symbols such as "$" that legitimately touch an amount); punctuation-bearing aliases use a bounded
// literal match while word aliases keep the standard Unicode whole-token semantics. With no source
// text (image-only/manual image) this policy is deliberately inactive.
function textEvidenceMatches(text: string, token: string): boolean {
    if (!isBoundedRuleString(token)) return false;
    const boundedText = text.slice(0, MAX_AI_ACTION_MESSAGE_SCAN_CHARS);
    if (/[^\p{L}\p{N}\s]/u.test(token)) {
        return boundedText.toLowerCase().includes(token.toLowerCase());
    }
    return matchesKeyword(boundedText, token);
}

// If the app persists authoritative source text through a bounded from_message field, validate an
// opted-in claim against only the prefix that can actually reach the app's attester. Otherwise a
// token after that persisted boundary could pass here but disappear from the exact stored payload.
// The shortest declared prefix is the conservative generic choice when an app declares more than
// one evidence field; with no from_message rule this remains a client-side correctness policy over
// the normal bounded source view.
function persistedTextEvidence(
    rules: readonly AiActionRule[],
    schema: object | undefined,
    messageText: string,
): string {
    const fromMessageRules = boundedRules(rules).filter(
        (rule): rule is Extract<AiActionRule, { kind: "from_message" }> =>
            rule.kind === "from_message",
    );
    const bounded = messageText.slice(0, MAX_AI_ACTION_MESSAGE_SCAN_CHARS).trim();
    if (fromMessageRules.length === 0) return bounded;
    const surviving = fromMessageRules
        .map((rule) => bounded.slice(0, rule.maxLength ?? 200))
        .filter((value, index) => {
            const field = fromMessageRules[index].field;
            return typeof conformToSchema({ [field]: value }, schema)[field] === "string";
        });
    if (surviving.length === 0) return "";
    return surviving.reduce((shortest, value) =>
        [...value].length < [...shortest].length ? value : shortest,
    );
}

function omitUnevidencedTextSchemaProperties(
    extraction: Record<string, unknown>,
    schema: object | undefined,
    rules: readonly AiActionRule[],
    messageText: string,
): Record<string, unknown> {
    if (schema === undefined) return extraction;
    const props: unknown = (schema as { properties?: unknown }).properties;
    if (props === null || typeof props !== "object" || Array.isArray(props)) return extraction;
    const properties = props as Record<string, unknown>;
    const safeRules = boundedRules(rules);
    const evidence = persistedTextEvidence(safeRules, schema, messageText);
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const [field, value] of Object.entries(extraction)) {
        const rawProperty = Object.hasOwn(properties, field) ? properties[field] : undefined;
        const property =
            rawProperty !== null && typeof rawProperty === "object" && !Array.isArray(rawProperty)
                ? (rawProperty as Record<string, unknown>)
                : undefined;
        const requiresEvidence = property?.["x-openchat-require-text-evidence"] === true;
        if (!requiresEvidence) {
            out[field] = value;
            continue;
        }
        if (typeof value !== "string") continue;
        const aliases = safeRules
            .filter(
                (rule): rule is Extract<AiActionRule, { kind: "keyword_map" }> =>
                    rule.kind === "keyword_map" && rule.field === field,
            )
            .flatMap((rule) =>
                rule.map
                    .filter((mapping) => mapping.value === value)
                    .flatMap((mapping) => mapping.keywords),
            );
        if (
            textEvidenceMatches(evidence, value) ||
            aliases.some((alias) => textEvidenceMatches(evidence, alias))
        ) {
            out[field] = value;
        }
    }
    return out;
}

// Source evidence is kept explicit at the candidate-policy boundary. `hasImage` distinguishes an
// image-origin extraction from a text extraction that simply has no message string (for example a
// manual/debug candidate), while nonempty `text` remains authoritative for message-driven rules in
// a mixed invocation. Keeping all schema-owned source policy in this seam lets model and manual
// candidates share the same ordering: rules -> conformance -> source-specific omission -> required
// gate in the caller.
export interface AiActionCandidateSource {
    hasImage?: boolean;
    text?: string;
}

export function postProcessAiActionCandidate(
    def: AiActionDefinition,
    candidate: Record<string, unknown>,
    source: AiActionCandidateSource = {},
): Record<string, unknown> {
    const hasText = source.text !== undefined && source.text.trim().length > 0;
    let processed = applyRulesPostPass(
        def.rules ?? [],
        candidate,
        hasText ? source.text : undefined,
        def.responseSchema,
        { hasImage: source.hasImage === true },
    );
    if (hasText) {
        processed = omitUnevidencedTextSchemaProperties(
            processed,
            def.responseSchema,
            def.rules ?? [],
            source.text!,
        );
    }
    if (source.hasImage === true && !hasText) {
        processed = omitImageOnlySchemaProperties(processed, def.responseSchema);
    }
    return processed;
}

// Pure: turn a registered action + a structured extraction + the recipient key into a postable ActionCard.
// `rows` come from the template (only non-empty values are shown); `confirmPayload` is the verbatim JSON of the
// extraction — opaque to OpenChat, exactly what the consumer's client parses after decrypting it from the inbox.
export function buildActionCardContent(
    def: AiActionDefinition,
    extracted: Record<string, unknown>,
    recipientPublicKeyPem: string,
    inboxCanisterId?: string,
    // Fan-out: additional recipient keys (other chat members' registered app keys). Confirm
    // encrypts the deposit separately to the primary key AND each of these (deduped server-side).
    additionalRecipientKeys?: string[],
    // The id of the app that owns this action, baked onto the card so a recipient binds card-surface
    // resolution to the exact producing app (not the non-namespaced actionId). See ActionCardContent.
    appId?: number,
    appRevision?: bigint,
): ActionCardContent {
    const templateRows = normalizedCardRows(def.card.rows) ?? [];
    const rows: ActionCardRow[] = templateRows
        .map((r) => ({ label: r.label, value: formatValue(extracted[r.valueKey]) }))
        .filter((r) => r.value.length > 0);

    return {
        kind: "action_card_content",
        title: def.card.title,
        rows,
        confirmLabel: def.card.confirmLabel,
        cancelLabel: def.card.cancelLabel,
        actionId: def.name,
        appId,
        appRevision,
        disclosure: def.card.disclosure,
        state: "pending",
        recipientPublicKey: recipientPublicKeyPem,
        recipientPublicKeys: additionalRecipientKeys?.filter(
            (k) => k.length > 0 && k !== recipientPublicKeyPem,
        ),
        confirmPayload: new TextEncoder().encode(JSON.stringify(extracted)),
        inboxCanisterId,
    };
}

// Pure multi-entry builder. Exact entries live only in confirmPayload and are never encoded into
// public rows. Each card row summarises one entry — its value composed from the SAME template row
// valueKeys the single-entry card uses (so a
// direction/kind field renders through its declared value exactly as today), joined into one readable
// line. The title reflects the entry count while deriving from the definition's own card title (no
// app name is hardcoded). Routing (recipient key, fan-out keys, inbox) is threaded identically to the
// single-entry builder, so one confirm → one deposit → one fanned-out envelope per member.
export function buildMultiActionCardContent(
    def: AiActionDefinition,
    extractedList: Record<string, unknown>[],
    recipientPublicKeyPem: string,
    inboxCanisterId?: string,
    additionalRecipientKeys?: string[],
    // The owning app id, baked onto the card (see buildActionCardContent).
    appId?: number,
    appRevision?: bigint,
): ActionCardContent {
    const templateRows = normalizedCardRows(def.card.rows) ?? [];
    const rows: ActionCardRow[] = extractedList.map((entry, i) => ({
        label: `Entry ${i + 1}`,
        value: templateRows
            .map((r) => ({ label: r.label, value: formatValue(entry[r.valueKey]) }))
            .filter((row) => row.value.length > 0)
            // Summary rows cannot use the manifest's field labels as their own row labels without
            // multiplying row count beyond the 32-row protocol limit. Preserve that information in
            // a deterministic, human-readable value so fields such as Type remain identifiable.
            .map((row) => `${row.label}: ${row.value}`)
            .join(" · "),
    }));

    return {
        kind: "action_card_content",
        title: `${def.card.title} (${extractedList.length} entries)`,
        rows,
        confirmLabel: def.card.confirmLabel,
        cancelLabel: def.card.cancelLabel,
        actionId: def.name,
        appId,
        appRevision,
        disclosure: def.card.disclosure,
        state: "pending",
        recipientPublicKey: recipientPublicKeyPem,
        recipientPublicKeys: additionalRecipientKeys?.filter(
            (k) => k.length > 0 && k !== recipientPublicKeyPem,
        ),
        confirmPayload: new TextEncoder().encode(JSON.stringify(extractedList)),
        inboxCanisterId,
    };
}

const MAX_CANONICAL_CARD_CONTEXT_BYTES =
    8 + // `OC-CARD\x01`
    (4 + 29) + // length-prefixed maximum-size viewer principal
    (1 + 4 + 29 + 4) + // largest chat variant: channel tag + community principal + channel id
    (1 + 4) + // present thread-root tag + index
    8 + // message id
    4 + // app id
    8; // app revision

function utf8Length(value: string): number {
    return new TextEncoder().encode(value).byteLength;
}

function canonicalStringLength(value: string): number {
    return 4 + utf8Length(value);
}

function maximumCanonicalCardBytes(card: ActionCardContent): number {
    let total = MAX_CANONICAL_CARD_CONTEXT_BYTES;
    total += canonicalStringLength(card.title);
    total += 4; // row count
    for (const row of card.rows) {
        total += canonicalStringLength(row.label);
        total += canonicalStringLength(row.value);
    }
    total += canonicalStringLength(card.confirmLabel);
    total += canonicalStringLength(card.cancelLabel);
    total += canonicalStringLength(card.actionId);
    total += 1 + (card.disclosure === undefined ? 0 : canonicalStringLength(card.disclosure));
    total += card.expiresAt === undefined ? 1 : 1 + 8;
    total += card.confirmPayload === undefined ? 1 : 1 + 4 + card.confirmPayload.byteLength;
    return total;
}

// Validate a built multi card against the protocol bounds before the caller asks the app canister
// to attest it. The aggregate calculation uses worst-case valid principal/chat/thread coordinates,
// so a pass is safe for every destination while a near-boundary value may be rejected conservatively.
export function multiActionCardBoundsError(card: ActionCardContent): string | undefined {
    if ([...card.title].length > MAX_AI_ACTION_CARD_TITLE_CHARS) {
        return `The multi-entry card title exceeds ${MAX_AI_ACTION_CARD_TITLE_CHARS} characters.`;
    }
    if (card.rows.some((row) => [...row.value].length > MAX_AI_ACTION_CARD_ROW_VALUE_CHARS)) {
        return `A multi-entry card summary exceeds ${MAX_AI_ACTION_CARD_ROW_VALUE_CHARS} characters.`;
    }
    if (
        card.confirmPayload !== undefined &&
        card.confirmPayload.byteLength > MAX_AI_APP_CONFIRM_PAYLOAD_BYTES
    ) {
        return `The multi-entry confirmation payload exceeds ${MAX_AI_APP_CONFIRM_PAYLOAD_BYTES} bytes.`;
    }
    if (maximumCanonicalCardBytes(card) > MAX_ATTESTED_ACTION_CARD_BYTES) {
        return "The multi-entry card exceeds OpenChat's 64 KiB attested-content limit.";
    }
    return undefined;
}

export function formatLocalCalendarDate(
    date: Pick<Date, "getFullYear" | "getMonth" | "getDate">,
): string {
    const year = String(date.getFullYear()).padStart(4, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

// Orchestrates the full proposal: run the on-device model against the declared prompt, parse, and build the
// card. `infer` is the on-device inference facade (injected so this is unit-testable without a native runtime).
export async function runAiAction(
    def: AiActionDefinition,
    input: { image?: Uint8Array; text?: string; modelId?: string },
    recipientPublicKeyPem: string,
    infer: (req: InferenceRequest) => Promise<InferenceResult>,
    inboxCanisterId?: string,
    additionalRecipientKeys?: string[],
    // The owning app id, baked onto the built card (see buildActionCardContent).
    appId?: number,
    appRevision?: bigint,
): Promise<RunAiActionResult> {
    if (input.image !== undefined && def.acceptsImage !== true) {
        return { kind: "image_not_accepted" };
    }
    if (normalizedCardRows(def.card.rows) === undefined) {
        return { kind: "error", error: "The action card template is invalid." };
    }
    // The native runtime reads only `prompt` (its separate `text` field is not consumed), so the
    // message MUST be interpolated into the prompt for the model to see it. An explicitly declared
    // context/today rule anchors relative or year-less dates in nonempty message text ("1st june")
    // to the user's current date. It is never injected for image-only input: image pixels remain the
    // sole source evidence. Declared model-guidance rules compile into a "Rules:" block first.
    const rules = def.rules ?? [];
    const hasTextInput = input.text !== undefined && input.text.trim().length > 0;
    const ruleLines = compileRules(rules, { hasMessageText: hasTextInput });
    const providesTodayContext = boundedRules(rules).some(
        (rule) => rule.kind === "context" && rule.provide.includes("today"),
    );
    let prompt = def.promptTemplate;
    if (ruleLines.length > 0) {
        prompt += `\n\nRules:\n- ${ruleLines.join("\n- ")}`;
    }
    if (providesTodayContext && hasTextInput) {
        const today = formatLocalCalendarDate(new Date());
        prompt += `\n\nToday is ${today}.`;
    }
    if (hasTextInput) {
        prompt += `\n\nMessage:\n${input.text}`;
    }

    // NB: the response schema is deliberately NOT passed to the model. Grammar/JSON-schema-CONSTRAINED
    // decoding makes a small on-device model emit a degenerate value under the constraint — in practice a
    // number field like `amount` collapses to 0 for some inputs (e.g. "reservation 3-8 august 7777 gbp"
    // yielded amount 0, which the consumer then rejects as "must be positive" → an invalid draft), even
    // though UNCONSTRAINED decoding extracts the right number. The schema is still enforced deterministically
    // AFTER generation by `applyRulesPostPass`/`conformToSchema` below, so nothing is lost by dropping the
    // generation-time constraint — we just let the model pick the value freely first.
    // Deliberately NO `text` here. The message is ALREADY inlined into `prompt` above, because the
    // native runtime reads only `prompt`. The BROWSER backend, however, concatenates prompt + text
    // (see webInference.ts, which builds its prompt as request.prompt followed by request.text) — so
    // passing both sent the model the SAME message twice, and it duly extracted some transactions
    // twice: "owe me 300 uber 150 food" came back with 300 repeated. Native never saw it, which is
    // why this read like small-model flakiness rather than a bug in our own prompt assembly.
    const result = await infer({
        modelId: input.modelId,
        prompt,
        image: input.image,
    });

    if (result.kind === "unavailable") return { kind: "unavailable", reason: result.reason };
    if (result.kind === "error") return { kind: "error", error: result.error };

    // The model text is accepted as a single OBJECT or an ARRAY of objects (several transactions in
    // one message). Normalize to a list of candidate objects.
    const candidates = parseExtractionList(result.text);
    if (candidates === undefined) return { kind: "no_extraction", raw: result.text };
    if (candidates.length > MAX_AI_ACTION_CANDIDATES) {
        return {
            kind: "error",
            error: `The model returned more than ${MAX_AI_ACTION_CANDIDATES} action candidates.`,
        };
    }

    // Deterministic post-pass over each candidate. The card and confirmPayload are built from the
    // post-passed objects, never the raw extraction. If any candidate is incomplete, fail the whole
    // proposal so a partial multi-entry result cannot masquerade as a complete card.
    const valid: Record<string, unknown>[] = [];
    const missingFields = new Set<string>();
    for (const candidate of candidates) {
        const finalExtraction = postProcessAiActionCandidate(def, candidate, {
            hasImage: input.image !== undefined,
            text: input.text,
        });
        const missing = missingRequired(finalExtraction, def.responseSchema);
        if (missing.length === 0) {
            valid.push(finalExtraction);
        } else {
            for (const field of missing) missingFields.add(field);
        }
    }

    // One valid candidate becomes one card. Multiple valid candidates become one attested card whose
    // exact JSON array remains in the server-stored confirmPayload; public rows stay summaries.
    if (missingFields.size > 0) {
        return {
            kind: "incomplete_extraction",
            raw: result.text,
            missingFields: [...missingFields].sort(),
            candidateCount: candidates.length,
            validCandidateCount: valid.length,
        };
    }
    if (valid.length === 1) {
        return {
            kind: "ready",
            card: buildActionCardContent(
                def,
                valid[0],
                recipientPublicKeyPem,
                inboxCanisterId,
                additionalRecipientKeys,
                appId,
                appRevision,
            ),
            extracted: valid[0],
        };
    }
    const card = buildMultiActionCardContent(
        def,
        valid,
        recipientPublicKeyPem,
        inboxCanisterId,
        additionalRecipientKeys,
        appId,
        appRevision,
    );
    const boundsError = multiActionCardBoundsError(card);
    return boundsError === undefined
        ? { kind: "ready_multi", card, extracted: valid }
        : { kind: "error", error: boundsError };
}

// --- Directory read ------------------------------------------------------------------------------------------
// The on-chain action definition returned by bounded UserIndex app queries, nested in each app manifest.
// (snake_case; response_schema is a JSON string; card rows are keyed by `field`). Defined here as the read
// contract — the agent validates the query result into this shape, then maps it to the AiActionDefinition the
// runner consumes.

// Rules as serde/msgpack encodes the Rust AiActionRule enum: externally tagged — newtype variants become a
// single-key map { variant_name: payload } and unit variants (RuleMode, NormalizeOp, ContextItem) become
// plain snake_case strings.
export type AiActionRuleWire =
    | { keyword_map: { field: string; mode: string; map: { value: string; keywords: string[] }[] } }
    | { from_message: { field: string; max_length?: number | null } }
    | { normalize: { field: string; ops: string[] } }
    | { instruction: { text: string } }
    | { context: { provide: string[] } };

export interface AiActionDefinitionWire {
    name: string;
    description: string;
    prompt_template: string;
    response_schema: string;
    endpoint: string;
    consumer_public_key?: string;
    card: {
        title: string;
        confirm_label: string;
        cancel_label: string;
        disclosure?: string;
        rows: { field: string; label: string }[];
    };
    rules?: AiActionRuleWire[];
    accepts_image?: boolean;
}

// A surface as serde encodes the Rust AiAppSurface: field names already match the domain shape and
// the SurfaceDisplay unit variants travel as the plain strings "sheet" / "external" (per-variant
// serde renames).
export interface AiAppSurfaceWire {
    kind: string;
    url: string;
    display: AiAppSurfaceDisplay;
}

// The on-chain AiAppManifest / AiAppRegistration returned by bounded UserIndex app queries.
// (snake_case; nested actions use the AiActionDefinitionWire shape above). The registration's
// `owner` principal is expected to have already been stringified by the agent layer.
export interface AiAppManifestWire {
    name: string;
    description: string;
    icon_url?: string;
    consumer_public_key: string;
    // serde(default) on-chain: registrations that predate per-user keys omit it (=== false).
    per_user_keys?: boolean;
    actions: AiActionDefinitionWire[];
    // serde(default) on-chain: registrations that predate surfaces omit it (=== []).
    surfaces?: AiAppSurfaceWire[];
    // Per-app inbox: the agent layer pre-decodes the principal bytes to a text principal (like owner)
    // before this wire shape reaches aiAppManifestFromWire; absent for registrations that predate it.
    inbox_canister_id?: string;
}

export interface AiAppRegistrationWire {
    id: number;
    owner: string;
    manifest: AiAppManifestWire;
    created: bigint;
    updated: bigint;
    published: boolean;
}

const NORMALIZE_OPS: readonly AiActionNormalizeOp[] = [
    "k_m_suffix",
    "strip_symbols",
    "uppercase",
    "lowercase",
    "trim",
];

function isRecord(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

function ruleFromWire(entry: unknown): AiActionRule | undefined {
    if (!isRecord(entry)) return undefined;
    if (isRecord(entry.keyword_map)) {
        const r = entry.keyword_map;
        if (
            typeof r.field !== "string" ||
            !isSafeAiActionFieldName(r.field) ||
            (r.mode !== "hint" && r.mode !== "override") ||
            !Array.isArray(r.map) ||
            r.map.length > MAX_AI_ACTION_KEYWORD_MAPPINGS
        ) {
            return undefined;
        }
        const map: { value: string; keywords: string[] }[] = [];
        for (const m of r.map) {
            if (
                isRecord(m) &&
                typeof m.value === "string" &&
                isBoundedRuleString(m.value) &&
                Array.isArray(m.keywords) &&
                m.keywords.length <= MAX_AI_ACTION_KEYWORDS_PER_MAPPING &&
                m.keywords.every((k) => typeof k === "string" && isBoundedRuleString(k))
            ) {
                map.push({ value: m.value, keywords: m.keywords as string[] });
            }
        }
        return { kind: "keyword_map", field: r.field, mode: r.mode, map };
    }
    if (isRecord(entry.from_message)) {
        const r = entry.from_message;
        if (typeof r.field !== "string" || !isSafeAiActionFieldName(r.field)) return undefined;
        if (
            r.max_length !== undefined &&
            r.max_length !== null &&
            (typeof r.max_length !== "number" ||
                !Number.isInteger(r.max_length) ||
                r.max_length < 0 ||
                r.max_length > MAX_AI_ACTION_FROM_MESSAGE_LENGTH)
        ) {
            return undefined;
        }
        return {
            kind: "from_message",
            field: r.field,
            maxLength: typeof r.max_length === "number" ? r.max_length : undefined,
        };
    }
    if (isRecord(entry.normalize)) {
        const r = entry.normalize;
        if (
            typeof r.field !== "string" ||
            !isSafeAiActionFieldName(r.field) ||
            !Array.isArray(r.ops) ||
            r.ops.length > NORMALIZE_OPS.length
        )
            return undefined;
        // Unrecognised ops (forward compatibility) are skipped rather than failing the rule.
        const ops = r.ops.filter((o): o is AiActionNormalizeOp =>
            NORMALIZE_OPS.includes(o as AiActionNormalizeOp),
        );
        return { kind: "normalize", field: r.field, ops };
    }
    if (isRecord(entry.instruction)) {
        const r = entry.instruction;
        if (typeof r.text !== "string" || r.text.length > MAX_AI_ACTION_INSTRUCTION_LENGTH) {
            return undefined;
        }
        return { kind: "instruction", text: r.text };
    }
    if (isRecord(entry.context)) {
        const r = entry.context;
        if (!Array.isArray(r.provide)) return undefined;
        return { kind: "context", provide: r.provide.filter((p): p is "today" => p === "today") };
    }
    return undefined;
}

// Tolerant: a missing / non-array rules value maps to [] and entries that don't match a known rule
// shape are skipped, so an older (or newer) registry entry can never break the runner.
export function rulesFromWire(raw: unknown): AiActionRule[] {
    if (!Array.isArray(raw)) return [];
    const rules: AiActionRule[] = [];
    for (const entry of raw.slice(0, MAX_AI_ACTION_RULES)) {
        const rule = ruleFromWire(entry);
        if (rule !== undefined) rules.push(rule);
    }
    return boundedRules(rules);
}

export function aiActionDefinitionFromWire(d: AiActionDefinitionWire): AiActionDefinition {
    let responseSchema: object | undefined;
    if (d.response_schema.trim().length > 0) {
        try {
            const parsed: unknown = JSON.parse(d.response_schema);
            if (parsed !== null && typeof parsed === "object") responseSchema = parsed as object;
        } catch {
            // best-effort: a non-JSON schema string just means no constraint is passed to the model
        }
    }
    return {
        name: d.name,
        description: d.description,
        promptTemplate: d.prompt_template,
        responseSchema,
        endpoint: d.endpoint,
        consumerPublicKey: d.consumer_public_key,
        card: {
            title: d.card.title,
            confirmLabel: d.card.confirm_label,
            cancelLabel: d.card.cancel_label,
            disclosure: d.card.disclosure,
            // Fail the whole template closed on an unsafe/ambiguous row. `runAiAction` refuses an empty
            // template, and the card-surface resolver likewise gets no attacker-controlled key map.
            rows:
                normalizedCardRows(
                    d.card.rows.map((r) => ({ label: r.label, valueKey: r.field })),
                ) ?? [],
        },
        rules: rulesFromWire(d.rules),
        acceptsImage: d.accepts_image ?? false,
    };
}

export function aiAppManifestFromWire(m: AiAppManifestWire): AiAppManifest {
    return {
        name: m.name,
        description: m.description,
        iconUrl: m.icon_url,
        consumerPublicKey: m.consumer_public_key,
        perUserKeys: m.per_user_keys,
        actions: m.actions.map(aiActionDefinitionFromWire),
        // Tolerant: registrations that predate surfaces omit the field.
        surfaces: (m.surfaces ?? []).map((s) => ({
            kind: s.kind,
            url: s.url,
            display: s.display,
        })),
        inboxCanisterId: m.inbox_canister_id,
    };
}

// One page of the published-app explorer (user_index explore_ai_apps). Failures degrade to an
// empty page at the mapping layer, so consumers never branch on error shapes.
export interface ExploreAiAppsResponse {
    matches: AiAppRegistration[];
    total: number;
}

export function aiAppFromRegistration(reg: AiAppRegistrationWire): AiAppRegistration {
    return {
        id: reg.id,
        owner: reg.owner,
        manifest: aiAppManifestFromWire(reg.manifest),
        created: reg.created,
        updated: reg.updated,
        published: reg.published,
    };
}
