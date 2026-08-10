// Separate, default-off consent for sending NEW messages to a registered app's private matcher.
// The persisted marker is a one-way digest of viewer + app id + immutable revision + chat key, so
// account/app changes reset consent and localStorage contains no raw viewer or chat coordinates.

import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { ANON_USER_ID, type AiAppRegistration, type ChatIdentifier } from "@shared";
import { chatIdentifierToString } from "@client";
import { configKeys } from "./config";
import { hasPrivateMatchSurface } from "./aiAppSurfaces";

const MAX_CONSENTS = 1_024;
const MARKER = /^v2:[0-9a-f]{64}$/;

export function parsePrivateMatchConsentMarkers(raw: string | null): string[] {
    try {
        if (raw === null) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length > MAX_CONSENTS) return [];
        return [...new Set(parsed.filter((value): value is string => MARKER.test(value)))];
    } catch {
        return [];
    }
}

export function privateMatchConsentMarker(
    app: Pick<AiAppRegistration, "id" | "updated">,
    chatId: ChatIdentifier,
    viewerId: string | undefined,
): string | undefined {
    if (
        viewerId === undefined ||
        viewerId.length === 0 ||
        viewerId.length > 256 ||
        viewerId === ANON_USER_ID
    ) {
        return undefined;
    }
    const material = `openchat.private-match-consent.v2\0${viewerId}\0${app.id}\0${app.updated.toString()}\0${chatIdentifierToString(chatId)}`;
    return `v2:${bytesToHex(sha256(utf8ToBytes(material)))}`;
}

function storedMarkers(): string[] {
    try {
        return parsePrivateMatchConsentMarkers(
            localStorage.getItem(configKeys.aiAppPrivateMatchConsents),
        );
    } catch {
        return [];
    }
}

export function privateMatchConsentEnabled(
    app: AiAppRegistration,
    chatId: ChatIdentifier,
    viewerId: string | undefined,
): boolean {
    const marker = privateMatchConsentMarker(app, chatId, viewerId);
    return marker !== undefined && hasPrivateMatchSurface(app) && storedMarkers().includes(marker);
}

/** Returns the durable state. A failed localStorage write always fails closed to off. */
export function setPrivateMatchConsent(
    app: AiAppRegistration,
    chatId: ChatIdentifier,
    enabled: boolean,
    viewerId: string | undefined,
): boolean {
    if (enabled && !hasPrivateMatchSurface(app)) return false;
    const marker = privateMatchConsentMarker(app, chatId, viewerId);
    if (marker === undefined) return false;
    const next = storedMarkers().filter((candidate) => candidate !== marker);
    if (enabled) next.push(marker);
    const bounded = next.slice(-MAX_CONSENTS);
    try {
        localStorage.setItem(configKeys.aiAppPrivateMatchConsents, JSON.stringify(bounded));
    } catch {
        return false;
    }
    return enabled ? bounded.includes(marker) : !bounded.includes(marker);
}
