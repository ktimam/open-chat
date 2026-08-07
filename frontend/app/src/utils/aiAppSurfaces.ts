// Post-confirm app surfaces — fully generic, driven only by registered manifest data.
//
// An AI app's manifest may declare `surfaces`: URL templates OpenChat opens on the app's behalf.
// The only kind OpenChat understands today is "chat_link" — a page where the user configures/links
// a chat INSIDE the app. OpenChat opens it once per (app, chat), right after the first successfully
// confirmed action card in that chat (and any time on demand from the group-details Apps row).
// Surface kinds OpenChat does not know are ignored.

import type { OpenChat } from "@client";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import type { AiAppRegistration, AiAppSurface, ChatIdentifier } from "@shared";
import { chatKeyFor, isSafeAiActionFieldName } from "@shared";
import { normalizeAiAppSurfaceUrl } from "./cardBridge";
import { configKeys } from "./config";
import { resolveConnectedDirectChatAiApp } from "./aiAppDirectChat";
import { openExternalUrl } from "./urls";

export type AiAppSurfaceDataDisclosure =
    | "app_id"
    | "one_time_chat_link_token"
    | "chat_id"
    | "direct_participant_ids";

// A surface resolved against a concrete chat: everything a layout needs to present it.
export interface SurfaceOpening {
    app: AiAppRegistration;
    surface: AiAppSurface;
    // The surface URL with its optional public {appId} placeholder substituted.
    url: string;
    // Values visibly included in the destination URL. Host-owned consent UI renders these
    // categories before an iframe request or browser handoff.
    dataDisclosures: AiAppSurfaceDataDisclosure[];
}

export interface ChatLinkSurfaceOpening extends SurfaceOpening {
    chatLinkToken: Uint8Array;
    expiresAt: bigint;
}

// A "card" surface resolved for a specific action, carrying the extra data the in-bubble card renderer
// needs beyond the URL.
export interface CardSurfaceOpening extends SurfaceOpening {
    // The OWNING action's manifest card template as a label -> field-key map (from card.rows'
    // {label, valueKey}). Lets ActionCardContent reverse-map the message's hydrated {label, value}
    // rows back into the structured {field: value} object the card page consumes — needed because the
    // frozen confirmPayload is not hydrated on a received card today.
    labelToField: Record<string, string>;
}

// Host-owned identity copied from the exact published registry revision carried by a card. Unlike
// ActionCardContent.title, none of these values come from the message sender.
export interface AuthoritativeAppIdentity {
    id: number;
    name: string;
    iconUrl?: string;
}

// A resolved action owner always exposes authoritative identity, even when it has no iframe surface.
// This lets the classic OpenChat-rendered card display the same provenance chrome as an app-rendered
// card without treating the sender's title as app identity.
export interface ResolvedActionApp {
    identity: AuthoritativeAppIdentity;
    cardSurface?: CardSurfaceOpening;
}

// The surface kinds OpenChat knows how to act on.
// "chat_link": a page where the user configures/links a CHAT inside the app.
const CHAT_LINK_KIND = "chat_link";
const CHAT_LINK_TOKEN_PLACEHOLDER = "{chatLinkToken}";
// "connect": the app's claim-token entry page — where the user pastes the high-entropy token the
// consent sheet displays. Chat-independent (only {appId} is substituted); the pairing sheet offers
// it as an "open the right page" shortcut so the user isn't left hunting through the app's menus.
const CONNECT_KIND = "connect";
// "home": the app's own webpage, offered from its directory detail sheet. display "sheet" embeds
// it right in the OpenChat window (the iframe host); "external" hands off to the OS browser.
const HOME_KIND = "home";
// "card": the app's confirmable-card renderer, embedded in the chat bubble. When an app declares
// one, OpenChat embeds this page in an
// iframe in place of its own OC-rendered rows/buttons, and the postMessage bridge relays confirm/cancel.
const CARD_KIND = "card";
const MAX_ICON_URL_LENGTH = 2_000;

