import { describe, expect, it } from "vitest";
import type { ChatEvent, EventWrapper } from "@client";
import { eventKey } from "./flatChatItems";

function message(index: number, sender: string, messageId: bigint): EventWrapper<ChatEvent> {
    return {
        index,
        timestamp: 0n,
        event: {
            kind: "message",
            sender,
            messageId,
            messageIndex: index,
            content: { kind: "text_content", text: "school" },
        },
    } as EventWrapper<ChatEvent>;
}

describe("flat chat event identity", () => {
    it("keeps a message key stable when its optimistic event index is confirmed", () => {
        expect(eventKey(message(500, "viewer-a", 7n), "viewer-a:group:main")).toBe(
            eventKey(message(12, "viewer-a", 7n), "viewer-a:group:main"),
        );
    });

    it("distinguishes exact root/reply wrappers even when index, sender and id collide", () => {
        const event = message(2, "viewer-a", 7n);
        expect(eventKey(event, "viewer-a:group:thread_root")).not.toBe(
            eventKey(event, "viewer-a:group:thread_reply:2"),
        );
    });

    it("does not reuse a direct-chat row across viewers", () => {
        const event = message(2, "same-other-user", 7n);
        expect(eventKey(event, "viewer-a:direct:same-other-user:main")).not.toBe(
            eventKey(event, "viewer-b:direct:same-other-user:main"),
        );
    });
});
