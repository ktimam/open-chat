import type { ActionCardContent, MessageContent, NewUnconfirmedMessage } from "@shared";
import { describe, expect, it } from "vitest";
import { serialiseMessageForRtc } from "./chat";

function message(content: MessageContent): NewUnconfirmedMessage {
    return {
        timestamp: 1n,
        messageId: 2n,
        sender: "aaaaa-aa",
        content,
        forwarded: false,
        blockLevelMarkdown: false,
        ogPreviews: [],
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
        state: "pending",
        ...overrides,
    };
}

describe("action-card RTC privacy", () => {
    it("never sends a live app-provenance bearer to chat peers", () => {
        const original = message(
            card({
                appId: 7,
                appRevision: 9n,
                appProvenance: Uint8Array.from({ length: 32 }, (_, i) => i),
                confirmPayload: new TextEncoder().encode(
                    '{"amount":10,"private_note":"not a public row"}',
                ),
            }),
        );

        const serialised = serialiseMessageForRtc(original);

        // Until the chat canister returns the authoritative event, peers may receive only a
        // placeholder. The one-use bearer and exact sender-only payload are still live when the
        // update is merely "accepted".
        expect(serialised.content).toEqual({ kind: "placeholder_content" });
    });

    it("does not RTC-broadcast a send-only card payload even without provenance", () => {
        const original = message(
            card({
                confirmPayload: new TextEncoder().encode('{"private_note":"not public"}'),
                recipientPublicKey: "recipient-key",
                inboxCanisterId: "aaaaa-aa",
            }),
        );

        expect(serialiseMessageForRtc(original).content).toEqual({
            kind: "placeholder_content",
        });
    });

    it("does not RTC-broadcast client-forged verification fields", () => {
        const original = message(card({ appVerified: true, appContentVerified: true }));

        expect(serialiseMessageForRtc(original).content).toEqual({
            kind: "placeholder_content",
        });
    });

    it("keeps a classic public-only action card unchanged", () => {
        const original = message(card());
        expect(serialiseMessageForRtc(original)).toBe(original);
    });

    it("keeps an ordinary text message unchanged", () => {
        const original = message({ kind: "text_content", text: "hello" });
        expect(serialiseMessageForRtc(original)).toBe(original);
    });
});