function isLoopbackHost(hostname: string): boolean {
    return (
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "[::1]" ||
        hostname === "::1"
    );
}

// Defense in depth for host-owned chrome. Published manifests are validated on-chain, but older or
// malformed cached data must not turn the trusted app badge into a credential-bearing, plaintext, or
// active-scheme resource. Mirrors the registry's HTTPS / local-test loopback policy.
export function validatedAppIconUrl(iconUrl?: string): string | undefined {
    if (iconUrl === undefined || iconUrl.length === 0 || iconUrl.length > MAX_ICON_URL_LENGTH)
        return undefined;
    let parsed: URL;
    try {
        parsed = new URL(iconUrl);
    } catch {
        return undefined;
    }
    if (parsed.username !== "" || parsed.password !== "") return undefined;
    if (parsed.protocol === "https:") return iconUrl;
    if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) return iconUrl;
    return undefined;
}

function substitutePlaceholders(template: string, appId: number): string | undefined {
    const resolved = template.replaceAll("{appId}", encodeURIComponent(appId.toString()));
    return /\{[^{}]+\}/.test(resolved) ? undefined : resolved;
}

function surfaceDataDisclosures(template: string): AiAppSurfaceDataDisclosure[] {
    const disclosures: AiAppSurfaceDataDisclosure[] = [];
    if (template.includes("{appId}")) disclosures.push("app_id");
    if (template.includes(CHAT_LINK_TOKEN_PLACEHOLDER)) {
        disclosures.push("one_time_chat_link_token");
    }
    return disclosures;
}

export function redactedAiAppSurfaceDisplayUrl(
    url: string,
    dataDisclosures: AiAppSurfaceDataDisclosure[],
): string {
    if (!dataDisclosures.includes("one_time_chat_link_token")) return url;
    try {
        const parsed = new URL(url);
        parsed.hash = "one-time-token-redacted";
        return parsed.href;
    } catch {
        return "External app destination (one-time token redacted)";
    }
}

interface ValidatedChatLinkDescriptor {
    readonly app: AiAppRegistration;
    readonly surface: AiAppSurface;
    readonly template: string;
    readonly appId: number;
    readonly appRevision: bigint;
}

// Locate a structurally valid "chat_link" template without minting its bearer token. This is not
// gated by the shown-marker: the Settings affordance may deliberately reopen setup for a chat.
function chatLinkDescriptor(app: AiAppRegistration): ValidatedChatLinkDescriptor | undefined {
    const surface = (app.manifest.surfaces ?? []).find(
        (candidate) => candidate.kind === CHAT_LINK_KIND,
    );
    if (surface === undefined) return undefined;
    const template = surface.url;
    const appId = app.id;
    const appRevision = app.updated;
    // Exactly one canonical bearer placeholder is required, and it must be in the fragment so it
    // never enters HTTP request targets, intermediary logs, or referrers.
    const parts = template.split(CHAT_LINK_TOKEN_PLACEHOLDER);
    const tokenIndex = template.indexOf(CHAT_LINK_TOKEN_PLACEHOLDER);
    const fragmentIndex = template.indexOf("#");
    if (parts.length !== 2 || fragmentIndex < 0 || tokenIndex <= fragmentIndex) return undefined;
    // Validate the complete template synchronously without minting a real bearer. This also rejects
    // every legacy raw-chat/raw-user placeholder and any unknown future placeholder fail-closed.
    const resolved = substitutePlaceholders(
        template.replace(CHAT_LINK_TOKEN_PLACEHOLDER, "A".repeat(43)),
        appId,
    );
    if (resolved === undefined) return undefined;
    if (
        normalizeAiAppSurfaceUrl(resolved, {
            allowLocalDevelopment: import.meta.env.DEV,
        }) === undefined
    ) {
        return undefined;
    }

    const surfaceSnapshot = Object.freeze({ ...surface, url: template });
    const manifestSnapshot = Object.freeze({
        ...app.manifest,
        surfaces: (app.manifest.surfaces ?? []).map((candidate) =>
            candidate === surface ? surfaceSnapshot : { ...candidate },
        ),
    });
    const appSnapshot = Object.freeze({ ...app, manifest: manifestSnapshot });
    return Object.freeze({
        app: appSnapshot,
        surface: surfaceSnapshot,
        template,
        appId,
        appRevision,
    });
}

