// AI app surfaces — fully generic, driven only by registered manifest data.
//
// An AI app's manifest may declare `surfaces`: URL templates OpenChat opens on the app's behalf.
// The only kind OpenChat understands today is "chat_link" — a page where the user configures/links
// a chat INSIDE the app. OpenChat opens it only from the explicit Apps setup action.
// Surface kinds OpenChat does not know are ignored.

import type { OpenChat } from "@client";
import type { AiAppRegistration, AiAppSurface, ChatIdentifier } from "@shared";
import { chatKeyFor, isSafeAiActionFieldName } from "@shared";
import { normalizeAiAppSurfaceUrl } from "./cardBridge";
import { directChatAiAppKeys, resolveConnectedDirectChatAiApp } from "./aiAppDirectChat";
import { openExternalUrl } from "./urls";

export type AiAppSurfaceDataDisclosure =
    | "app_id"
    | "one_time_chat_link_token"
    | "chat_display_name"
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
    // A non-empty app-specific delivery key records this viewer's explicit, durable pairing with a
    // per-user-key app. Card rendering may use that pairing as persistent consent to restore the
    // separately encrypted app context; it is never itself sent to the card frame.
    hasPersistentUserPairing: boolean;
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
// "private_match": an invisible, credentialless, opaque-origin iframe used only after the viewer
// explicitly enables private triggers for this exact app+revision+chat. It receives no secrets in
// its URL and returns one boolean over postMessage.
const PRIVATE_MATCH_KIND = "private_match";
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

// Consent chrome deliberately shows only the origin. Paths, query parameters, and fragments can
// contain app-specific state or bearer material and remain behind the explicit privacy disclosure.
export function aiAppSurfaceDestinationOrigin(url: string): string {
    try {
        const origin = new URL(url).origin;
        return origin === "null" ? "" : origin;
    } catch {
        return "";
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
    chatName: string,
): Promise<ChatLinkSurfaceOpening | undefined> {
    const descriptor = chatLinkDescriptor(app);
    if (descriptor === undefined) return undefined;
    const minted = await client.createAiAppChatLinkToken(
        chatId,
        chatName,
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
        dataDisclosures: [...surfaceDataDisclosures(descriptor.template), "chat_display_name"],
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

export function privateMatchSurfaceOpening(
    app: AiAppRegistration,
    _chatId: ChatIdentifier,
): SurfaceOpening | undefined {
    if (app.manifest.perUserKeys !== true) return undefined;
    const surface = (app.manifest.surfaces ?? []).find(
        (candidate) => candidate.kind === PRIVATE_MATCH_KIND,
    );
    // The matcher is never a visible browser handoff. Requiring sheet is also mirrored by the
    // minting canister, so an old/malformed registry cannot silently expand this data flow.
    if (surface === undefined || surface.display !== "sheet") return undefined;
    const resolved = substitutePlaceholders(surface.url, app.id);
    if (resolved === undefined) return undefined;
    const url = normalizeAiAppSurfaceUrl(resolved, {
        allowLocalDevelopment: import.meta.env.DEV,
    });
    if (url === undefined) return undefined;
    return { app, surface, url, dataDisclosures: surfaceDataDisclosures(surface.url) };
}

export function hasPrivateMatchSurface(app: AiAppRegistration): boolean {
    return (
        privateMatchSurfaceOpening(app, { kind: "direct_chat", userId: "aaaaa-aa" }) !== undefined
    );
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
        let hasPersistentUserPairing = false;
        const directChat = chatId.kind === "direct_chat";
        if (directChat) {
            const connected = await resolveConnectedDirectChatAiApp(client, appId, appRevision);
            app = connected?.app;
            hasPersistentUserPairing = connected !== undefined;
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
        if (!directChat && app.manifest.perUserKeys === true) {
            // Pairing restoration is optional presentation state. A transient UserIndex key lookup
            // failure must not erase authoritative app identity/card rows; it simply leaves private
            // context behind the manual explicit-consent path.
            try {
                hasPersistentUserPairing =
                    (directChatAiAppKeys(await client.myAiAppKeys()).get(appId)?.length ?? 0) > 0;
            } catch {
                hasPersistentUserPairing = false;
            }
        }
        const identity: AuthoritativeAppIdentity = {
            id: app.id,
            name: app.manifest.name,
            iconUrl: validatedAppIconUrl(app.manifest.iconUrl),
        };
        const opening = cardSurfaceOpening(app, chatId);
        if (opening === undefined)
            return directChat ? undefined : { identity, hasPersistentUserPairing };
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
                return { identity, hasPersistentUserPairing };
            }
            labelToField[row.label] = row.valueKey;
        }
        return {
            identity,
            hasPersistentUserPairing,
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
