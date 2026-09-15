import type { ActionCardContent } from "@shared";
import { describe, expect, it } from "vitest";
import { apiMessageContent, messageContent } from "./chatMappersV2";

function mappedCard(appContentVerified?: boolean): ActionCardContent {
    return messageContent(
        {
            ActionCard: {
                title: "Untrusted sender text",
                rows: [{ label: "Amount", value: "999" }],
                confirm_label: "Confirm",
                cancel_label: "Cancel",
                action_id: "entry.add",
                app_id: 7,
                app_revision: 2n,
                app_verified: true,
                app_content_verified: appContentVerified,
                state: "Pending",
            },
        } as Parameters<typeof messageContent>[0],
        "2vxsx-fae",
    ) as ActionCardContent;
}

describe("action-card content-attestation mapping", () => {
    it("keeps an absent wire attestation absent rather than deriving it from app_verified", () => {
        const card = mappedCard();
        expect(card.appVerified).toBe(true);
        expect(card.appContentVerified).toBeUndefined();
    });

    it("maps only the backend-provided full-content attestation bit", () => {
        expect(mappedCard(false).appContentVerified).toBe(false);
        expect(mappedCard(true).appContentVerified).toBe(true);
    });

    it("never serializes client-supplied verification bits on a new card", () => {
        const forged: ActionCardContent = {
            kind: "action_card_content",
            title: "Forged",
            rows: [{ label: "Amount", value: "999" }],
            confirmLabel: "Confirm",
            cancelLabel: "Cancel",
            actionId: "entry.add",
            appId: 7,
            appRevision: 2n,
            appVerified: true,
            appContentVerified: true,
            state: "pending",
        };
        const encoded = apiMessageContent(forged) as {
            ActionCard: Record<string, unknown>;
        };
        expect(encoded.ActionCard).not.toHaveProperty("app_verified");
        expect(encoded.ActionCard).not.toHaveProperty("app_content_verified");
    });
});