// Used while rendering Settings. A real token is minted only after the user's click and, for a
// per-user-key app, only after pairing succeeds.
export function hasChatLinkSurface(app: AiAppRegistration): boolean {
    return chatLinkDescriptor(app) !== undefined;
}

function base64Url(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

// The authoritative group/community/user canister mints this opaque bearer for one exact
// app/revision/chat tuple. The URL contains no raw chat or user coordinates.
export async function createChatLinkSurfaceOpening(
    client: OpenChat,
    app: AiAppRegistration,
    chatId: ChatIdentifier,
): Promise<ChatLinkSurfaceOpening | undefined> {
    const descriptor = chatLinkDescriptor(app);
    if (descriptor === undefined) return undefined;
    const minted = await client.createAiAppChatLinkToken(
        chatId,
        descriptor.appId,
        descriptor.appRevision,
    );
    if (minted === undefined) return undefined;
    const encodedToken = base64Url(minted.token);
    if (encodedToken.length !== 43) {
        await client.cancelAiAppChatLinkToken(minted.token);
        return undefined;
    }
    const resolved = substitutePlaceholders(
        descriptor.template.replace(CHAT_LINK_TOKEN_PLACEHOLDER, encodeURIComponent(encodedToken)),
        descriptor.appId,
    );
    if (resolved === undefined) {
        await client.cancelAiAppChatLinkToken(minted.token);
        return undefined;
    }
    const url = normalizeAiAppSurfaceUrl(resolved, {
        allowLocalDevelopment: import.meta.env.DEV,
    });
    if (url === undefined) {
        await client.cancelAiAppChatLinkToken(minted.token);
        return undefined;
    }
    return {
        app: descriptor.app,
        surface: descriptor.surface,
        url,
        dataDisclosures: surfaceDataDisclosures(descriptor.template),
        chatLinkToken: minted.token.slice(),
        expiresAt: minted.expiresAt,
    };
}

export interface PendingChatLinkSetup {
    readonly app: AiAppRegistration;
    readonly chatKey: string;
    readonly initiatingUserId: string | undefined;
}

export function bindPendingChatLinkSetup(
    app: AiAppRegistration,
    chatId: ChatIdentifier,
    currentUserId?: string,
): PendingChatLinkSetup | undefined {
    const chatKey = chatKeyFor(chatId, currentUserId);
    return chatKey === undefined
        ? undefined
        : Object.freeze({ app, chatKey, initiatingUserId: currentUserId });
}

export function pendingChatLinkSetupAppForChat(
    pending: PendingChatLinkSetup | undefined,
    chatId: ChatIdentifier,
    currentUserId?: string,
): AiAppRegistration | undefined {
    const chatKey = chatKeyFor(chatId, currentUserId);
    return chatKey !== undefined &&
        pending?.chatKey === chatKey &&
        pending.initiatingUserId === currentUserId
        ? pending.app
        : undefined;
}

// The app's "card" surface resolved against a chat: the in-bubble card renderer OpenChat embeds.
// Its URL receives only the public app id; app-scoped chat/message context arrives later through
// the authenticated bridge.
export function cardSurfaceOpening(
    app: AiAppRegistration,
    _chatId: ChatIdentifier,
): SurfaceOpening | undefined {
    const surface = (app.manifest.surfaces ?? []).find((s) => s.kind === CARD_KIND);
    if (surface === undefined) return undefined;
    // A card URL is fetched before its v2 postMessage handshake, so it must carry no viewer, chat,
    // message, recipient-key, or capability material. Only the public app id is substitutable; reject
    // every other `{...}` token (including future identity/capability placeholders) fail-closed.
    const url = substitutePlaceholders(surface.url, app.id);
    if (url === undefined) return undefined;
    const normalizedUrl = normalizeAiAppSurfaceUrl(url, {
        allowLocalDevelopment: import.meta.env.DEV,
    });
    if (normalizedUrl === undefined) return undefined;
    return {
        app,
        surface,
        url: normalizedUrl,
        dataDisclosures: surfaceDataDisclosures(surface.url),
    };
}

// The card surface for the app that OWNS a given action, resolved against the chat. Also returns the
// owning action's label -> field-key map so the renderer can reverse-map the message's hydrated rows
// into structured prefill data. Returns undefined (→ OpenChat renders its own rows, fully backward
// compatible) when the owner declares no "card" surface, lacks exact immutable provenance, or on
// any lookup failure.
//
// Owner resolution (security-critical — a wrongly-resolved owner lets a DIFFERENT app render the card):
// The card must carry its producing app id and exact published revision. We bind to that app only;
// another app declaring the same non-namespaced action name can never capture the card. Legacy or
// stale cards render OpenChat's own rows and never embed third-party content.
export async function resolveActionAppForCard(
    client: OpenChat,
    chatId: ChatIdentifier,
    actionId: string,
    appId?: number,
    appRevision?: bigint,
): Promise<ResolvedActionApp | undefined> {
    try {
        if (appId === undefined || appRevision === undefined) return undefined;
        let app: AiAppRegistration | undefined;
        const directChat = chatId.kind === "direct_chat";
        if (directChat) {
            app = (await resolveConnectedDirectChatAiApp(client, appId, appRevision))?.app;
        } else {
            const enabledIds = await client.enabledAiApps(chatId);
            if (!enabledIds.includes(appId)) return undefined;
            // Exact id+revision lookup: no global directory clone and no stale-revision fallback.
            const apps = await client.aiApps([{ appId, revision: appRevision }]);
            app = apps.find(
                (candidate) => candidate.id === appId && enabledIds.includes(candidate.id),
            );
        }
        if (
            app === undefined ||
            !app.published ||
            app.updated !== appRevision ||
            !app.manifest.actions.some((a) => a.name === actionId)
        ) {
            return undefined;
        }
        if (app.manifest.name.length === 0) return undefined;
        const identity: AuthoritativeAppIdentity = {
            id: app.id,
            name: app.manifest.name,
            iconUrl: validatedAppIconUrl(app.manifest.iconUrl),
        };
        const opening = cardSurfaceOpening(app, chatId);
        if (opening === undefined) return directChat ? undefined : { identity };
        // Build the label -> field-key map from the OWNING action's card template. `card.rows` here are
        // the client-side {label, valueKey} shape (aiActionDefinitionFromWire maps wire `field` ->
        // `valueKey`), so valueKey IS the structured field key the app expects.
        const action = app.manifest.actions.find((a) => a.name === actionId);
        const labelToField = Object.create(null) as Record<string, string>;
        for (const row of action?.card.rows ?? []) {
            if (
                !isSafeAiActionFieldName(row.valueKey) ||
                row.label.length === 0 ||
                row.label.length > 128 ||
                row.label !== row.label.trim() ||
                /[\p{Cc}\p{Cf}]/u.test(row.label) ||
                row.label.startsWith("__oc_") ||
                Object.hasOwn(labelToField, row.label)
            ) {
                return { identity };
            }
            labelToField[row.label] = row.valueKey;
        }
        return {
            identity,
            cardSurface: { ...opening, labelToField },
        };
    } catch {
        return undefined;
    }
}

// Backward-compatible surface-only view used by callers that do not need provenance chrome.
export async function cardSurfaceForAction(
    client: OpenChat,
    chatId: ChatIdentifier,
    actionId: string,
    appId?: number,
    appRevision?: bigint,
): Promise<CardSurfaceOpening | undefined> {
    return (await resolveActionAppForCard(client, chatId, actionId, appId, appRevision))
        ?.cardSurface;
}

// The app's "connect" surface (its pairing-code entry page), or undefined when it declares none.
// Chat-independent: only the public {appId} placeholder is substituted.
export function connectSurfaceOpening(app: AiAppRegistration): SurfaceOpening | undefined {
    return chatIndependentSurfaceOpening(app, CONNECT_KIND);
}

// The app's "home" surface (its own webpage), or undefined when it declares none.
export function homeSurfaceOpening(app: AiAppRegistration): SurfaceOpening | undefined {
    return chatIndependentSurfaceOpening(app, HOME_KIND);
}

function chatIndependentSurfaceOpening(
    app: AiAppRegistration,
    kind: string,
): SurfaceOpening | undefined {
    const surface = (app.manifest.surfaces ?? []).find((s) => s.kind === kind);
    if (surface === undefined) return undefined;
    const resolved = substitutePlaceholders(surface.url, app.id);
    if (resolved === undefined) return undefined;
    const url = normalizeAiAppSurfaceUrl(resolved, { allowLocalDevelopment: import.meta.env.DEV });
    if (url === undefined) return undefined;
    return {
        app,
        surface,
        url,
        dataDisclosures: surfaceDataDisclosures(surface.url),
    };
}

// ---------------------------------------------------------------------------------------------
// Once-per-(app, chat) memory for the post-confirm open, persisted as a JSON array of
// "<appId>:<chatKey>" strings under a single localStorage key (the same pattern as the
// auto-propose chat mutes in utils/autoPropose.ts).

const MAX_SHOWN_MARKERS = 1_000;
const MAX_SHOWN_MARKER_LENGTH = 1_024;
const CURRENT_SHOWN_MARKER = /^v3:[0-9a-f]{64}$/;

export function parseAiAppSurfaceShownMarkers(raw: string | null): Set<string> {
    try {
        if (raw === null) return new Set();
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length > MAX_SHOWN_MARKERS) return new Set();
        return new Set(
            parsed.filter(
                (value): value is string =>
                    typeof value === "string" &&
                    value.length > 0 &&
                    value.length <= MAX_SHOWN_MARKER_LENGTH &&
                    CURRENT_SHOWN_MARKER.test(value),
            ),
        );
    } catch {
        return new Set();
    }
}

