import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AiAppRegistration, ChatIdentifier } from "@shared";
import { currentUserStore } from "@client";
import type { AiActionCandidate } from "./aiActionRunner";
import {
    boundedPrivateMatchCandidates,
    collectPrivateMatchCandidates,
    MAX_ACTIVE_PRIVATE_MATCH_OPERATIONS,
    MAX_PRIVATE_MATCH_ATTEMPTS,
    MAX_PRIVATE_MATCH_CANDIDATES,
    MAX_PRIVATE_MATCH_CONCURRENCY,
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

    it("accepts a bounded app-declared key scheme and canonical public key", () => {
        const binding = { frameNonce: b64url(32, 1), attemptId: b64url(16, 2) };
        const ready = {
            type: "oc:private-match:ready",
            version: 1,
            ...binding,
            recipientKeyScheme: "example.private_match-v2",
            recipientPublicKey: b64url(48, 3),
        };
        expect(parsePrivateMatchReady(ready, binding)).toMatchObject({
            ...binding,
            recipientKeyScheme: "example.private_match-v2",
            recipientPublicKey: expect.any(Uint8Array),
        });
        expect(parsePrivateMatchReady(ready, binding)?.recipientPublicKey).toHaveLength(48);
        expect(parsePrivateMatchReady({ ...ready, attemptId: b64url(16, 9) }, binding)).toBeUndefined();
        expect(parsePrivateMatchReady({ ...ready, recipientKeyScheme: "a" }, binding)?.recipientKeyScheme).toBe(
            "a",
        );
        const maximumScheme = `a${"b".repeat(63)}`;
        expect(
            parsePrivateMatchReady({ ...ready, recipientKeyScheme: maximumScheme }, binding)
                ?.recipientKeyScheme,
        ).toBe(maximumScheme);
        expect(
            parsePrivateMatchReady({ ...ready, recipientPublicKey: b64url(16, 3) }, binding)
                ?.recipientPublicKey,
        ).toHaveLength(16);
        expect(
            parsePrivateMatchReady({ ...ready, recipientPublicKey: b64url(512, 3) }, binding)
                ?.recipientPublicKey,
        ).toHaveLength(512);
        for (const recipientKeyScheme of [
            "",
            "UPPERCASE",
            ".leading-dot",
            "contains space",
            `a${"b".repeat(64)}`,
        ]) {
            expect(parsePrivateMatchReady({ ...ready, recipientKeyScheme }, binding)).toBeUndefined();
        }
        expect(parsePrivateMatchReady({ ...ready, recipientPublicKey: b64url(15, 3) }, binding)).toBeUndefined();
        expect(parsePrivateMatchReady({ ...ready, recipientPublicKey: b64url(513, 3) }, binding)).toBeUndefined();
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

    it("automatically considers registered private-match candidates with a strict cap", () => {
        const candidates = Array.from({ length: 7 }, (_, index) => candidate(index + 1));
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

    it("collects every private match in source order with bounded concurrency", async () => {
        const candidates = [candidate(1), candidate(2), candidate(3), candidate(4)];
        const outcomes = new Map<number, "matched" | "no_match" | "transient">([
            [1, "no_match"],
            [2, "matched"],
            [3, "transient"],
            [4, "matched"],
        ]);
        let active = 0;
        let maxActive = 0;
        const visited: number[] = [];

        const result = await collectPrivateMatchCandidates(candidates, async (value) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            visited.push(value.app.id);
            await Promise.resolve();
            active -= 1;
            return outcomes.get(value.app.id) ?? "no_match";
        });

        expect(maxActive).toBe(MAX_PRIVATE_MATCH_CONCURRENCY);
        expect(visited).toHaveLength(candidates.length);
        expect(result.matches.map((value) => value.app.id)).toEqual([2, 4]);
        expect(result.sawTransient).toBe(true);
    });

    it("isolates an unexpected app-attempt exception and still evaluates sibling apps", async () => {
        const candidates = [candidate(1), candidate(2), candidate(3)];
        const visited: number[] = [];
        const result = await collectPrivateMatchCandidates(candidates, async (value) => {
            visited.push(value.app.id);
            if (value.app.id === 1) throw new Error("synthetic app failure");
            return value.app.id === 3 ? "matched" : "no_match";
        });

        expect(visited.sort()).toEqual([1, 2, 3]);
        expect(result.matches.map((value) => value.app.id)).toEqual([3]);
        expect(result.sawTransient).toBe(true);
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
        expect(source).toContain("collectPrivateMatchCandidates(");
        expect(source).not.toContain("match = candidate;");
        expect(source).toContain("import.meta.hot?.dispose");
        expect(source).toContain("abortPrivateMatchOperations()");
        expect(source.indexOf("createAiAppPrivateMatchCapability(")).toBeLessThan(
            source.indexOf("type: MSG.authorize"),
        );
        expect(source.indexOf("parsePrivateMatchSourceReady(event.data, binding)")).toBeLessThan(
            source.indexOf("messageText: exactMessageText"),
        );
        expect(source).not.toContain("BigInt(Date.now())");
        expect(source).not.toMatch(/[a-z]+\.vetkd\.bls12-381\.v1/);
        expect(source).not.toMatch(/console\.|localStorage|sessionStorage/);
    });

    it("stops minting and exact-text egress when the viewer/runtime changes in flight", async () => {
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
            const running = runPrivateMatchCandidates(
                { createAiAppPrivateMatchCapability: mint } as never,
                CHAT,
                undefined,
                123n,
                "Botanical sample 350 seeds",
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
                            recipientKeyScheme: "example.private_match-v2",
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
            const sendSourceReady = () =>
                window.dispatchEvent(
                    new MessageEvent("message", {
                        origin: "null",
                        source: frame.contentWindow,
                        data: {
                            type: "oc:private-match:source-ready",
                            version: 1,
                            frameNonce: bootstrap.frameNonce,
                            attemptId: bootstrap.attemptId,
                        },
                    }),
                );
            return { running, postMessage, sendReady, sendSourceReady, sendResult };
        };

        try {
            // A stale runtime during child bootstrap must stop before capability minting.
            const mintBeforeReady = vi.fn();
            let beforeReadyCurrent = true;
            const beforeReady = start(mintBeforeReady, () => beforeReadyCurrent);
            beforeReadyCurrent = false;
            beforeReady.sendReady();
            await expect(beforeReady.running).resolves.toEqual({ kind: "no_match" });
            expect(mintBeforeReady).not.toHaveBeenCalled();

            // A viewer/session change while minting must stop before authorization or exact text.
            let runtimeCurrent = true;
            let resolveCapability!: (value: unknown) => void;
            const capability = new Promise((resolve) => {
                resolveCapability = resolve;
            });
            const mintInFlight = vi.fn((..._args: unknown[]) => capability);
            const inFlight = start(mintInFlight, () => runtimeCurrent);
            inFlight.sendReady();
            expect(mintInFlight).toHaveBeenCalledTimes(1);
            expect(mintInFlight.mock.calls[0]?.[6]).toBe("example.private_match-v2");
            runtimeCurrent = false;
            resolveCapability({
                capability: b64url(32, 8),
                expiresAt: 60_000n,
                context: { appId: 1, appRevision: 1n, actionId: "action-1" },
            });
            await expect(inFlight.running).resolves.toEqual({ kind: "no_match" });
            expect(
                inFlight.postMessage.mock.calls.some(
                    ([message]) =>
                        (message as { type?: string }).type === "oc:private-match:authorize" ||
                        (message as { type?: string }).type === "oc:private-match:source",
                ),
            ).toBe(false);

            // An app without the required private context returns false and never receives exact text.
            const unlinked = start(
                vi.fn().mockResolvedValue({
                    capability: b64url(32, 11),
                    expiresAt: 60_000n,
                    context: { appId: 1, appRevision: 1n, actionId: "action-1" },
                }),
            );
            unlinked.sendReady();
            await vi.waitFor(() =>
                expect(
                    unlinked.postMessage.mock.calls.some(
                        ([message]) =>
                            (message as { type?: string }).type ===
                            "oc:private-match:authorize",
                    ),
                ).toBe(true),
            );
            unlinked.sendResult(false);
            await expect(unlinked.running).resolves.toEqual({ kind: "no_match" });
            expect(
                unlinked.postMessage.mock.calls.some(
                    ([message]) =>
                        (message as { type?: string }).type === "oc:private-match:source",
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

            // An extreme browser clock skew must not reject a canister-valid capability locally,
            // but exact source text must still wait for the authorized app frame to request it.
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
                            (message as { type?: string }).type === "oc:private-match:authorize",
                    ),
                ).toBe(true),
            );
            const authorize = skewed.postMessage.mock.calls.find(
                ([message]) =>
                    (message as { type?: string }).type === "oc:private-match:authorize",
            )?.[0] as Record<string, unknown> | undefined;
            expect(authorize).toBeDefined();
            expect(authorize).not.toHaveProperty("messageText");
            expect(
                skewed.postMessage.mock.calls.some(
                    ([message]) =>
                        (message as { type?: string }).type === "oc:private-match:source",
                ),
            ).toBe(false);
            skewed.sendSourceReady();
            await vi.waitFor(() =>
                expect(
                    skewed.postMessage.mock.calls.some(
                        ([message]) =>
                            (message as { type?: string }).type === "oc:private-match:source" &&
                            (message as { messageText?: string }).messageText ===
                                "Botanical sample 350 seeds",
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

    it("removes the redundant opt-in toggle from every group/direct desktop/mobile settings tree", () => {
        for (const file of [
            "../components/home/groupdetails/AiAppsSummary.svelte",
            "../components_mobile/home/groupdetails/AiAppsSummary.svelte",
            "../components/home/groupdetails/AiAppsDirectSummary.svelte",
            "../components_mobile/home/groupdetails/AiAppsDirectSummary.svelte",
        ]) {
            const source = readFileSync(resolve(__dirname, file), "utf8");
            expect(source).not.toContain("PrivateMatchConsentToggle");
        }
        const english = readFileSync(resolve(__dirname, "../i18n/en.json"), "utf8");
        expect(english).toContain("AI action suggestions are muted for this chat.");
        expect(english).toContain("Unmute suggestions");
        expect(english).not.toContain("Private Saved-type triggers");
        expect(english).not.toContain("Saved-type name is not automatic");
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
