// App-rendered confirmable cards — the OpenChat side of the postMessage bridge (see
// fork-notes/08-app-rendered-cards.md §"Bridge protocol"). When a confirmable card's app declares a
// surface of kind "card", OpenChat embeds the app's page in an iframe and this module builds/validates
// the messages that flow across the seam. All functions here are pure so they can be unit-tested away
// from the DOM; ActionCardContent.svelte owns the actual window listener + iframe wiring.

import { OC_ENTRIES_ROW_LABEL, OC_HIDDEN_ROW_PREFIX } from "openchat-shared";

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

// Loopback hosts where http is tolerated for local development. WHATWG URL reports an IPv6 host with
// its brackets (e.g. "[::1]"), so both bracketed and bare forms are listed.
function isLoopbackHost(hostname: string): boolean {
    return (
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "[::1]" ||
        hostname === "::1"
    );
}

// The OpenChat host's own origin, read guardedly so this module stays unit-testable away from the DOM
// (window may be absent). Tests inject `hostOrigin` explicitly instead of relying on this.
function defaultHostOrigin(): string | undefined {
    try {
        if (typeof window !== "undefined" && typeof window.location?.origin === "string") {
            return window.location.origin;
        }
    } catch {
        // window/location access can throw in locked-down sandboxes — treat as "unknown host".
    }
    return undefined;
}

// The card iframe's origin, derived from its (already placeholder-substituted) surface URL. Used both
// as the postMessage targetOrigin and as the allow-list for inbound messages. Returns undefined — the
// caller then declines to embed, staying on the backward-compatible OC-rendered rows rather than
// talking to an origin we won't trust — when the URL is:
//   - unparseable, or a non-http(s) scheme (javascript:/data:/…);
//   - plaintext http on a NON-loopback host (a downgrade / network-tamper vector — a legitimate app
//     card is served over https; loopback http is kept for local dev);
//   - the OpenChat host's OWN origin (defense-in-depth: a card must be THIRD-PARTY, storage-partitioned
//     content — host-origin content in the frame could reach the host's own session/storage, and an
//     app card is never legitimately served from the host origin). Pass `hostOrigin` to override the
//     host detection (tests); it defaults to window.location.origin when a DOM is present.
export function deriveCardOrigin(url: string, hostOrigin?: string): string | undefined {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return undefined;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) return undefined;
    const host = hostOrigin ?? defaultHostOrigin();
    if (host !== undefined && parsed.origin === host) return undefined;
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
        // Hidden control rows (e.g. a multi-entry card's OC_ENTRIES_ROW_LABEL sentinel) ride through the
        // hydrated rows for the app card to read; they are never fields, so never reverse-map them.
        if (row.label.startsWith(OC_HIDDEN_ROW_PREFIX)) continue;
        const key = labelToField[row.label] ?? row.label.toLowerCase();
        out[key] = row.value;
    }
    return out;
}

// The rows a HUMAN should see in the classic (OC-rendered) fallback card: every row EXCEPT the hidden
// `__oc_` control rows (e.g. a multi-entry card's OC_ENTRIES_ROW_LABEL sentinel), which ride through
// the hydrated rows so the app card can read them but must never render as a visible row. Generic over
// the row shape so the Svelte `{#each}` keeps its own row type. If this drop is removed, a raw
// __oc_entries__ JSON blob would render as a visible row whenever the app-card surface lookup fails.
export function visibleRows<R extends { label: string }>(rows: readonly R[]): R[] {
    return rows.filter((r) => !r.label.startsWith(OC_HIDDEN_ROW_PREFIX));
}

// A multi-entry card carries its EXACT validated entry array through a hidden sentinel row
// (OC_ENTRIES_ROW_LABEL) because the read path strips confirm_payload while still hydrating rows.
// Find that row and JSON.parse its value back into the array, so the app-rendered card receives every
// entry (2..N) instead of the flattened per-entry summaries. Returns the array when the sentinel is
// present AND decodes to an array; undefined otherwise (single-entry cards, or a malformed sentinel,
// fall back to the normal decoded-payload / reverse-map prefill path).
export function extractEntriesRow(
    rows: readonly { label: string; value: string }[],
): unknown[] | undefined {
    const row = rows.find((r) => r.label === OC_ENTRIES_ROW_LABEL);
    if (row === undefined) return undefined;
    try {
        const parsed: unknown = JSON.parse(row.value);
        return Array.isArray(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

export function buildCardInit(
    data: Record<string, unknown>,
    context: CardInitContext,
): CardInitMessage {
    return { type: "oc:card:init", version: 1, data, context };
}

// A generic host→iframe progress signal: OpenChat relays the confirm/cancel round-trip state so the
// app card (whose buttons live inside the iframe now) can lock its controls and show progress. A bare
// boolean — no app or canister data — posted only to the card's own origin; `busy` already resets on
// success OR failure (doRespond's finally), so the app re-enables correctly either way.
export function buildCardBusy(busy: boolean): { type: "oc:card:busy"; version: 1; busy: boolean } {
    return { type: "oc:card:busy", version: 1, busy };
}

// Clamp a resize request to a sane range so a misbehaving (or hostile) iframe cannot collapse the
// bubble to nothing or grow it without bound. Non-finite requests fall back to the minimum.
export function clampCardHeight(height: number, min: number, max: number): number {
    if (!Number.isFinite(height)) return min;
    return Math.max(min, Math.min(max, Math.ceil(height)));
}