const rawShownMarkers = localStorage.getItem(configKeys.aiAppSurfacesShown);
const shownMarkers = parseAiAppSurfaceShownMarkers(rawShownMarkers);
if (rawShownMarkers !== null) {
    const sanitized = JSON.stringify([...shownMarkers]);
    if (sanitized !== rawShownMarkers) {
        try {
            localStorage.setItem(configKeys.aiAppSurfacesShown, sanitized);
        } catch {
            // Sanitizing legacy raw identifiers is best-effort when storage is unavailable.
        }
    }
}

export function aiAppSurfaceMarkerForViewer(
    viewerId: string | undefined,
    appId: number,
    chatKey: string,
): string | undefined {
    if (viewerId === undefined || viewerId.length === 0) return undefined;
    const preimage = `openchat.ai-app-surface-shown.v3\0${viewerId.length}:${viewerId}\0${appId}\0${chatKey.length}:${chatKey}`;
    return `v3:${bytesToHex(sha256(utf8ToBytes(preimage)))}`;
}

function markShown(marker: string): void {
    if (shownMarkers.size >= MAX_SHOWN_MARKERS) {
        const oldest = shownMarkers.values().next().value;
        if (oldest !== undefined) shownMarkers.delete(oldest);
    }
    shownMarkers.add(marker);
    try {
        localStorage.setItem(configKeys.aiAppSurfacesShown, JSON.stringify([...shownMarkers]));
    } catch {
        // Persisting is best-effort; the in-memory marker still suppresses repeats this session.
    }
}

