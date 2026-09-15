import type { Principal } from "@icp-sdk/core/principal";
import type {
    ActionCardContent,
    EventWrapper,
    Message,
    MessageContent,
    SendMessageSuccess,
} from "@shared";
import { describe, expect, it, vi } from "vitest";
import { ChatsDb } from "./chatsDb";

const CHAT = { kind: "group_chat", groupId: "aaaaa-aa" } as const;

function success(): SendMessageSuccess {
    return {
        kind: "success",
        timestamp: 10n,
        messageIndex: 3,
        eventIndex: 4,
    };
}

function card(overrides: Partial<ActionCardContent> = {}): ActionCardContent {
    return {
        kind: "action_card_content",
        title: "Add entry",
        rows: [{ label: "Amount", value: "10" }],
        confirmLabel: "Add",
        cancelLabel: "Cancel",
        actionId: "entry.add",
        appId: 7,
        appRevision: 9n,
        state: "pending",
        ...overrides,
    };
}

function event(content: MessageContent): EventWrapper<Message> {
    return {
        index: 4,
        timestamp: 1n,
        event: {
            kind: "message",
            messageId: 2n,
            messageIndex: 3,
            sender: "aaaaa-aa",
            content,
            repliesTo: undefined,
        },
    } as EventWrapper<Message>;
}

function completeSend(content: MessageContent, response: SendMessageSuccess) {
    const db = new ChatsDb({ toString: () => "test-user" } as Principal);
    const cache = vi.spyOn(db, "setCachedMessageIfNotExists").mockResolvedValue();
    const sent = event(content);
    const [, returned] = db.setCachedMessageFromSendResponse(CHAT, sent)([response, sent.event]);
    const cached = cache.mock.calls[0]?.[1] as EventWrapper<Message> | undefined;
    return { returned, cached, sent };
}

describe("successful action-card sender reconciliation", () => {
    it("marks a successfully accepted nonempty-provenance card as backend verified", () => {
        const { returned, sent } = completeSend(
            card({ appProvenance: new Uint8Array(32).fill(7) }),
            success(),
        );

        for (const content of [returned.content, sent.event.content]) {
            expect(content).toMatchObject({
                kind: "action_card_content",
                appVerified: true,
                appContentVerified: true,
            });
        }
    });

    it("retains hidden exact payload only in the live sender event and scrubs the cache", () => {
        const confirmPayload = new TextEncoder().encode(
            '{"amount":10,"private_note":"not a public row"}',
        );
        const { returned, cached, sent } = completeSend(
            card({
                appProvenance: new Uint8Array(32).fill(7),
                confirmPayload,
                recipientPublicKey: "recipient-key",
                recipientPublicKeys: ["other-key"],
                inboxCanisterId: "aaaaa-aa",
            }),
            success(),
        );

        const liveContents = [returned.content, sent.event.content] as ActionCardContent[];
        for (const liveContent of liveContents) {
            expect(liveContent.confirmPayload).toEqual(confirmPayload);
            expect(liveContent.confirmPayload).not.toBe(confirmPayload);
            expect(new TextDecoder().decode(liveContent.confirmPayload)).toBe(
                '{"amount":10,"private_note":"not a public row"}',
            );
            expect(liveContent.appVerified).toBe(true);
            expect(liveContent.appContentVerified).toBe(true);
        }

        const cachedContent = cached?.event.content as ActionCardContent;
        expect(cachedContent.appVerified).toBe(true);
        expect(cachedContent.appContentVerified).toBe(true);
        expect(cachedContent.confirmPayload).toBeUndefined();

        for (const content of [...liveContents, cachedContent]) {
            expect(content.appProvenance).toBeUndefined();
            expect(content.recipientPublicKey).toBeUndefined();
            expect(content.recipientPublicKeys).toBeUndefined();
            expect(content.inboxCanisterId).toBeUndefined();
        }
    });

    it("does not preserve forged client verification when the backend did not attest the card", () => {
        const { returned } = completeSend(
            card({ appVerified: true, appContentVerified: true }),
            success(),
        );
        const returnedCard = returned.content as ActionCardContent;

        expect(returnedCard.appVerified).not.toBe(true);
        expect(returnedCard.appContentVerified).not.toBe(true);
    });

    it("does not verify a successful card carrying an empty provenance field", () => {
        const { returned } = completeSend(card({ appProvenance: new Uint8Array() }), success());
        const returnedCard = returned.content as ActionCardContent;

        expect(returnedCard.appVerified).not.toBe(true);
        expect(returnedCard.appContentVerified).not.toBe(true);
        expect(returnedCard.appProvenance).toBeUndefined();
    });

    it("keeps a classic proof-free card unverified and does not retain its client payload", () => {
        const { returned, cached } = completeSend(
            card({
                confirmPayload: new TextEncoder().encode(
                    '{"amount":10,"private_note":"not attested"}',
                ),
            }),
            success(),
        );
        const returnedCard = returned.content as ActionCardContent;
        const cachedCard = cached?.event.content as ActionCardContent;

        expect(returnedCard.appVerified).not.toBe(true);
        expect(returnedCard.appContentVerified).not.toBe(true);
        expect(returnedCard.appProvenance).toBeUndefined();
        expect(returnedCard.confirmPayload).toBeUndefined();
        expect(cachedCard.confirmPayload).toBeUndefined();
    });

    it("does not change ordinary message content", () => {
        const text = { kind: "text_content", text: "hello" } as const;
        const { returned } = completeSend(text, success());
        expect(returned.content).toEqual(text);
    });
});
