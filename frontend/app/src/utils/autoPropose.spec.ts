import { describe, expect, it, vi } from "vitest";
const moduleMocks = vi.hoisted(() => {
    Object.defineProperty(globalThis, "matchMedia", {
        configurable: true,
        value: vi.fn(() => ({ matches: false })),
    });
    return {
        resolveCandidates: vi.fn(),
        runPrivateMatchCandidates: vi.fn(),
    };
});
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AiActionDefinition, ChatIdentifier } from "@shared";
import { currentUserStore, type EventWrapper, type Message, type OpenChat } from "@client";
import { get } from "svelte/store";
import { autoProposeSuggestions as autoProposeEnabled } from "../stores/settings";
import {
    autoProposeSuggestions,
    autoProposeSuggestionKey,
    autoProposeSuggestionStillCurrent,
    autoProposeThreadStreamMessages,
    currentAutoProposeSessionEpoch,
    evaluateForAutoPropose,
    registerAutoProposeEventBoundary,
    revokePrivateAutoProposeRuntime,
    retryAutoProposeVocabularyLookup,
} from "./autoPropose";

vi.mock("./privateMatchSurface", () => ({
    abortPrivateMatchOperations: vi.fn(),
    runPrivateMatchCandidates: moduleMocks.runPrivateMatchCandidates,
}));
vi.mock("./aiActionRunner", () => ({
    resolveCandidates: moduleMocks.resolveCandidates,
}));
import {
    buildBoundedAutoProposeVocabulary,
    MAX_AUTO_PROPOSE_KEYWORDS,
} from "./autoProposeVocabulary";
import {
    AutoProposeEventWatermarks,
    AutoProposeEvaluationTracker,
    autoProposeIdentityKey,
} from "./autoProposeEvaluationTracker";

function action(name: string, keywordCount: number): AiActionDefinition {
    return {
        name,
        description: "bounded vocabulary fixture",
        promptTemplate: "return structured data",
        responseSchema: { type: "object" },
        endpoint: "https://app.example/actions",
        card: {
            title: name,
            rows: [{ label: "Value", valueKey: "value" }],
            confirmLabel: "Confirm",
            cancelLabel: "Cancel",
        },
        rules: [
            {
                kind: "keyword_map",
                field: "value",
                mode: "override",
                map: [
                    {
                        value: "matched",
                        keywords: Array.from(
                            { length: keywordCount },
                            (_, index) => `keyword-${index}`,
                        ),
                    },
                ],
            },
        ],
    };
}

function keywordTotal(actions: readonly AiActionDefinition[]): number {
    return buildBoundedAutoProposeVocabulary(actions).keywordEntries.reduce(
        (total, entry) => total + entry.keywords.length,
        0,
    );
}

describe("bounded auto-propose vocabulary", () => {
    it("accepts one below and exactly at the aggregate keyword limit", () => {
        expect(keywordTotal([action("below", MAX_AUTO_PROPOSE_KEYWORDS - 1)])).toBe(
            MAX_AUTO_PROPOSE_KEYWORDS - 1,
        );
        expect(keywordTotal([action("at", MAX_AUTO_PROPOSE_KEYWORDS)])).toBe(
            MAX_AUTO_PROPOSE_KEYWORDS,
        );
    });

    it("fails the over-budget action closed instead of retaining a partial vocabulary", () => {
        expect(keywordTotal([action("above", MAX_AUTO_PROPOSE_KEYWORDS + 1)])).toBe(0);
    });

    it("caps aggregate actions at 32 for legacy or malformed registries", () => {
        const actions = Array.from({ length: 33 }, (_, index) => action(`action-${index}`, 1));
        expect(buildBoundedAutoProposeVocabulary(actions.slice(0, 31)).keywordEntries).toHaveLength(
            31,
        );
        expect(buildBoundedAutoProposeVocabulary(actions.slice(0, 32)).keywordEntries).toHaveLength(
            32,
        );
        expect(buildBoundedAutoProposeVocabulary(actions).keywordEntries).toHaveLength(32);
    });
});

