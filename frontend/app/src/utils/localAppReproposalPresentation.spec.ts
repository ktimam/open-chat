import { describe, expect, it } from "vitest";
import type { LocalDraftView } from "./localAppDrafts";
import type { LocalAppCardAnchorSource } from "./localAppCardAnchors";
import { hasLocalAppSourceProposal } from "./localAppReproposalPresentation";

const namespace = { account: "test-account", backend: "test-backend" };
const source: LocalAppCardAnchorSource = {
    chatKind: "direct_chat",
    chatKey: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    messageId: "123",
    messageIndex: 3,
};
const target = { appId: "test-app", actionId: "test-action" };
const card: LocalDraftView = {
    id: "retained-card",
    revision: 0,
    status: "draft",
    target: { ...target, destination: "https://app.invalid", recipient: "test-recipient" },
    payload: {},
};
const state = { ...namespace, cards: [card], cardSources: { [card.id]: source } };

describe("same-message proposal label", () => {
    it.each(["draft", "reviewed", "sending", "delivered", "uncertain"] as const)(
        "offers Propose again for a retained %s card without changing it",
        (status) => {
            const retained = { ...card, status };
            expect(
                hasLocalAppSourceProposal(
                    { ...state, cards: [retained] },
                    namespace,
                    source,
                    target,
                ),
            ).toBe(true);
            expect(retained.status).toBe(status);
            expect(retained.payload).toEqual({});
        },
    );

    it("does not leak another account, backend, app, action, or message into the label", () => {
        expect(hasLocalAppSourceProposal(state, undefined, source, target)).toBe(false);
        for (const changed of [{ account: "other" }, { backend: "other" }])
            expect(
                hasLocalAppSourceProposal({ ...state, ...changed }, namespace, source, target),
            ).toBe(false);
        for (const changed of [{ appId: "other" }, { actionId: "other" }])
            expect(
                hasLocalAppSourceProposal(state, namespace, source, { ...target, ...changed }),
            ).toBe(false);
        for (const changed of [
            { messageId: "456" },
            { chatKey: "ryjl3-tyaaa-aaaaa-aaaba-cai" },
            { threadRootMessageIndex: 0 },
        ])
            expect(
                hasLocalAppSourceProposal(state, namespace, { ...source, ...changed }, target),
            ).toBe(false);
    });

    it("uses message identity, not an index that can change", () => {
        expect(
            hasLocalAppSourceProposal(state, namespace, { ...source, messageIndex: 42 }, target),
        ).toBe(true);
    });

    it("returns to the first-proposal label when no associated card remains", () => {
        expect(hasLocalAppSourceProposal({ ...state, cards: [] }, namespace, source, target)).toBe(
            false,
        );
        expect(
            hasLocalAppSourceProposal({ ...state, cardSources: {} }, namespace, source, target),
        ).toBe(false);
    });
});
