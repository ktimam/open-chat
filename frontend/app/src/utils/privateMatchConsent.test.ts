import { beforeEach, describe, expect, it } from "vitest";
import { ANON_USER_ID, type AiAppRegistration, type ChatIdentifier } from "@shared";
import { configKeys } from "./config";
import {
    parsePrivateMatchConsentMarkers,
    privateMatchConsentEnabled,
    privateMatchConsentMarker,
    setPrivateMatchConsent,
} from "./privateMatchConsent";

const CHAT: ChatIdentifier = {
    kind: "group_chat",
    groupId: "dgegb-daaaa-aaaar-arlhq-cai",
};
const VIEWER_A = "viewer-principal-a";
const VIEWER_B = "viewer-principal-b";

function app(revision = 8n): AiAppRegistration {
    return {
        id: 7,
        updated: revision,
        manifest: {
            perUserKeys: true,
            surfaces: [
                {
                    kind: "private_match",
                    url: "https://app.example/private-match",
                    display: "sheet",
                },
            ],
        },
    } as AiAppRegistration;
}

describe("per-chat private-match consent", () => {
    beforeEach(() => localStorage.clear());

    it("is default-off and stores only a digest after explicit opt-in", () => {
        const target = app();
        expect(privateMatchConsentEnabled(target, CHAT, VIEWER_A)).toBe(false);
        expect(setPrivateMatchConsent(target, CHAT, true, VIEWER_A)).toBe(true);
        expect(privateMatchConsentEnabled(target, CHAT, VIEWER_A)).toBe(true);
        const raw = localStorage.getItem(configKeys.aiAppPrivateMatchConsents)!;
        expect(raw).toContain(privateMatchConsentMarker(target, CHAT, VIEWER_A));
        expect(raw).not.toContain(CHAT.groupId);
        expect(raw).not.toContain(VIEWER_A);
        expect(raw).not.toContain("app.example");
    });

    it("binds consent to the exact viewer and fails closed without an authenticated viewer", () => {
        const target = app();
        expect(setPrivateMatchConsent(target, CHAT, true, VIEWER_A)).toBe(true);
        expect(privateMatchConsentEnabled(target, CHAT, VIEWER_A)).toBe(true);
        expect(privateMatchConsentEnabled(target, CHAT, VIEWER_B)).toBe(false);
        expect(setPrivateMatchConsent(target, CHAT, true, undefined)).toBe(false);
        expect(setPrivateMatchConsent(target, CHAT, true, ANON_USER_ID)).toBe(false);
        expect(privateMatchConsentEnabled(target, CHAT, undefined)).toBe(false);
        expect(privateMatchConsentEnabled(target, CHAT, ANON_USER_ID)).toBe(false);
    });

    it("resets on app revision and can be revoked", () => {
        const original = app(8n);
        expect(setPrivateMatchConsent(original, CHAT, true, VIEWER_A)).toBe(true);
        expect(privateMatchConsentEnabled(app(9n), CHAT, VIEWER_A)).toBe(false);
        expect(setPrivateMatchConsent(original, CHAT, false, VIEWER_A)).toBe(true);
        expect(privateMatchConsentEnabled(original, CHAT, VIEWER_A)).toBe(false);
    });

    it("fails malformed or oversized stores closed", () => {
        expect(parsePrivateMatchConsentMarkers("not-json")).toEqual([]);
        expect(parsePrivateMatchConsentMarkers(JSON.stringify(["v1:not-a-digest"]))).toEqual([]);
        expect(parsePrivateMatchConsentMarkers(JSON.stringify([`v1:${"a".repeat(64)}`]))).toEqual(
            [],
        );
        expect(parsePrivateMatchConsentMarkers(JSON.stringify(new Array(1_025).fill("x")))).toEqual([]);
    });
});