describe("auto-propose evaluation identity", () => {
    it("waits for canonical send confirmation before one private match and chip", async () => {
        const originalUser = currentUserStore.value;
        const originalEnabled = autoProposeEnabled.value;
        const chat: ChatIdentifier = { kind: "direct_chat", userId: "canonical-other" };
        const privateAction = action("IOU", 0);
        const candidate = {
            app: { id: 91, updated: 4n },
            action: privateAction,
        } as never;
        const event = {
            index: 101,
            timestamp: 1n,
            event: {
                kind: "message",
                sender: "viewer-canonical",
                messageId: 7001n,
                messageIndex: 11,
                content: { kind: "text_content", text: "school" },
            },
        } as unknown as EventWrapper<Message>;
        try {
            currentUserStore.set({ ...originalUser, userId: "viewer-canonical" });
            autoProposeEnabled.set(true);
            moduleMocks.resolveCandidates.mockResolvedValue({
                candidates: [candidate],
                linkRequired: [],
            });
            moduleMocks.runPrivateMatchCandidates.mockResolvedValue({
                kind: "matched",
                candidate,
            });
            const registration = registerAutoProposeEventBoundary(chat, undefined, 100);
            evaluateForAutoPropose({} as OpenChat, chat, undefined, [event], "sent", registration);
            expect(moduleMocks.resolveCandidates).not.toHaveBeenCalled();
            expect(moduleMocks.runPrivateMatchCandidates).not.toHaveBeenCalled();

            evaluateForAutoPropose(
                {} as OpenChat,
                chat,
                undefined,
                [event],
                "sent_confirmed",
                registration,
            );
            await vi.waitFor(() =>
                expect(moduleMocks.runPrivateMatchCandidates).toHaveBeenCalledOnce(),
            );
            expect(
                get(autoProposeSuggestions).get(
                    autoProposeSuggestionKey("viewer-canonical", chat, undefined, 7001n),
                ),
            ).toMatchObject({ appId: 91, appRevision: 4n, actionId: "IOU" });
            registration.release();
        } finally {
            revokePrivateAutoProposeRuntime();
            moduleMocks.resolveCandidates.mockReset();
            moduleMocks.runPrivateMatchCandidates.mockReset();
            autoProposeEnabled.set(originalEnabled);
            currentUserStore.set(originalUser);
        }
    });

    it("rejects a late confirmation from an earlier same-chat activation token", async () => {
        const originalUser = currentUserStore.value;
        const originalEnabled = autoProposeEnabled.value;
        const chat: ChatIdentifier = { kind: "direct_chat", userId: "activation-aba" };
        const candidate = {
            app: { id: 92, updated: 1n },
            action: action("IOU ABA", 0),
        } as never;
        const event = {
            index: 201,
            timestamp: 1n,
            event: {
                kind: "message",
                sender: "viewer-aba",
                messageId: 7002n,
                messageIndex: 12,
                content: { kind: "text_content", text: "school" },
            },
        } as unknown as EventWrapper<Message>;
        try {
            currentUserStore.set({ ...originalUser, userId: "viewer-aba" });
            autoProposeEnabled.set(true);
            moduleMocks.resolveCandidates.mockResolvedValue({
                candidates: [candidate],
                linkRequired: [],
            });
            moduleMocks.runPrivateMatchCandidates.mockResolvedValue({
                kind: "matched",
                candidate,
            });
            const first = registerAutoProposeEventBoundary(chat, undefined, 200);
            evaluateForAutoPropose({} as OpenChat, chat, undefined, [event], "sent", first);
            first.release();
            const reopened = registerAutoProposeEventBoundary(chat, undefined, 201);
            evaluateForAutoPropose(
                {} as OpenChat,
                chat,
                undefined,
                [event],
                "sent_confirmed",
                reopened,
            );
            await Promise.resolve();
            expect(moduleMocks.resolveCandidates).not.toHaveBeenCalled();
            expect(moduleMocks.runPrivateMatchCandidates).not.toHaveBeenCalled();
            expect(
                get(autoProposeSuggestions).has(
                    autoProposeSuggestionKey("viewer-aba", chat, undefined, 7002n),
                ),
            ).toBe(false);
            reopened.release();
        } finally {
            revokePrivateAutoProposeRuntime();
            moduleMocks.resolveCandidates.mockReset();
            moduleMocks.runPrivateMatchCandidates.mockReset();
            autoProposeEnabled.set(originalEnabled);
            currentUserStore.set(originalUser);
        }
    });

    it("keys rendered suggestions by exact chat, thread and message identity", () => {
        expect(autoProposeIdentityKey("group-a", undefined, 7n)).not.toBe(
            autoProposeIdentityKey("group-b", undefined, 7n),
        );
        expect(autoProposeIdentityKey("group-a", undefined, 7n)).not.toBe(
            autoProposeIdentityKey("group-a", 42, 7n),
        );
    });

    it("scopes the same direct-chat/message identity to the captured viewer", () => {
        const chat: ChatIdentifier = { kind: "direct_chat", userId: "same-other-user" };
        expect(autoProposeSuggestionKey("viewer-a", chat, undefined, 7n)).not.toBe(
            autoProposeSuggestionKey("viewer-b", chat, undefined, 7n),
        );
    });

    it("invalidates a captured suggestion across an A -> B -> A account switch", () => {
        const original = currentUserStore.value;
        try {
            currentUserStore.set({ ...original, userId: "viewer-a" });
            const suggestion = {
                viewerId: "viewer-a",
                sessionEpoch: currentAutoProposeSessionEpoch(),
            };
            expect(autoProposeSuggestionStillCurrent(suggestion)).toBe(true);
            currentUserStore.set({ ...original, userId: "viewer-b" });
            currentUserStore.set({ ...original, userId: "viewer-a" });
            expect(autoProposeSuggestionStillCurrent(suggestion)).toBe(false);
        } finally {
            currentUserStore.set(original);
        }
    });

    it("deduplicates one in-flight exact chat/thread/message only", () => {
        const tracker = new AutoProposeEvaluationTracker();

        expect(tracker.claim("group-a", undefined, 7n)).toBe(true);
        expect(tracker.claim("group-a", undefined, 7n)).toBe(false);
        expect(tracker.claim("group-b", undefined, 7n)).toBe(true);
        expect(tracker.claim("group-a", 42, 7n)).toBe(true);
    });

    it("releases transient failures for retry but keeps completed decisions terminal", () => {
        const tracker = new AutoProposeEvaluationTracker();

        expect(tracker.claim("group-a", undefined, 8n)).toBe(true);
        tracker.finish("group-a", undefined, 8n, false);
        expect(tracker.claim("group-a", undefined, 8n)).toBe(true);

        tracker.finish("group-a", undefined, 8n, true);
        expect(tracker.claim("group-a", undefined, 8n)).toBe(false);
    });

    it("clears both terminal and in-flight identities on module disposal", () => {
        const tracker = new AutoProposeEvaluationTracker();
        expect(tracker.claim("group-a", undefined, 1n)).toBe(true);
        tracker.finish("group-a", undefined, 1n, true);
        expect(tracker.claim("group-a", undefined, 2n)).toBe(true);
        tracker.clear();
        expect(tracker.claim("group-a", undefined, 1n)).toBe(true);
        expect(tracker.claim("group-a", undefined, 2n)).toBe(true);
    });
});