// ---------------------------------------------------------------------------------------------

// What (if anything) to open after the user successfully confirms an action card: the app owning
// the card's action — the directory app whose manifest declares an action named `actionId`,
// preferring apps enabled in the chat — and its "chat_link" surface, gated to once per (app, chat).
// A returned opening remains unmarked until the host-owned Load/Open choice. If the caller abandons
// it before handoff, it must cancel the returned one-time token.
export async function surfaceToOpenAfterConfirm(
    client: OpenChat,
    chatId: ChatIdentifier,
    actionId: string,
    appId: number | undefined,
    appRevision: bigint | undefined,
    currentUserId?: string,
): Promise<ChatLinkSurfaceOpening | undefined> {
    const chatKey = chatKeyFor(chatId, currentUserId);
    if (chatKey === undefined) return undefined;
    const marker = aiAppSurfaceMarkerForViewer(currentUserId, appId ?? -1, chatKey);
    if (marker === undefined) return undefined;

    if (appId === undefined || appRevision === undefined) return undefined;
    let app: AiAppRegistration | undefined;
    if (chatId.kind === "direct_chat") {
        app = (await resolveConnectedDirectChatAiApp(client, appId, appRevision))?.app;
        if (
            app === undefined ||
            !app.manifest.actions.some((action) => action.name === actionId) ||
            cardSurfaceOpening(app, chatId) === undefined
        ) {
            return undefined;
        }
    } else {
        const enabledIds = await client.enabledAiApps(chatId);
        if (!enabledIds.includes(appId)) return undefined;
        const apps = await client.aiApps([{ appId, revision: appRevision }]);
        app = appForPostConfirm(apps, enabledIds, actionId, appId, appRevision);
    }
    if (app === undefined) return undefined;

    if (shownMarkers.has(marker)) return undefined;
    return createChatLinkSurfaceOpening(client, app, chatId);
}

