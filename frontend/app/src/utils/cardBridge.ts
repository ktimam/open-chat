// App-rendered confirmable cards — the OpenChat side of the postMessage bridge (see
// fork-notes/08-app-rendered-cards.md §"Bridge protocol"). When a confirmable card's app declares a
// surface of kind "card", OpenChat embeds the app's page in an iframe and this module builds/validates
// the messages that flow across the seam. All functions here are pure so they can be unit-tested away
// from the DOM; ActionCardContent.svelte owns the actual window listener + iframe wiring.

// The context OpenChat hands the card iframe alongside the prefill data.
export interface CardInitContext {
    // The canonical chat key for this chat (chatKeyFor); undefined only for chat kinds that render none.
    chatKey: string | undefined;
    appId: number;
    actionId: string;
    // The host's current resolved theme mode, so the app can match OpenChat's look.
    theme: "light" | "dark";
    // True when the card is not actionable (already consumed, or the viewer may not act): the app
    // should render read-only and must not offer confirm/cancel.
    readonly: boolean;
}

// Host -> iframe init message (the app replies to its own oc:card:ready with this).
export interface CardInitMessage {
    type: "oc:card:init";
    version: 1;
    // The decoded confirmPayload (prefill values). `{}` when the card carries no payload.
    data: Record<string, unknown>;
    context: CardInitContext;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The card iframe's origin, derived from its (already placeholder-substituted) surface URL. Used both
// as the postMessage targetOrigin and as the allow-list for inbound messages. Returns undefined for a
// URL we cannot parse (or a non-http(s) scheme) — the caller then declines to embed, staying on the
// backward-compatible OC-rendered rows rather than talking to an unknown origin.
export function deriveCardOrigin(url: string): string | undefined {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return undefined;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    return parsed.origin;
}

// Decode the card's frozen confirmPayload (opaque JSON bytes) into the prefill object. Tolerant by
// design: absent/empty bytes, non-JSON, or a non-object top level all degrade to `{}` so the app card
// still mounts and simply renders its own defaults. (On a RECEIVED card the payload is not hydrated
// today, so `{}` is the normal Phase-1 case; the edited values the user submits are what matter.)
export function decodeConfirmPayload(bytes?: Uint8Array): Record<string, unknown> {
    if (bytes === undefined || bytes.byteLength === 0) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return {};
    }
    return isRecord(parsed) ? parsed : {};
}

// Reverse-map a message's HYDRATED display rows back into the structured object the app's card page
// consumes. `content.rows` arrive as {label, value}; the app's manifest card template declares, per
// row, the field KEY behind each label (`labelToField[label] = valueKey`). Joining on label rebuilds
// `{ field: value }` — e.g. IOU's rows → { amount, currency, direction, note } (EntryDraft-shaped).
//
// This exists because the frozen confirmPayload is NOT hydrated on a received card today, so decoding
// it yields `{}`; the rows are the only place the extracted values survive the round-trip. Generic —
// no app-specific field names live here. A label with no manifest mapping falls back to its own
// lowercased text so an unexpected/extra row is surfaced rather than silently dropped. Empty rows → {}.
export function reverseMapRows(
    rows: readonly { label: string; value: string }[],
    labelToField: Record<string, string>,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const row of rows) {
        const key = labelToField[row.label] ?? row.label.toLowerCase();
        out[key] = row.value;
    }
    return out;
}

export function buildCardInit(
    data: Record<string, unknown>,
    context: CardInitContext,
): CardInitMessage {
    return { type: "oc:card:init", version: 1, data, context };
}

// Clamp a resize request to a sane range so a misbehaving (or hostile) iframe cannot collapse the
// bubble to nothing or grow it without bound. Non-finite requests fall back to the minimum.
export function clampCardHeight(height: number, min: number, max: number): number {
    if (!Number.isFinite(height)) return min;
    return Math.max(min, Math.min(max, Math.ceil(height)));
}
