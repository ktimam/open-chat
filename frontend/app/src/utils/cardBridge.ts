// App-rendered confirmable cards — the OpenChat side of the postMessage bridge. When a confirmable
// card's app declares a
// surface of kind "card", OpenChat embeds the app's page in an iframe and this module builds/validates
// the messages that flow across the seam. All functions here are pure so they can be unit-tested away
// from the DOM; ActionCardContent.svelte owns the actual window listener + iframe wiring.

import {
    type AppScopedCardContext,
    type AiAppCardChatContext,
    isSafeAiActionFieldName,
} from "openchat-shared";

// Reserved legacy rows are ignored fail-closed. They are never parsed or forwarded as app data.
const RESERVED_CARD_ROW_PREFIX = "__oc_";

export interface CardPrivateContext {
    // Opaque, short-lived authority. It is delivered only to the exact sandboxed WindowProxy after
    // a source + opaque-origin + per-load nonce checked handshake.
    capability: string;
    // Epoch milliseconds.
    expiresAt: bigint;
    // Pseudonymous correlation handles returned by UserIndex with the bearer. No raw OpenChat
    // account, chat, thread, or message coordinate is ever posted into the app iframe.
    context: AppScopedCardContext;
}

export function isAppCardContentAttested(card: {
    appVerified?: boolean;
    appContentVerified?: boolean;
}): boolean {
    return card.appVerified === true && card.appContentVerified === true;
}

// The context OpenChat hands the card iframe alongside the prefill data.
export interface CardInitContext {
    appId: number;
    appRevision: bigint;
    actionId: string;
    // The host's current resolved theme mode, so the app can match OpenChat's look.
    theme: "light" | "dark";
    // True when the card is not actionable (already consumed, or the viewer may not act): the app
    // should render read-only and must not offer confirm/cancel.
    readonly: boolean;
    privateContext?: CardPrivateContext;
}

