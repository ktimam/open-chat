import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AiAppRegistration, ChatIdentifier } from "@shared";
import { currentUserStore } from "@client";
import type { AiActionCandidate } from "./aiActionRunner";
import { setPrivateMatchConsent } from "./privateMatchConsent";
import {
    boundedPrivateMatchCandidates,
    MAX_ACTIVE_PRIVATE_MATCH_OPERATIONS,
    MAX_PRIVATE_MATCH_ATTEMPTS,
    MAX_PRIVATE_MATCH_CANDIDATES,
    PRIVATE_MATCH_ATTEMPT_TIMEOUT_MS,
    PRIVATE_MATCH_OPERATION_TIMEOUT_MS,
    parsePrivateMatchReady,
    parsePrivateMatchResult,
    PrivateMatchOperationRegistry,
    retryTransientPrivateMatch,
    runPrivateMatchCandidates,
    abortPrivateMatchOperations,
} from "./privateMatchSurface";

function b64url(bytes: number, fill: number): string {
    return btoa(String.fromCharCode(...new Uint8Array(bytes).fill(fill)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

const CHAT: ChatIdentifier = {
    kind: "group_chat",
    groupId: "dgegb-daaaa-aaaar-arlhq-cai",
};
const VIEWER_ID = "private-match-test-viewer";
const ORIGINAL_CURRENT_USER = currentUserStore.value;

function candidate(id: number): AiActionCandidate {
    const app = {
        id,
        updated: BigInt(id),
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
    return {
        app,
        action: { name: `action-${id}` },
        recipientKey: "key",
    } as AiActionCandidate;
}

describe("private matcher host protocol", () => {
    beforeEach(() => {
        localStorage.clear();
        currentUserStore.set({ ...ORIGINAL_CURRENT_USER, userId: VIEWER_ID });
    });
    afterEach(() => {
        abortPrivateMatchOperations();
        currentUserStore.set(ORIGINAL_CURRENT_USER);
    });

    it("accepts ready only for the exact attempt and canonical 48-byte transport key", () => {
        const binding = { frameNonce: b64url(32, 1), attemptId: b64url(16, 2) };
        const ready = {
            type: "oc:private-match:ready",
            version: 1,
            ...binding,
            recipientKeyScheme: "iou.vetkd.bls12-381.v1",
            recipientPublicKey: b64url(48, 3),
        };
        expect(parsePrivateMatchReady(ready, binding)?.recipientPublicKey).toHaveLength(48);
        expect(parsePrivateMatchReady({ ...ready, attemptId: b64url(16, 9) }, binding)).toBeUndefined();
        expect(parsePrivateMatchReady({ ...ready, recipientPublicKey: b64url(47, 3) }, binding)).toBeUndefined();
    });

    it("accepts a boolean-only result and rejects metadata", () => {
        const binding = { frameNonce: b64url(32, 1), attemptId: b64url(16, 2) };
        const result = {
            type: "oc:private-match:result",
            version: 1,
            ...binding,
            matched: true,
        };
        expect(parsePrivateMatchResult(result, binding)).toBe(true);
        expect(parsePrivateMatchResult({ ...result, templateName: "School" }, binding)).toBeUndefined();
        expect(parsePrivateMatchResult({ ...result, count: 1 }, binding)).toBeUndefined();
    });

    it("is default-off and caps explicitly consented candidates", () => {
        const candidates = Array.from({ length: 7 }, (_, index) => candidate(index + 1));
        expect(boundedPrivateMatchCandidates(candidates, CHAT)).toEqual([]);
        for (const value of candidates) {
            setPrivateMatchConsent(value.app, CHAT, true, VIEWER_ID);
        }
        expect(boundedPrivateMatchCandidates(candidates, CHAT)).toHaveLength(
            MAX_PRIVATE_MATCH_CANDIDATES,
        );
    });

    it("retries only transient attempts with a fresh bounded attempt", async () => {
        const outcomes = ["transient", "matched"] as const;
        let calls = 0;
        let backoffs = 0;
        expect(
            await retryTransientPrivateMatch(
                async () => outcomes[calls++] ?? "transient",
                async () => {
                    backoffs += 1;
                    return true;
                },
            ),
        ).toBe("matched");
        expect(calls).toBe(MAX_PRIVATE_MATCH_ATTEMPTS);
        expect(backoffs).toBe(1);

        calls = 0;
        expect(
            await retryTransientPrivateMatch(async () => {
                calls += 1;
                return "no_match";
            }),
        ).toBe("no_match");
        expect(calls).toBe(1);
    });

    it("uses a realistic attempt timeout and a token-TTL-bounded total operation", () => {
        expect(PRIVATE_MATCH_ATTEMPT_TIMEOUT_MS).toBe(30_000);
        expect(PRIVATE_MATCH_OPERATION_TIMEOUT_MS).toBe(45_000);
        expect(PRIVATE_MATCH_OPERATION_TIMEOUT_MS).toBeLessThan(60_000);
    });

    it("bounds active operations and aborts every admitted controller on disposal", () => {
        const registry = new PrivateMatchOperationRegistry(2);
        const first = new AbortController();
        const second = new AbortController();
        const overflow = new AbortController();
        expect(registry.admit(first)).toBe(true);
        expect(registry.admit(second)).toBe(true);
        expect(registry.admit(overflow)).toBe(false);
        expect(registry.size).toBe(2);
        registry.abortAll();
        expect(first.signal.aborted).toBe(true);
        expect(second.signal.aborted).toBe(true);
        expect(overflow.signal.aborted).toBe(false);
        expect(registry.size).toBe(0);
        expect(MAX_ACTIVE_PRIVATE_MATCH_OPERATIONS).toBe(8);
    });

    it("keeps the exact text behind child/key capability binding and tears frames down", () => {
        const source = readFileSync(resolve(__dirname, "privateMatchSurface.ts"), "utf8");
        expect(source).toContain('frame.setAttribute("sandbox", "allow-scripts")');
        expect(source).not.toContain('sandbox", "allow-scripts allow-same-origin"');
        expect(source).toContain('frame.referrerPolicy = "no-referrer"');
        expect(source).toContain(".credentialless = true");
        expect(source).toContain('event.source !== frameWindow || event.origin !== "null"');
        expect(source).toContain("frame.remove()");
        expect(source).toContain("MAX_PRIVATE_MATCH_CONCURRENCY = 2");
        expect(source).toContain("MAX_PRIVATE_MATCH_CANDIDATES = 4");
        expect(source).toContain('finish("transient")');
        expect(source).toContain("import.meta.hot?.dispose");
        expect(source).toContain("abortPrivateMatchOperations()");
        expect(source.indexOf("createAiAppPrivateMatchCapability(")).toBeLessThan(
            source.indexOf("messageText: exactMessageText"),
        );
        expect(source).not.toContain("BigInt(Date.now())");
        expect(source).not.toMatch(/console\.|localStorage|sessionStorage/);
    });

    it("gates the shared consent UI on credentialless-frame support with update guidance", () => {
        const toggle = readFileSync(
            resolve(__dirname, "../components/home/PrivateMatchConsentToggle.svelte"),
            "utf8",
        );
        expect(toggle).toContain("supportsCredentiallessIframe()");
        expect(toggle).toContain("disabled={!available || !runtimeSupported}");
        expect(toggle).toContain('"aiApps.privateTriggers.unsupported"');
        expect(toggle).not.toContain("allow-same-origin");
    });

    it("stops minting and exact-text egress when consent is revoked in flight", async () => {
        const descriptor = Object.getOwnPropertyDescriptor(
            HTMLIFrameElement.prototype,
            "credentialless",
        );
        Object.defineProperty(HTMLIFrameElement.prototype, "credentialless", {
            configurable: true,
            writable: true,
            value: false,
        });
        const value = candidate(1);
        const start = (mint: ReturnType<typeof vi.fn>, stillCurrent?: () => boolean) => {
            setPrivateMatchConsent(value.app, CHAT, true, VIEWER_ID);
            const running = runPrivateMatchCandidates(
                { createAiAppPrivateMatchCapability: mint } as never,
                CHAT,
                undefined,
                123n,
                "School expense 350 EGP",
                [value],
                VIEWER_ID,
                stillCurrent,
            );
            const frame = document.body.querySelector("iframe");
            if (!(frame instanceof HTMLIFrameElement) || frame.contentWindow === null) {
                throw new Error("private matcher frame was not mounted");
            }
            const postMessage = vi.spyOn(frame.contentWindow, "postMessage");
            frame.dispatchEvent(new Event("load"));
            const bootstrap = postMessage.mock.calls.find(
                ([message]) => (message as { type?: string }).type === "oc:private-match:bootstrap",
            )?.[0] as { frameNonce: string; attemptId: string } | undefined;
            if (bootstrap === undefined) throw new Error("private matcher was not bootstrapped");
            const sendReady = () =>
                window.dispatchEvent(
                    new MessageEvent("message", {
                        origin: "null",
                        source: frame.contentWindow,
                        data: {
                            type: "oc:private-match:ready",
                            version: 1,
                            frameNonce: bootstrap.frameNonce,
                            attemptId: bootstrap.attemptId,
                            recipientKeyScheme: "iou.vetkd.bls12-381.v1",
                            recipientPublicKey: b64url(48, 7),
                        },
                    }),
                );
            const sendResult = (matched: boolean) =>
                window.dispatchEvent(
                    new MessageEvent("message", {
                        origin: "null",
                        source: frame.contentWindow,
                        data: {
                            type: "oc:private-match:result",
                            version: 1,
                            frameNonce: bootstrap.frameNonce,
                            attemptId: bootstrap.attemptId,
                            matched,
                        },
                    }),
                );
            return { running, postMessage, sendReady, sendResult };
        };

        try {
            // Revocation during child bootstrap must stop before capability minting.
            const mintBeforeReady = vi.fn();
            const beforeReady = start(mintBeforeReady);
            setPrivateMatchConsent(value.app, CHAT, false, VIEWER_ID);
            beforeReady.sendReady();
            await expect(beforeReady.running).resolves.toEqual({ kind: "no_match" });
            expect(mintBeforeReady).not.toHaveBeenCalled();

            // Revocation while minting must stop before the request carrying exact text.
            let resolveCapability!: (value: unknown) => void;
            const capability = new Promise((resolve) => {
                resolveCapability = resolve;
            });
            const mintInFlight = vi.fn(() => capability);
            const inFlight = start(mintInFlight);
            inFlight.sendReady();
            expect(mintInFlight).toHaveBeenCalledTimes(1);
            setPrivateMatchConsent(value.app, CHAT, false, VIEWER_ID);
            resolveCapability({
                capability: b64url(32, 8),
                expiresAt: 60_000n,
                context: { appId: 1, appRevision: 1n, actionId: "action-1" },
            });
            await expect(inFlight.running).resolves.toEqual({ kind: "no_match" });
            expect(
                inFlight.postMessage.mock.calls.some(
                    ([message]) =>
                        (message as { type?: string }).type === "oc:private-match:request",
                ),
            ).toBe(false);

            // A -> B -> A must still fail: the immutable session guard cannot be revived by ABA.
            let sessionCurrent = true;
            let resolveAfterSwitch!: (value: unknown) => void;
            const afterSwitchCapability = new Promise((resolve) => {
                resolveAfterSwitch = resolve;
            });
            const switched = start(vi.fn(() => afterSwitchCapability), () => sessionCurrent);
            switched.sendReady();
            sessionCurrent = false;
            currentUserStore.set({ ...ORIGINAL_CURRENT_USER, userId: "other-viewer" });
            currentUserStore.set({ ...ORIGINAL_CURRENT_USER, userId: VIEWER_ID });
            resolveAfterSwitch({
                capability: b64url(32, 10),
                expiresAt: 1n,
                context: { appId: 1, appRevision: 1n, actionId: "action-1" },
            });
            await expect(switched.running).resolves.toEqual({ kind: "no_match" });
            expect(
                switched.postMessage.mock.calls.some(
                    ([message]) =>
                        (message as { type?: string }).type === "oc:private-match:request",
                ),
            ).toBe(false);

            // An extreme browser clock skew must not reject a canister-valid capability locally.
            const skewedMint = vi.fn().mockResolvedValue({
                capability: b64url(32, 9),
                expiresAt: 1n,
                context: { appId: 1, appRevision: 1n, actionId: "action-1" },
            });
            const skewed = start(skewedMint);
            skewed.sendReady();
            await vi.waitFor(() =>
                expect(
                    skewed.postMessage.mock.calls.some(
                        ([message]) =>
                            (message as { type?: string }).type === "oc:private-match:request",
                    ),
                ).toBe(true),
            );
            skewed.sendResult(false);
            await expect(skewed.running).resolves.toEqual({ kind: "no_match" });
        } finally {
            abortPrivateMatchOperations();
            document.body.querySelectorAll("iframe").forEach((frame) => frame.remove());
            if (descriptor === undefined) {
                Reflect.deleteProperty(HTMLIFrameElement.prototype, "credentialless");
            } else {
                Object.defineProperty(HTMLIFrameElement.prototype, "credentialless", descriptor);
            }
        }
    });

    it("puts the separate default-off toggle in every group/direct desktop/mobile settings tree", () => {
        for (const file of [
            "../components/home/groupdetails/AiAppsSummary.svelte",
            "../components_mobile/home/groupdetails/AiAppsSummary.svelte",
            "../components/home/groupdetails/AiAppsDirectSummary.svelte",
            "../components_mobile/home/groupdetails/AiAppsDirectSummary.svelte",
        ]) {
            const source = readFileSync(resolve(__dirname, file), "utf8");
            expect(source).toContain("PrivateMatchConsentToggle");
        }
        const toggle = readFileSync(
            resolve(__dirname, "../components/home/PrivateMatchConsentToggle.svelte"),
            "utf8",
        );
        expect(toggle).toContain("privateMatchConsentMarker(app, chatId, $currentUserIdStore)");
        expect(toggle).toContain("revokePrivateAutoProposeRuntime()");
        expect(toggle).toContain("if (lastAvailable && !available)");
        expect(toggle).toContain("disabled={!available || !runtimeSupported}");
        expect(toggle).toContain("unmuteAutoProposeInChat(chatId)");
        const english = readFileSync(resolve(__dirname, "../i18n/en.json"), "utf8");
        expect(english).toContain("link this exact chat to an IOU account");
        expect(english).toContain("Saved-type name is not automatic");
        expect(english).toContain("add it as a Trigger word");
        expect(english).toContain("keep auto-propose suggestions on");
        expect(english).toContain("leave this chat unmuted");
        expect(english).toContain("new text messages observed while this chat is open");
    });

    it("invalidates old async suggestion generations and aborts matchers on HMR disposal", () => {
        const source = readFileSync(resolve(__dirname, "autoPropose.ts"), "utf8");
        expect(source).toContain("import.meta.hot?.dispose");
        expect(source).toContain("evaluationGeneration += 1");
        expect(source).toContain("evaluationTracker.clear()");
        expect(source).toContain("autoProposeSuggestions.set(new Map())");
        expect(source).toContain("abortPrivateMatchOperations()");
    });
});
