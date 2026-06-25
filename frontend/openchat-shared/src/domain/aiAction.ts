// Generic in-OpenChat AI-action runner.
//
// A registered app declares an AiAction (prompt + output schema + a card template + the recipient public key
// it wants confirmed actions encrypted to). The runner takes a message's content (image/text), runs the
// user's selected ON-DEVICE model against the declared prompt, parses the structured result, and builds a
// confirmable ActionCard whose rows come from the template and whose delivery routing (recipientPublicKey +
// an opaque confirmPayload) targets the registered consumer. Nothing here is app-specific — every app-specific
// value comes from the registration. The card is then posted by the caller; on confirm OpenChat encrypts the
// payload to the recipient and deposits it into the on-chain action_inbox.

import type { ActionCardContent, ActionCardRow } from "./chat/chat";
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
}

export type RunAiActionResult =
    | { kind: "ready"; card: ActionCardContent; extracted: Record<string, unknown> }
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

// Pure: turn a registered action + a structured extraction + the recipient key into a postable ActionCard.
// `rows` come from the template (only non-empty values are shown); `confirmPayload` is the verbatim JSON of the
// extraction — opaque to OpenChat, exactly what the consumer's client parses after decrypting it from the inbox.
export function buildActionCardContent(
    def: AiActionDefinition,
    extracted: Record<string, unknown>,
    recipientPublicKeyPem: string,
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
        disclosure: def.card.disclosure,
        state: "pending",
        recipientPublicKey: recipientPublicKeyPem,
        confirmPayload: new TextEncoder().encode(JSON.stringify(extracted)),
    };
}

// Orchestrates the full proposal: run the on-device model against the declared prompt, parse, and build the
// card. `infer` is the on-device inference facade (injected so this is unit-testable without a native runtime).
export async function runAiAction(
    def: AiActionDefinition,
    input: { image?: Uint8Array; text?: string; modelId?: string },
    recipientPublicKeyPem: string,
    infer: (req: InferenceRequest) => Promise<InferenceResult>,
): Promise<RunAiActionResult> {
    const result = await infer({
        modelId: input.modelId,
        prompt: def.promptTemplate,
        image: input.image,
        text: input.text,
        responseSchema: def.responseSchema,
    });

    if (result.kind === "unavailable") return { kind: "unavailable", reason: result.reason };
    if (result.kind === "error") return { kind: "error", error: result.error };

    const extracted = parseExtraction(result.text);
    if (extracted === undefined) return { kind: "no_extraction", raw: result.text };

    return { kind: "ready", card: buildActionCardContent(def, extracted, recipientPublicKeyPem), extracted };
}