// Call only from the host-owned Load/Open choice. Merely resolving or displaying a prompt must not
// suppress future prompts, and each signed-in viewer has an independent marker.
export function markSurfaceShownAfterConsent(
    opening: SurfaceOpening,
    chatId: ChatIdentifier,
    currentUserId: string,
): boolean {
    const chatKey = chatKeyFor(chatId, currentUserId);
    if (chatKey === undefined) return false;
    const marker = aiAppSurfaceMarkerForViewer(currentUserId, opening.app.id, chatKey);
    if (marker === undefined) return false;
    markShown(marker);
    return true;
}

// Trusted post-confirm navigation never resolves globally by action name. The exact producer carried
// by the card must still be published, enabled, and declare that action.
export function appForPostConfirm(
    apps: AiAppRegistration[],
    enabledIds: number[],
    actionId: string,
    appId: number | undefined,
    appRevision: bigint | undefined,
): AiAppRegistration | undefined {
    if (appId === undefined || appRevision === undefined || !enabledIds.includes(appId))
        return undefined;
    return apps.find(
        (app) =>
            app.id === appId &&
            app.published &&
            app.updated === appRevision &&
            app.manifest.actions.some((action) => action.name === actionId),
    );
}

// Open a surface URL outside the app, following the app-wide external-URL convention (native
// clients hand off to the system browser; the web build opens a new tab). Best-effort — an
// unsupported scheme just does nothing.
export function openSurfaceExternally(client: OpenChat, url: string): boolean {
    const normalizedUrl = normalizeAiAppSurfaceUrl(url, {
        allowLocalDevelopment: import.meta.env.DEV,
    });
    if (normalizedUrl === undefined) return false;
    void openExternalUrl(client, normalizedUrl).catch(() => undefined);
    return true;
}
