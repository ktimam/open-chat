// Post-confirm app surfaces — fully generic, driven only by registered manifest data.
//
// An AI app's manifest may declare `surfaces`: URL templates OpenChat opens on the app's behalf.
// The only kind OpenChat understands today is "chat_link" — a page where the user configures/links
// a chat INSIDE the app. OpenChat opens it once per (app, chat), right after the first successfully
// confirmed action card in that chat (and any time on demand from the group-details Apps row).
// Surface kinds OpenChat does not know are ignored.

import type { AiAppRegistration, AiAppSurface, ChatIdentifier, OpenChat } from "openchat-client";
import { chatKeyFor } from "openchat-client";
import { configKeys } from "./config";
import { openExternalUrl } from "./urls";

// A surface resolved against a concrete chat: everything a layout needs to present it.
export interface SurfaceOpening {
    app: AiAppRegistration;
    surface: AiAppSurface;
    // The surface URL with its {chatKey}/{appId} placeholders already substituted.
    url: string;
}

// The surface kinds OpenChat knows how to act on.
// "chat_link": a page where the user configures/links a CHAT inside the app.
const CHAT_LINK_KIND = "chat_link";
// "connect": the app's pairing-code entry page — where the user pastes the 6-digit link code the
// consent sheet displays. Chat-independent (only {appId} is substituted); the pairing sheet offers
// it as an "open the right page" shortcut so the user isn't left hunting through the app's menus.
const CONNECT_KIND = "connect";

function substitutePlaceholders(template: string, chatKey: string, appId: number): string {
    // Values are URI-component encoded so the substituted URL stays parseable wherever the
    // placeholder sits (path segment or query value); standard URL/query decoding on the app's
    // side yields the exact original chat key.
    return template
        .replaceAll("{chatKey}", encodeURIComponent(chatKey))
        .replaceAll("{appId}", encodeURIComponent(appId.toString()));
}

// The app's "chat_link" surface resolved against a chat, or undefined when the app declares none
// or the chat has no canonical key (direct chats — no confirm path exists for them). NOT gated by
// the shown-marker: this is what the ungated "Open setup" affordance uses.
export function chatLinkSurfaceOpening(
    app: AiAppRegistration,
    chatId: ChatIdentifier,
): SurfaceOpening | undefined {
    const surface = (app.manifest.surfaces ?? []).find((s) => s.kind === CHAT_LINK_KIND);
    if (surface === undefined) return undefined;
    const chatKey = chatKeyFor(chatId);
    if (chatKey === undefined) return undefined;
    return { app, surface, url: substitutePlaceholders(surface.url, chatKey, app.id) };
}

// The app's "connect" surface (its pairing-code entry page), or undefined when it declares none.
// Chat-independent: {chatKey} has no meaning here, so only {appId} is substituted.
export function connectSurfaceOpening(app: AiAppRegistration): SurfaceOpening | undefined {
    const surface = (app.manifest.surfaces ?? []).find((s) => s.kind === CONNECT_KIND);
    if (surface === undefined) return undefined;
    return {
        app,
        surface,
        url: surface.url.replaceAll("{appId}", encodeURIComponent(app.id.toString())),
    };
}

// ---------------------------------------------------------------------------------------------
// Once-per-(app, chat) memory for the post-confirm open, persisted as a JSON array of
// "<appId>:<chatKey>" strings under a single localStorage key (the same pattern as the
// auto-propose chat mutes in utils/autoPropose.ts).

function loadShownMarkers(): Set<string> {
    try {
        const raw = localStorage.getItem(configKeys.aiAppSurfacesShown);
        if (raw === null) return new Set();
        const parsed: unknown = JSON.parse(raw);
        return new Set(
            Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [],
        );
    } catch {
        return new Set();
    }
}

const shownMarkers = loadShownMarkers();

function markerFor(appId: number, chatKey: string): string {
    return `${appId}:${chatKey}`;
}

function markShown(appId: number, chatKey: string): void {
    shownMarkers.add(markerFor(appId, chatKey));
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
// When this returns an opening the shown-marker has already been persisted, so the caller MUST
// present it (per `surface.display`: "sheet" embeds in-app, "external" opens a browser tab).
export async function surfaceToOpenAfterConfirm(
    client: OpenChat,
    chatId: ChatIdentifier,
    actionId: string,
): Promise<SurfaceOpening | undefined> {
    const chatKey = chatKeyFor(chatId);
    if (chatKey === undefined) return undefined;

    // Both facades resolve to [] on failure, so a lookup error degrades to "open nothing".
    const [apps, enabledIds] = await Promise.all([client.aiApps(), client.enabledAiApps(chatId)]);
    const owners = apps.filter((app) => app.manifest.actions.some((a) => a.name === actionId));
    if (owners.length === 0) return undefined;
    const enabled = new Set(enabledIds);
    const app = owners.find((o) => enabled.has(o.id)) ?? owners[0];

    const opening = chatLinkSurfaceOpening(app, chatId);
    if (opening === undefined) return undefined;
    if (shownMarkers.has(markerFor(app.id, chatKey))) return undefined;
    markShown(app.id, chatKey);
    return opening;
}

// Open a surface URL outside the app, following the app-wide external-URL convention (native
// clients hand off to the system browser; the web build opens a new tab). Best-effort — an
// unsupported scheme just does nothing.
export function openSurfaceExternally(client: OpenChat, url: string): void {
    void openExternalUrl(client, url).catch(() => undefined);
}