// Host -> iframe init message (the app replies to its own oc:card:ready with this).
export interface CardInitMessage {
    type: "oc:card:init";
    version: 2;
    frameNonce: string;
    // The decoded confirmPayload (prefill values). `{}` when the card carries no payload.
    data: Record<string, unknown>;
    context: CardInitContext;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

// Sandboxed app cards have an opaque origin ("null"), so the WindowProxy identity and the
// host-generated frame nonce are both mandatory. A new document keeps the iframe WindowProxy but
// receives a new nonce on load; an old document/message therefore cannot cross a navigation.
export function isCardBridgeEventForFrame(
    event: { source: unknown; origin: string; data: unknown },
    expectedSource: unknown,
    expectedOrigin: string,
    expectedFrameNonce: string,
): boolean {
    return (
        expectedSource !== null &&
        expectedSource !== undefined &&
        event.source === expectedSource &&
        event.origin === expectedOrigin &&
        isRecord(event.data) &&
        event.data.frameNonce === expectedFrameNonce
    );
}

export interface CardReadyMessage {
    type: "oc:card:ready";
    version: 2;
    frameNonce: string;
}

export interface CardPrivateContextReadyMessage {
    type: "oc:card:private-context-ready";
    version: 2;
    frameNonce: string;
    privateContext: { recipientKeyScheme: string; recipientPublicKey: string };
}

export function canAcceptCardPrivateContextReady(input: {
    explicitlyRequested: boolean;
    featureAvailable: boolean;
    alreadyGranted: boolean;
    pending: boolean;
    readonly: boolean;
}): boolean {
    return (
        input.explicitlyRequested &&
        input.featureAvailable &&
        !input.alreadyGranted &&
        input.pending &&
        !input.readonly
    );
}

export function isCardPublicReadyMessage(
    message: unknown,
    expectedFrameNonce: string,
): message is CardReadyMessage {
    return (
        isRecord(message) &&
        message.type === "oc:card:ready" &&
        message.version === 2 &&
        message.frameNonce === expectedFrameNonce
    );
}

export interface CardRecipientKey {
    scheme: string;
    publicKey: Uint8Array;
}

export interface CardCapabilityAttemptBinding {
    frameNonce: string;
    recipientKeyScheme: string;
    recipientPublicKey: Uint8Array;
    // Stable identity of the verified card context (chat/message/thread/app revision/action).
    cardKey: string;
}

export interface CardAttemptContext {
    viewerId: string;
    chat: AiAppCardChatContext;
    messageId: bigint;
    threadRootMessageIndex?: number;
    appId: number;
    appRevision: bigint;
    actionId: string;
}

// In-memory equality key only: never persisted, logged, or placed in a URL. JSON's explicit array
// boundaries avoid delimiter ambiguity in attacker-controlled action/principal text.
export function cardAttemptKey(context: CardAttemptContext): string {
    const chat =
        context.chat.kind === "group"
            ? ["group", context.chat.groupId]
            : context.chat.kind === "channel"
              ? ["channel", context.chat.communityId, context.chat.channelId]
              : ["direct", context.chat.userIds[0], context.chat.userIds[1]];
    return JSON.stringify([
        "oc-card-attempt-v1",
        context.viewerId,
        chat,
        context.threadRootMessageIndex ?? null,
        context.messageId.toString(),
        context.appId,
        context.appRevision.toString(),
        context.actionId,
    ]);
}

export function beginCardCapabilityAttempt(
    active: CardCapabilityAttemptBinding | undefined,
    binding: CardCapabilityAttemptBinding,
): CardCapabilityAttemptBinding | undefined {
    if (active !== undefined) return undefined;
    return { ...binding, recipientPublicKey: binding.recipientPublicKey.slice() };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    return left.byteLength === right.byteLength && left.every((value, i) => value === right[i]);
}

export function cardCapabilityAttemptStillCurrent(
    attempt: CardCapabilityAttemptBinding,
    current: CardCapabilityAttemptBinding,
    mounted: boolean,
): boolean {
    return (
        mounted &&
        attempt.frameNonce === current.frameNonce &&
        attempt.recipientKeyScheme === current.recipientKeyScheme &&
        attempt.cardKey === current.cardKey &&
        equalBytes(attempt.recipientPublicKey, current.recipientPublicKey)
    );
}

// The key is intentionally opaque to OpenChat: each generic app names its own bounded scheme and
// validates the key semantics on redemption. OpenChat only enforces an unambiguous encoding and a
// conservative 16..512-byte envelope before calling the authenticated capability endpoint.
export function decodeCardRecipientPublicKey(
    message: unknown,
    expectedFrameNonce: string,
): CardRecipientKey | undefined {
    if (
        !isRecord(message) ||
        message.type !== "oc:card:private-context-ready" ||
        message.version !== 2
    ) {
        return undefined;
    }
    if (message.frameNonce !== expectedFrameNonce) return undefined;
    const privateContext = message.privateContext;
    if (!isRecord(privateContext)) return undefined;
    const scheme = privateContext.recipientKeyScheme;
    if (typeof scheme !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(scheme)) {
        return undefined;
    }
    const encoded = privateContext.recipientPublicKey;
    if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]{22,683}$/.test(encoded)) return undefined;
    if (encoded.length % 4 === 1) return undefined;
    try {
        const standard = encoded.replaceAll("-", "+").replaceAll("_", "/");
        const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
        const binary = atob(padded);
        if (binary.length < 16 || binary.length > 512) return undefined;
        return {
            scheme,
            publicKey: Uint8Array.from(binary, (c) => c.charCodeAt(0)),
        };
    } catch {
        return undefined;
    }
}

// A confirm payload from an app card is either a single object or a top-level array. It is accepted
// only from an explicit iframe request and its exact encoded bytes require a one-time server grant.
// Public display rows are never parsed to reconstruct this payload.
export function isCardConfirmPayload(value: unknown): value is Record<string, unknown> | unknown[] {
    return isRecord(value) || Array.isArray(value);
}

// Loopback hosts where http is tolerated for local development. WHATWG URL reports an IPv6 host with
// its brackets (e.g. "[::1]"), so both bracketed and bare forms are listed.
function ipv4Octets(hostname: string): number[] | undefined {
    const parts = hostname.split(".");
    if (parts.length !== 4) return undefined;
    const octets = parts.map(Number);
    return octets.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)
        ? octets
        : undefined;
}

