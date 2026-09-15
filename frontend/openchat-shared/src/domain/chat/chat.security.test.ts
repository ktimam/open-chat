import { describe, expect, it } from "vitest";
import type { ActionCardContent } from "./chat";
import { canRetryMessage } from "./chat";

function card(appProvenance?: Uint8Array): ActionCardContent {
    return {
        kind: "action_card_content",
        title: "Card",
        rows: [],
        confirmLabel: "Confirm",
        cancelLabel: "Cancel",
        actionId: "example.action",
        state: "pending",
        appProvenance,
    };
}

describe("failed-message retry security", () => {
    it("never retries or persists a card carrying a short-lived provenance bearer", () => {
        expect(canRetryMessage(card(new Uint8Array(32)))).toBe(false);
    });

    it("keeps legacy proof-free card retry behavior", () => {
        expect(canRetryMessage(card())).toBe(true);
    });
});
