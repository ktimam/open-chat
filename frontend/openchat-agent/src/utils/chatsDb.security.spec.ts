import { describe, expect, it, vi } from "vitest";
import type { Principal } from "@icp-sdk/core/principal";
import type { ActionCardContent, EventWrapper, Message } from "@shared";
import { ChatsDb } from "./chatsDb";

const CHAT = { kind: "group_chat", groupId: "aaaaa-aa" } as const;

function event(content: Message["content"], messageId: bigint): EventWrapper<Message> {
    return {
        index: Number(messageId),
        timestamp: 1n,
        expiresAt: undefined,
        event: {
            kind: "message",
            messageId,
            messageIndex: Number(messageId),
            sender: "aaaaa-aa",
            content,
            repliesTo: undefined,
        },
    } as unknown as EventWrapper<Message>;
}

function provenanceCard(): ActionCardContent {
    return {
        kind: "action_card_content",
        title: "Card",
        rows: [],
        confirmLabel: "Confirm",
        cancelLabel: "Cancel",
        actionId: "example.action",
        state: "pending",
        appProvenance: Uint8Array.from({ length: 32 }, (_, i) => i),
    };
}

describe("ChatsDb provenance persistence", () => {
    it("writes no raw proof and a restarted cache has no retryable action card", async () => {
        const stores = {
            failed_chat_messages: new Map<string, unknown>(),
            failed_thread_messages: new Map<string, unknown>(),
        };
        const fakeDb = {
            put: vi.fn((store: keyof typeof stores, value: unknown, key: string) => {
                stores[store].set(key, value);
            }),
            getAll: vi.fn((store: keyof typeof stores) =>
                Promise.resolve([...stores[store].values()]),
            ),
        };
        const createDb = () => {
            const db = new ChatsDb({ toString: () => "test-user" } as Principal);
            Object.defineProperty(db, "connectionManager", {
                value: { getDb: () => Promise.resolve(fakeDb) },
            });
            return db;
        };

        await createDb().recordFailedMessage(CHAT, event(provenanceCard(), 1n));
        expect(fakeDb.put).not.toHaveBeenCalled();
        expect(stores.failed_chat_messages.size).toBe(0);

        // A new ChatsDb instance models a restart reading the same persistent stores.
        const afterRestart = await createDb().loadFailedMessages();
        expect([...afterRestart.values()]).toEqual([]);
        expect(
            [...stores.failed_chat_messages.values()].some(
                (value) =>
                    (value as { event?: { content?: ActionCardContent } }).event?.content
                        ?.appProvenance !== undefined,
            ),
        ).toBe(false);
    });
});
