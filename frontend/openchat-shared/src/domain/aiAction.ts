// Generic in-OpenChat AI-action runner.
//
// A registered app declares an AiAction (prompt + output schema + a card template + the recipient public key
// it wants confirmed actions encrypted to). The runner takes a message's content (image/text), runs the
// user's selected ON-DEVICE model against the declared prompt, parses the structured result, and builds a
// confirmable ActionCard whose rows come from the template and whose delivery routing (recipientPublicKey +
// an opaque confirmPayload) targets the registered consumer. Nothing here is app-specific — every app-specific
// value comes from the registration. The card is then posted by the caller; on confirm OpenChat encrypts the
// payload to the recipient and deposits it into the on-chain action_inbox.

import type { ActionCardContent, ActionCardRow, ChatIdentifier } from "./chat/chat";
import type { InferenceRequest, InferenceResult } from "./onDeviceModel";

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
export type AiActionNormalizeOp = "k_m_suffix" | "strip_symbols" | "uppercase" | "lowercase" | "trim";
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
// and OpenChat ignores kinds it does not know. The URL may contain the placeholders {chatKey} and
// {appId}, which OpenChat substitutes before opening (see chatKeyFor for the {chatKey} format).
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
// Direct chats return undefined — no confirm path exists for them, so no chat key is ever rendered.
export function chatKeyFor(chatId: ChatIdentifier): string | undefined {
    switch (chatId.kind) {
        case "group_chat":
            return `group:${chatId.groupId}`;
        case "channel":
            return `channel:${chatId.communityId}:${chatId.channelId}`;
        case "direct_chat":
            // Rendered per participant — each side keys the chat by the OTHER user, byte-matching
            // the deposit its OWN canister emits (the responder's canister is the confirm path for
            // direct chats). The two participants therefore see different keys for the same chat;
            // per-user-keys apps attribute via confirmedBy, so this is sufficient.
            return `direct:${chatId.userId}`;
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

// The frontend mirror of the on-chain AiAppRegistration as the user_index `ai_apps` query returns it.
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

// One row of the user_index `ai_app_user_keys` fan-out lookup: a chat MEMBER's registered delivery
// key for one app (public key material only). Used at propose time to address the eventual confirm
// to every chat member with a key, not just the proposer.
export interface AiAppMemberKey {
    userId: string;
    publicKey: string;
}

// A one-time pairing code (user_index `create_ai_app_link_code`): the user enters it in the app,
// which then pushes their public key to OpenChat via `claim_ai_app_link_code`. Single-use, expires
// at `expiresAt` (epoch millis).
export interface AiAppLinkCode {
    code: string;
    expiresAt: bigint;
}

export type RunAiActionResult =
    | { kind: "ready"; card: ActionCardContent; extracted: Record<string, unknown> }
    // Several valid entries extracted from one message: ONE card carrying the whole array (its
    // confirmPayload is the JSON array). The caller posts + confirms it exactly like a `ready` card.
    | { kind: "ready_multi"; card: ActionCardContent; extracted: Record<string, unknown>[] }
    // No native runtime / no model selected — the caller must degrade gracefully (no autonomous fallback).
    | { kind: "unavailable"; reason: string }
    // The model ran but produced nothing parseable as the declared structured output.
    | { kind: "no_extraction"; raw: string }
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
        return obj !== null && typeof obj === "object" ? (obj as Record<string, unknown>) : undefined;
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
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : text;
    const arrStart = candidate.indexOf("[");
    const objStart = candidate.indexOf("{");
    if (arrStart >= 0 && (objStart < 0 || arrStart < objStart)) {
        const arrEnd = candidate.lastIndexOf("]");
        if (arrEnd > arrStart) {
            try {
                const parsed: unknown = JSON.parse(candidate.slice(arrStart, arrEnd + 1));
                if (Array.isArray(parsed)) {
                    const objs = parsed.filter(
                        (e): e is Record<string, unknown> =>
                            e !== null && typeof e === "object" && !Array.isArray(e),
                    );
                    return objs.length > 0 ? objs : undefined;
                }
            } catch {
                // not a clean array — fall through to single-object parsing
            }
        }
    }
    const obj = parseExtraction(text);
    return obj === undefined ? undefined : [obj];
}

// --- Rules ---------------------------------------------------------------------------------------------------

// Compile the declared rules into prompt guidance lines. Only rules that need the model's cooperation
// produce a line — normalize is deterministic (post-pass only) and context/today is already covered by
// the dateline runAiAction always appends.
export function compileRules(rules: AiActionRule[]): string[] {
    const lines: string[] = [];
    for (const rule of rules) {
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
                lines.push(`Set "${rule.field}" to a short phrase taken from the message.`);
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

// Tiny local schema conformance pass (type/enum/pattern/minimum/exclusiveMinimum only — deliberately
// not a full JSON-schema validator and no added dependency). Drops keys the schema doesn't declare and
// DELETES fields that violate their declared constraint: visible omission beats silent wrongness.
function conformToSchema(
    extracted: Record<string, unknown>,
    schema: object | undefined,
): Record<string, unknown> {
    if (schema === undefined) return extracted;
    const props: unknown = (schema as { properties?: unknown }).properties;
    if (props === null || typeof props !== "object" || Array.isArray(props)) return extracted;
    const properties = props as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(extracted)) {
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
        if (typeof p.pattern === "string" && typeof value === "string") {
            try {
                if (!new RegExp(p.pattern).test(value)) continue;
            } catch {
                // an invalid pattern is treated as no constraint
            }
        }
        out[key] = value;
    }
    return out;
}

// Deterministic post-pass over the model's extraction, applied in a fixed order:
//   1. from_message rules fill their field from the message text itself (trimmed, truncated).
//   2. keyword_map rules with mode "override" scan the message (case-insensitive substring per keyword);
//      the first mapping with any match wins. Mode "hint" is prompt-guidance only.
//   3. normalize ops run in order on the field when it is present.
//   4. schema conformance (type/enum/pattern) deletes violating fields and drops undeclared keys.
export function applyRulesPostPass(
    rules: AiActionRule[],
    extracted: Record<string, unknown>,
    messageText: string | undefined,
    responseSchema?: object,
): Record<string, unknown> {
    let out: Record<string, unknown> = { ...extracted };

    if (messageText !== undefined) {
        for (const rule of rules) {
            if (rule.kind === "from_message") {
                out[rule.field] = messageText.trim().slice(0, rule.maxLength ?? 200);
            }
        }

        const msg = messageText.toLowerCase();
        for (const rule of rules) {
            if (rule.kind === "keyword_map" && rule.mode === "override") {
                const hit = rule.map.find((m) =>
                    m.keywords.some((k) => k.length > 0 && msg.includes(k.toLowerCase())),
                );
                if (hit !== undefined) {
                    out[rule.field] = hit.value;
                }
            }
        }
    }

    for (const rule of rules) {
        if (rule.kind === "normalize" && rule.field in out) {
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
        (name): name is string => typeof name === "string" && extraction[name] === undefined,
    );
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
): ActionCardContent {
    const rows: ActionCardRow[] = def.card.rows
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
        disclosure: def.card.disclosure,
        state: "pending",
        recipientPublicKey: recipientPublicKeyPem,
        recipientPublicKeys: additionalRecipientKeys?.filter((k) => k.length > 0 && k !== recipientPublicKeyPem),
        confirmPayload: new TextEncoder().encode(JSON.stringify(extracted)),
        inboxCanisterId,
    };
}

// Rows whose label starts with this prefix are HIDDEN control rows: they ride through the hydrated
// rows to the client (the read path strips confirm_payload but keeps rows) so the app-rendered card
// can read them, but the classic OC renderer never displays them and reverseMapRows never maps them.
export const OC_HIDDEN_ROW_PREFIX = "__oc_";

// The hidden control row a multi-entry card carries: its value is the JSON of the EXACT validated
// entry array (byte-identical to the array that becomes the confirmPayload). Because confirm_payload
// is stripped on read, this row is the only place the exact array survives to the app card, which
// reverse-maps it into { entries: [...] } instead of flattening the per-entry summary rows.
export const OC_ENTRIES_ROW_LABEL = `${OC_HIDDEN_ROW_PREFIX}entries__`;

// Pure: turn a registered action + SEVERAL structured extractions into ONE postable ActionCard. The
// confirmPayload is the verbatim JSON ARRAY of the entries (the multi form of the wire contract); the
// consumer parses an array and adds every element on a single confirm. Each card row summarises one
// entry — its value composed from the SAME template row valueKeys the single-entry card uses (so a
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
): ActionCardContent {
    const rows: ActionCardRow[] = extractedList.map((entry, i) => ({
        label: `Entry ${i + 1}`,
        value: def.card.rows
            .map((r) => formatValue(entry[r.valueKey]))
            .filter((v) => v.length > 0)
            .join(" "),
    }));

    // Append the hidden sentinel carrying the EXACT validated entry array. On read the canister strips
    // confirm_payload but hydrates rows, so this row is the only channel by which the app-rendered card
    // recovers every entry (2..N) instead of reverse-mapping the flattened per-entry summaries into one
    // object. The classic OC renderer + reverseMapRows skip any "__oc_" row, so this is invisible to the
    // non-app render and never pollutes the single-entry reverse-map.
    rows.push({ label: OC_ENTRIES_ROW_LABEL, value: JSON.stringify(extractedList) });

    return {
        kind: "action_card_content",
        title: `${def.card.title} (${extractedList.length} entries)`,
        rows,
        confirmLabel: def.card.confirmLabel,
        cancelLabel: def.card.cancelLabel,
        actionId: def.name,
        appId,
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
): Promise<RunAiActionResult> {
    // The native runtime reads only `prompt` (its separate `text` field is not consumed), so the
    // message MUST be interpolated into the prompt for the model to see it. A dateline anchors
    // relative or year-less dates in the message ("1st june") to the user's current date. Declared
    // rules compile into a "Rules:" block of guidance lines between the template and the dateline.
    const rules = def.rules ?? [];
    const ruleLines = compileRules(rules);
    const today = new Date().toISOString().slice(0, 10);
    let prompt = def.promptTemplate;
    if (ruleLines.length > 0) {
        prompt += `\n\nRules:\n- ${ruleLines.join("\n- ")}`;
    }
    prompt += `\n\nToday is ${today}.`;
    if (input.text !== undefined && input.text.trim().length > 0) {
        prompt += `\n\nMessage:\n${input.text}`;
    }

    // NB: the response schema is deliberately NOT passed to the model. Grammar/JSON-schema-CONSTRAINED
    // decoding makes a small on-device model emit a degenerate value under the constraint — in practice a
    // number field like `amount` collapses to 0 for some inputs (e.g. "reservation 3-8 august 7777 gbp"
    // yielded amount 0, which the consumer then rejects as "must be positive" → an invalid draft), even
    // though UNCONSTRAINED decoding extracts the right number. The schema is still enforced deterministically
    // AFTER generation by `applyRulesPostPass`/`conformToSchema` below, so nothing is lost by dropping the
    // generation-time constraint — we just let the model pick the value freely first.
    const result = await infer({
        modelId: input.modelId,
        prompt,
        image: input.image,
        text: input.text,
    });

    if (result.kind === "unavailable") return { kind: "unavailable", reason: result.reason };
    if (result.kind === "error") return { kind: "error", error: result.error };

    // The model text is accepted as a single OBJECT or an ARRAY of objects (several transactions in
    // one message). Normalize to a list of candidate objects.
    const candidates = parseExtractionList(result.text);
    if (candidates === undefined) return { kind: "no_extraction", raw: result.text };

    // Deterministic post-pass over EACH candidate — the card AND the confirmPayload are built from
    // the post-passed objects, never the raw extraction. A degenerate element (a required field the
    // model omitted, or one the conformance pass deleted for violating its constraint — e.g. amount 0
    // against exclusiveMinimum 0) is DROPPED here, exactly as the single-entry gate refused it.
    const valid: Record<string, unknown>[] = [];
    for (const candidate of candidates) {
        const finalExtraction = applyRulesPostPass(rules, candidate, input.text, def.responseSchema);
        if (missingRequired(finalExtraction, def.responseSchema).length === 0) {
            valid.push(finalExtraction);
        }
    }

    // 0 valid → no card (same UX as "model found no action"). 1 valid → the single-entry card, its
    // confirmPayload a JSON OBJECT (byte-identical to before). ≥2 valid → ONE multi-entry card whose
    // confirmPayload is the JSON ARRAY of the valid entries.
    if (valid.length === 0) return { kind: "no_extraction", raw: result.text };
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
            ),
            extracted: valid[0],
        };
    }
    return {
        kind: "ready_multi",
        card: buildMultiActionCardContent(
            def,
            valid,
            recipientPublicKeyPem,
            inboxCanisterId,
            additionalRecipientKeys,
            appId,
        ),
        extracted: valid,
    };
}