function isNonPublicIpv4([a, b, c]: number[]): boolean {
    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 0) ||
        (a === 192 && b === 168) ||
        (a === 198 && (b === 18 || b === 19 || b === 51) && (b !== 51 || c === 100)) ||
        (a === 203 && b === 0 && c === 113) ||
        a >= 224
    );
}

function expandIpv6(hostname: string): number[] | undefined {
    const raw = hostname.replace(/^\[|\]$/g, "").toLowerCase().split("%")[0];
    if (!raw.includes(":")) return undefined;
    const halves = raw.split("::");
    if (halves.length > 2) return undefined;
    const parse = (part: string): number[] | undefined => {
        if (part === "") return [];
        const words = part.split(":");
        const parsed = words.map((word) => Number.parseInt(word, 16));
        return words.every((word, i) => /^[0-9a-f]{1,4}$/.test(word) && parsed[i] <= 0xffff)
            ? parsed
            : undefined;
    };
    const left = parse(halves[0]);
    const right = parse(halves[1] ?? "");
    if (left === undefined || right === undefined) return undefined;
    const omitted = 8 - left.length - right.length;
    if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) {
        return undefined;
    }
    return [...left, ...Array.from({ length: omitted }, () => 0), ...right];
}

function isNonPublicNetworkHost(hostname: string): boolean {
    const normalized = hostname.toLowerCase().replace(/\.$/, "");
    if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
    const ipv4 = ipv4Octets(normalized);
    if (ipv4 !== undefined) return isNonPublicIpv4(ipv4);
    const ipv6 = expandIpv6(normalized);
    if (ipv6 === undefined) return false;
    const [first, second, third, fourth, fifth, sixth, seventh, eighth] = ipv6;
    if (ipv6.every((word) => word === 0)) return true;
    if (ipv6.slice(0, 7).every((word) => word === 0) && eighth === 1) return true;
    if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) return true;
    if ((first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00) return true;
    if (first === 0x2001 && second === 0x0db8) return true;
    if (first === 0x2001 && second === 0) return true; // Teredo/other transition range.
    if (first === 0x2002) return true; // 6to4 can tunnel private IPv4 endpoints.
    // IPv4-compatible and IPv4-mapped IPv6 literals.
    if (
        first === 0 &&
        second === 0 &&
        third === 0 &&
        fourth === 0 &&
        fifth === 0 &&
        (sixth === 0 || sixth === 0xffff)
    ) {
        return isNonPublicIpv4([seventh >> 8, seventh & 0xff, eighth >> 8, eighth & 0xff]);
    }
    return false;
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

// The card iframe's network destination, derived from its (already placeholder-substituted) surface
// URL. The sandboxed document itself has opaque origin `null`, so bridge messages are separately bound
// to its exact WindowProxy and per-load nonce. Returns undefined — the
// caller then declines to embed, staying on the backward-compatible OC-rendered rows rather than
// talking to an origin we won't trust — when the URL is:
//   - unparseable, or a non-http(s) scheme (javascript:/data:/…);
//   - credential-bearing (userinfo in an embed URL is never legitimate);
//   - plaintext http on a NON-loopback host (a downgrade / network-tamper vector — a legitimate app
//     card is served over https; loopback http is kept for local dev);
//   - the OpenChat host's OWN origin (defense-in-depth: a card must be THIRD-PARTY, storage-partitioned
//     content — host-origin content in the frame could reach the host's own session/storage, and an
//     app card is never legitimately served from the host origin). Pass `hostOrigin` to override the
//     host detection (tests); it defaults to window.location.origin when a DOM is present.
export interface CardOriginOptions {
    hostOrigin?: string;
    allowLocalDevelopment?: boolean;
}

export function deriveCardOrigin(
    url: string,
    hostOriginOrOptions?: string | CardOriginOptions,
): string | undefined {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return undefined;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    if (parsed.username !== "" || parsed.password !== "") return undefined;
    const options =
        typeof hostOriginOrOptions === "string"
            ? { hostOrigin: hostOriginOrOptions }
            : (hostOriginOrOptions ?? {});
    const nonPublicHost = isNonPublicNetworkHost(parsed.hostname);
    if (nonPublicHost && !options.allowLocalDevelopment) return undefined;
    if (parsed.protocol === "http:" && !(nonPublicHost && options.allowLocalDevelopment)) {
        return undefined;
    }
    const host = options.hostOrigin ?? defaultHostOrigin();
    if (host !== undefined && parsed.origin === host) return undefined;
    return parsed.origin;
}

const MAX_AI_APP_SURFACE_URL_LENGTH = 4_096;

// Shared normalization gate for every app-declared destination, whether it is embedded or handed to
// the system browser. Returning the browser's canonical href also binds consent to one exact URL.
export function normalizeAiAppSurfaceUrl(
    url: string,
    options?: CardOriginOptions,
): string | undefined {
    if (url.length === 0 || url.length > MAX_AI_APP_SURFACE_URL_LENGTH) return undefined;
    if (deriveCardOrigin(url, options) === undefined) return undefined;
    try {
        return new URL(url).href;
    } catch {
        return undefined;
    }
}

export function isEmbeddedSurfaceConsentCurrent(
    consentedUrl: string | undefined,
    currentNormalizedUrl: string | undefined,
): boolean {
    return (
        consentedUrl !== undefined &&
        currentNormalizedUrl !== undefined &&
        consentedUrl === currentNormalizedUrl
    );
}

export function supportsCredentiallessIframe(framePrototype?: object): boolean {
    const prototype =
        framePrototype ??
        (typeof HTMLIFrameElement === "undefined" ? undefined : HTMLIFrameElement.prototype);
    return prototype !== undefined && "credentialless" in prototype;
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
// `{ field: value }` — e.g. ledger rows → { amount, currency, direction, note }.
//
// This exists because the frozen confirmPayload is NOT hydrated on a received card today, so decoding
// it yields `{}`; the rows are the only place the extracted values survive the round-trip. Generic —
// no app-specific field names live here. Only an own, safe manifest mapping is accepted: inventing a
// key from an unexpected label makes labels such as `__proto__` a data-model boundary. Empty or
// unmapped rows produce an empty null-prototype record.
export function reverseMapRows(
    rows: readonly { label: string; value: string }[],
    labelToField: Record<string, string>,
): Record<string, unknown> {
    const out = Object.create(null) as Record<string, unknown>;
    for (const row of rows) {
        // Reserved legacy rows are not app data. Ignore them without inspecting their values.
        if (row.label.startsWith(RESERVED_CARD_ROW_PREFIX)) continue;
        if (!Object.hasOwn(labelToField, row.label)) continue;
        const key = labelToField[row.label];
        if (!isSafeAiActionFieldName(key) || Object.hasOwn(out, key)) continue;
        out[key] = row.value;
    }
    return out;
}

// Public summary rows for the classic renderer. Reserved legacy rows are suppressed fail-closed and
// never parsed, forwarded, or treated as a payload. Generic over the row shape so the Svelte
// `{#each}` keeps its own row type.
export function visibleRows<R extends { label: string }>(rows: readonly R[]): R[] {
    return rows.filter((r) => !r.label.startsWith(RESERVED_CARD_ROW_PREFIX));
}

export function buildCardInit(
    data: Record<string, unknown>,
    context: CardInitContext,
    frameNonce: string,
): CardInitMessage {
    return { type: "oc:card:init", version: 2, frameNonce, data, context };
}

export function newCardFrameNonce(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export const CARD_HANDSHAKE_TIMEOUT_MS = 10_000;

// A frame blocked by CSP/network policy (or one that never implements the nonce-bound v2 ready
// handshake) must not remain an invisible 1px element forever. Returning cleanup makes Svelte effects,
// retries, navigation, and a successful ready message cancel the exact outstanding deadline.
export function startCardHandshakeTimeout(
    onTimeout: () => void,
    timeoutMs = CARD_HANDSHAKE_TIMEOUT_MS,
): () => void {
    let active = true;
    const handle = setTimeout(() => {
        if (active) onTimeout();
    }, timeoutMs);
    return () => {
        active = false;
        clearTimeout(handle);
    };
}

export function buildCardBootstrap(frameNonce: string): {
    type: "oc:card:bootstrap";
    version: 2;
    frameNonce: string;
} {
    return { type: "oc:card:bootstrap", version: 2, frameNonce };
}

// Sent only after the user chooses the separate host-owned Share private context action. The public
// ready/init handshake never asks the external frame to create or disclose a recipient key.
export function buildCardPrivateContextRequest(frameNonce: string): {
    type: "oc:card:private-context-request";
    version: 2;
    frameNonce: string;
} {
    return { type: "oc:card:private-context-request", version: 2, frameNonce };
}

// A generic host→iframe progress signal: OpenChat relays the confirm/cancel round-trip state so the
// app card (whose buttons live inside the iframe now) can lock its controls and show progress. A bare
// boolean — no app or canister data — posted only to the exact card WindowProxy; `busy` already resets on
// success OR failure (doRespond's finally), so the app re-enables correctly either way.
export function buildCardBusy(
    busy: boolean,
    frameNonce: string,
): { type: "oc:card:busy"; version: 2; frameNonce: string; busy: boolean } {
    return { type: "oc:card:busy", version: 2, frameNonce, busy };
}

type JsonScalar = string | number | boolean | null;
export type CardPayload = JsonScalar | CardPayload[] | { [key: string]: CardPayload };
export type CardApprovalRequest =
    | { kind: "confirm"; payload: Record<string, CardPayload> | CardPayload[] }
    | { kind: "cancel" };

const MAX_CONFIRM_PAYLOAD_BYTES = 16_384;
const MAX_CONFIRM_PAYLOAD_DEPTH = 16;
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function cloneJsonValue(value: unknown, depth: number): CardPayload | undefined {
    if (depth > MAX_CONFIRM_PAYLOAD_DEPTH) return undefined;
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
    if (Array.isArray(value)) {
        const result: CardPayload[] = [];
        for (const item of value) {
            const cloned = cloneJsonValue(item, depth + 1);
            if (cloned === undefined) return undefined;
            result.push(cloned);
        }
        return result;
    }
    if (!isRecord(value)) return undefined;
    const result: { [key: string]: CardPayload } = {};
    for (const [key, item] of Object.entries(value)) {
        if (FORBIDDEN_OBJECT_KEYS.has(key)) return undefined;
        const cloned = cloneJsonValue(item, depth + 1);
        if (cloned === undefined) return undefined;
        result[key] = cloned;
    }
    return result;
}

function deepFreezePayload<T extends CardPayload>(value: T): T {
    if (typeof value !== "object" || value === null) return value;
    for (const nested of Object.values(value)) deepFreezePayload(nested);
    return Object.freeze(value);
}

// A frame may REQUEST confirmation, but it never receives authority to execute it. Copy the payload
// into a bounded JSON-only snapshot so later iframe mutations cannot alter what the host-owned
// approval UI shows/approves, and reject values the canister's JSON encoder cannot represent.
export function snapshotCardConfirmPayload(
    value: unknown,
): Record<string, CardPayload> | CardPayload[] | undefined {
    if (!isCardConfirmPayload(value)) return undefined;
    const cloned = cloneJsonValue(value, 0);
    if (cloned === undefined || (!Array.isArray(cloned) && !isRecord(cloned))) return undefined;
    const encoded = JSON.stringify(cloned);
    if (new TextEncoder().encode(encoded).byteLength > MAX_CONFIRM_PAYLOAD_BYTES) return undefined;
    return deepFreezePayload(cloned) as Record<string, CardPayload> | CardPayload[];
}

export function cardApprovalRequestFromMessage(
    message: unknown,
    expectedFrameNonce: string,
): CardApprovalRequest | undefined {
    if (!isRecord(message)) return undefined;
    if (message.version !== 2) return undefined;
    if (message.frameNonce !== expectedFrameNonce) return undefined;
    if (message.type === "oc:card:cancel") return { kind: "cancel" };
    if (message.type !== "oc:card:confirm") return undefined;
    const payload = snapshotCardConfirmPayload(message.payload);
    return payload === undefined ? undefined : { kind: "confirm", payload };
}

export function cardResizeHeightFromMessage(
    message: unknown,
    expectedFrameNonce: string,
): number | undefined {
    if (
        !isRecord(message) ||
        message.type !== "oc:card:resize" ||
        message.version !== 2 ||
        message.frameNonce !== expectedFrameNonce ||
        typeof message.height !== "number" ||
        !Number.isFinite(message.height)
    ) {
        return undefined;
    }
    return message.height;
}

export function canApproveCardRequest(
    request: CardApprovalRequest | undefined,
    actionable: boolean,
    busy: boolean,
    disclosureRequired: boolean,
    disclosureAcknowledged: boolean,
): boolean {
    return (
        request !== undefined &&
        actionable &&
        !busy &&
        (request.kind === "cancel" || !disclosureRequired || disclosureAcknowledged)
    );
}

function canonicalJson(value: CardPayload): CardPayload {
    if (Array.isArray(value)) return value.map(canonicalJson);
    if (typeof value !== "object" || value === null) return value;
    const sorted = Object.create(null) as { [key: string]: CardPayload };
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalJson(value[key]);
    return sorted;
}

// JSON.stringify already escapes C0 controls inside keys/values. Escape the remaining literal C1,
// format/bidi/zero-width controls (plus Unicode line separators) so an untrusted key/value cannot
// reorder or conceal the host-owned approval summary. The resulting string remains valid JSON and
// parses back to the exact frozen payload.
const APPROVAL_DISPLAY_CONTROL = /[\u007F-\u009F\p{Cf}\u2028\u2029]/gu;

function escapeApprovalDisplayControls(serialized: string): string {
    return serialized.replace(APPROVAL_DISPLAY_CONTROL, (character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        if (codePoint <= 0xffff) return `\\u${codePoint.toString(16).padStart(4, "0")}`;
        const adjusted = codePoint - 0x10000;
        const high = 0xd800 + (adjusted >> 10);
        const low = 0xdc00 + (adjusted & 0x3ff);
        return `\\u${high.toString(16)}\\u${low.toString(16)}`;
    });
}

// Host-owned text shown immediately beside the semantic approval control. Svelte renders this as
// text (never HTML), and the renderer passes the same frozen request.payload object to doRespond.
export function canonicalCardApprovalSummary(request: CardApprovalRequest): string {
    return request.kind === "cancel"
        ? "The app requests cancellation; no payload will be submitted."
        : escapeApprovalDisplayControls(JSON.stringify(canonicalJson(request.payload), null, 2));
}

export function cardResponseForApproval(request: CardApprovalRequest): {
    response: "confirm" | "cancel";
    payload?: Record<string, CardPayload> | CardPayload[];
} {
    return request.kind === "confirm"
        ? { response: "confirm", payload: request.payload }
        : { response: "cancel" };
}

export function encodeCardConfirmPayload(request: CardApprovalRequest): Uint8Array | undefined {
    return request.kind === "confirm"
        ? new TextEncoder().encode(JSON.stringify(request.payload))
        : undefined;
}

export interface CardConfirmationAttemptBinding {
    frameNonce: string;
    cardKey: string;
    confirmPayload: Uint8Array;
}

export function beginCardConfirmationAttempt(
    active: CardConfirmationAttemptBinding | undefined,
    binding: CardConfirmationAttemptBinding,
): CardConfirmationAttemptBinding | undefined {
    if (active !== undefined || binding.confirmPayload.byteLength === 0) return undefined;
    return { ...binding, confirmPayload: binding.confirmPayload.slice() };
}

export function cardConfirmationAttemptStillCurrent(
    attempt: CardConfirmationAttemptBinding,
    current: CardConfirmationAttemptBinding,
    mounted: boolean,
): boolean {
    return (
        mounted &&
        attempt.frameNonce === current.frameNonce &&
        attempt.cardKey === current.cardKey &&
        equalBytes(attempt.confirmPayload, current.confirmPayload)
    );
}

// Clamp a resize request to a sane range so a misbehaving (or hostile) iframe cannot collapse the
// bubble to nothing or grow it without bound. Non-finite requests fall back to the minimum.
export function clampCardHeight(height: number, min: number, max: number): number {
    if (!Number.isFinite(height)) return min;
    return Math.max(min, Math.min(max, Math.ceil(height)));
}