describe("auto-propose event-stream boundary", () => {
    const events = (...indices: number[]) => indices.map((index) => ({ index }));

    it("emits only indices after the active subscription boundary", () => {
        const watermarks = new AutoProposeEventWatermarks();
        const registration = watermarks.registerBoundary("group-a", undefined, 100);
        expect(
            watermarks.observeLoadedNew(
                "group-a",
                undefined,
                events(1, 100, 101),
                registration,
            ),
        ).toEqual([{ index: 101 }]);
        expect(
            watermarks.observeLoadedNew("group-a", undefined, events(99, 101), registration),
        ).toEqual([]);
        expect(
            watermarks.observeLoadedNew("group-a", undefined, events(102), registration),
        ).toEqual([{ index: 102 }]);
    });

    it("fails closed without an exact active registration, including after release/HMR", () => {
        const watermarks = new AutoProposeEventWatermarks();
        expect(watermarks.observeLoadedNew("group-a", undefined, events(50, 51), undefined)).toEqual(
            [],
        );
        const first = watermarks.registerBoundary("group-a", undefined, 51);
        watermarks.unregisterBoundary("group-a", undefined, first);
        expect(watermarks.observeLoadedNew("group-a", undefined, events(52), first)).toEqual([]);
        watermarks.clear();
        expect(watermarks.observeLoadedNew("group-a", undefined, events(53), first)).toEqual([]);
    });

    it("records explicit outgoing events while keeping chat and thread streams separate", () => {
        const watermarks = new AutoProposeEventWatermarks();
        const main = watermarks.registerBoundary("group-a", undefined, 10);
        const thread = watermarks.registerBoundary("group-a", 7, 3);
        watermarks.observeSent("group-a", undefined, 11, main);
        expect(watermarks.observeLoadedNew("group-a", undefined, events(1, 11), main)).toEqual(
            [],
        );
        expect(watermarks.observeLoadedNew("group-a", 7, events(3, 4), thread)).toEqual([
            { index: 4 },
        ]);
        expect(watermarks.observeLoadedNew("group-b", undefined, events(500), main)).toEqual([]);
    });

    it("reopens at a fresh boundary and ignores stale overlapping cleanup", () => {
        const watermarks = new AutoProposeEventWatermarks();
        const mount100 = watermarks.registerBoundary("group-a", undefined, 100);
        const overlapping101 = watermarks.registerBoundary("group-a", undefined, 101);
        watermarks.unregisterBoundary("group-a", undefined, mount100);
        expect(
            watermarks.observeLoadedNew("group-a", undefined, events(101), overlapping101),
        ).toEqual([]);
        expect(
            watermarks.observeLoadedNew("group-a", undefined, events(102), overlapping101),
        ).toEqual([{ index: 102 }]);
        watermarks.unregisterBoundary("group-a", undefined, overlapping101);
        const reopened103 = watermarks.registerBoundary("group-a", undefined, 103);
        expect(watermarks.observeLoadedNew("group-a", undefined, events(103), reopened103)).toEqual(
            [],
        );
    });

    it("isolates A -> B -> A activations and rejects queued callbacks with old tokens", () => {
        const watermarks = new AutoProposeEventWatermarks();
        const a100 = watermarks.registerBoundary("viewer:a", undefined, 100);
        watermarks.unregisterBoundary("viewer:a", undefined, a100);
        const b50 = watermarks.registerBoundary("viewer:b", undefined, 50);
        expect(watermarks.observeLoadedNew("viewer:b", undefined, events(50, 51), b50)).toEqual([
            { index: 51 },
        ]);
        watermarks.unregisterBoundary("viewer:b", undefined, b50);
        const a101 = watermarks.registerBoundary("viewer:a", undefined, 101);
        expect(watermarks.observeLoadedNew("viewer:a", undefined, events(999), a100)).toEqual([]);
        expect(watermarks.observeLoadedNew("viewer:a", undefined, events(101), a101)).toEqual([]);
        expect(watermarks.observeLoadedNew("viewer:a", undefined, events(102), a101)).toEqual([
            { index: 102 },
        ]);
    });

    it("excludes only the exact root wrapper when root/reply indices and ids collide", () => {
        const wrapper = (index: number, messageIndex: number, messageId: bigint) =>
            ({
                index,
                timestamp: 0n,
                event: {
                    kind: "message",
                    messageIndex,
                    messageId,
                    content: { kind: "text_content", text: "school" },
                },
            }) as unknown as EventWrapper<Message>;
        const root = wrapper(500, 2, 77n);
        const existingReply = wrapper(5, 2, 77n);
        const newReply = wrapper(6, 3, 78n);
        const replies = autoProposeThreadStreamMessages(
            [root, existingReply, newReply],
            root,
        );
        expect(replies).toEqual([existingReply, newReply]);
        const watermarks = new AutoProposeEventWatermarks();
        const registration = watermarks.registerBoundary("group-a", 2, 5);
        expect(watermarks.observeLoadedNew("group-a", 2, replies, registration)).toEqual([
            newReply,
        ]);
    });

    it("retries vocabulary lookup once inside the evaluation and never beyond two calls", async () => {
        let calls = 0;
        await expect(
            retryAutoProposeVocabularyLookup(async () => {
                calls += 1;
                if (calls === 1) throw new Error("transient");
                return "ready";
            }),
        ).resolves.toBe("ready");
        expect(calls).toBe(2);

        calls = 0;
        await expect(
            retryAutoProposeVocabularyLookup(async () => {
                calls += 1;
                throw new Error("still down");
            }),
        ).rejects.toThrow("still down");
        expect(calls).toBe(2);
    });

    it("wires the boundary before subscriptions, ignores clocks, and terminalizes failures", () => {
        const evaluator = readFileSync(resolve(__dirname, "autoPropose.ts"), "utf8");
        const eventList = readFileSync(
            resolve(__dirname, "../components_shared/ChatEventList.svelte"),
            "utf8",
        );
        expect(evaluator).not.toContain("sessionStart");
        expect(evaluator).not.toContain("Number(ev.timestamp)");
        expect(evaluator).toContain("eventWatermarks.clear()");
        expect(evaluator).not.toContain("completed = false");
        expect(eventList.indexOf("registerAutoProposeEventBoundary(")).toBeLessThan(
            eventList.indexOf('subscribe("sentMessage"'),
        );
        expect(eventList).toContain('"sent"');
        expect(eventList).toContain('"loaded_new"');
    });
});