// --- Directory read ------------------------------------------------------------------------------------------
// The on-chain action definition as the user_index `ai_apps` query returns it, nested in each app's manifest
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

// The on-chain AiAppManifest / AiAppRegistration as the user_index `ai_apps` query returns them
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
            (r.mode !== "hint" && r.mode !== "override") ||
            !Array.isArray(r.map)
        ) {
            return undefined;
        }
        const map: { value: string; keywords: string[] }[] = [];
        for (const m of r.map) {
            if (
                isRecord(m) &&
                typeof m.value === "string" &&
                Array.isArray(m.keywords) &&
                m.keywords.every((k) => typeof k === "string")
            ) {
                map.push({ value: m.value, keywords: m.keywords as string[] });
            }
        }
        return { kind: "keyword_map", field: r.field, mode: r.mode, map };
    }
    if (isRecord(entry.from_message)) {
        const r = entry.from_message;
        if (typeof r.field !== "string") return undefined;
        return {
            kind: "from_message",
            field: r.field,
            maxLength: typeof r.max_length === "number" ? r.max_length : undefined,
        };
    }
    if (isRecord(entry.normalize)) {
        const r = entry.normalize;
        if (typeof r.field !== "string" || !Array.isArray(r.ops)) return undefined;
        // Unrecognised ops (forward compatibility) are skipped rather than failing the rule.
        const ops = r.ops.filter((o): o is AiActionNormalizeOp =>
            NORMALIZE_OPS.includes(o as AiActionNormalizeOp),
        );
        return { kind: "normalize", field: r.field, ops };
    }
    if (isRecord(entry.instruction)) {
        const r = entry.instruction;
        if (typeof r.text !== "string") return undefined;
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
    for (const entry of raw) {
        const rule = ruleFromWire(entry);
        if (rule !== undefined) rules.push(rule);
    }
    return rules;
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
            rows: d.card.rows.map((r) => ({ label: r.label, valueKey: r.field })),
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
