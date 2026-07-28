import { describe, it, expect } from "vitest";
import type { AiAppRegistration, AiAppSurface, ChatIdentifier, OpenChat } from "openchat-client";
import { cardSurfaceOpening, cardSurfaceForAction } from "./aiAppSurfaces";

// Minimal AiAppRegistration — only the fields the surface resolver reads. Cast through unknown so the
// test isn't coupled to every manifest field.
function app(
    id: number,
    opts: {
        surfaces?: { kind: string; url: string }[];
        actions?: { name: string; rows?: { label: string; valueKey: string }[] }[];
    },
): AiAppRegistration {
    return {
        id,
        manifest: {
            name: `app${id}`,
            surfaces: (opts.surfaces ?? []) as AiAppSurface[],
            actions: (opts.actions ?? []).map((a) => ({
                name: a.name,
                card: { rows: a.rows ?? [] },
            })),
        },
    } as unknown as AiAppRegistration;
}

function stubClient(apps: AiAppRegistration[], enabledIds: number[]): OpenChat {
    return {
        aiApps: async () => apps,
        enabledAiApps: async (_chatId: ChatIdentifier) => enabledIds,
    } as unknown as OpenChat;
}

const CHAT: ChatIdentifier = { kind: "direct_chat", userId: "u1" } as ChatIdentifier;
const CARD_URL = "https://iou.example/openchat/card?chat={chatKey}&app={appId}";

describe("cardSurfaceOpening", () => {
    it("substitutes {chatKey} (URI-encoded) and {appId} when a 'card' surface exists", () => {
        const opening = cardSurfaceOpening(app(7, { surfaces: [{ kind: "card", url: CARD_URL }] }), CHAT);
        expect(opening).toBeDefined();
        // chatKeyFor(direct_chat u1) === "direct:u1" → encodeURIComponent → "direct%3Au1"
        expect(opening!.url).toBe("https://iou.example/openchat/card?chat=direct%3Au1&app=7");
    });

    it("returns undefined when the app declares no 'card' surface", () => {
        expect(cardSurfaceOpening(app(7, { surfaces: [{ kind: "chat_link", url: CARD_URL }] }), CHAT)).toBeUndefined();
        expect(cardSurfaceOpening(app(7, {}), CHAT)).toBeUndefined();
    });
});

describe("cardSurfaceForAction — owner resolution + labelToField", () => {
    const ACTION = "iou.entry.import";
    const withCard = (id: number) =>
        app(id, {
            surfaces: [{ kind: "card", url: CARD_URL }],
            actions: [{ name: ACTION, rows: [{ label: "Amount", valueKey: "amount" }, { label: "Currency", valueKey: "currency" }] }],
        });

    it("prefers an owner ENABLED in the chat over the first owner", async () => {
        const first = withCard(1);
        const enabled = withCard(2);
        const opening = await cardSurfaceForAction(stubClient([first, enabled], [2]), CHAT, ACTION);
        expect(opening?.app.id).toBe(2);
        expect(opening?.url).toContain("app=2");
    });

    it("falls back to the first owner when none is enabled", async () => {
        const first = withCard(1);
        const other = withCard(2);
        const opening = await cardSurfaceForAction(stubClient([first, other], []), CHAT, ACTION);
        expect(opening?.app.id).toBe(1);
    });

    it("builds labelToField from the owning action's card.rows", async () => {
        const opening = await cardSurfaceForAction(stubClient([withCard(1)], [1]), CHAT, ACTION);
        expect(opening?.labelToField).toEqual({ Amount: "amount", Currency: "currency" });
    });

    it("returns undefined when no app owns the action", async () => {
        const strangerAction = app(1, { surfaces: [{ kind: "card", url: CARD_URL }], actions: [{ name: "other.action" }] });
        expect(await cardSurfaceForAction(stubClient([strangerAction], [1]), CHAT, ACTION)).toBeUndefined();
    });

    it("returns undefined when the owning app declares no 'card' surface (falls back to OC rows)", async () => {
        const noCard = app(1, { surfaces: [{ kind: "chat_link", url: CARD_URL }], actions: [{ name: ACTION }] });
        expect(await cardSurfaceForAction(stubClient([noCard], [1]), CHAT, ACTION)).toBeUndefined();
    });

    it("degrades to undefined on any lookup failure (try/catch)", async () => {
        const throwing = {
            aiApps: async () => {
                throw new Error("network");
            },
            enabledAiApps: async () => [],
        } as unknown as OpenChat;
        expect(await cardSurfaceForAction(throwing, CHAT, ACTION)).toBeUndefined();
    });
});

describe("cardSurfaceForAction — appId binding (anti-impersonation)", () => {
    const ACTION = "iou.entry.import";
    const withCard = (id: number, action = ACTION) =>
        app(id, {
            surfaces: [{ kind: "card", url: CARD_URL }],
            actions: [{ name: action, rows: [{ label: "Amount", valueKey: "amount" }] }],
        });

    it("binds to the EXACT producing app even when another app declares the same action name", async () => {
        // app 1 is the real producer (carried on the card); app 2 is a squatter declaring the same
        // action name and even ENABLED in the chat — pre-binding, name-resolution would have preferred
        // it. With the appId carried, resolution must ignore the squatter entirely.
        const producer = withCard(1);
        const squatter = withCard(2);
        const opening = await cardSurfaceForAction(
            stubClient([producer, squatter], [2]),
            CHAT,
            ACTION,
            1,
        );
        expect(opening?.app.id).toBe(1);
        expect(opening?.url).toContain("app=1");
    });

    it("returns undefined when the carried appId no longer owns the action (never re-binds)", async () => {
        // The card names app 1, but app 1 no longer declares ACTION (manifest changed). We must NOT
        // silently re-bind to app 2 which does — render OC rows instead.
        const staleProducer = withCard(1, "some.other.action");
        const otherOwner = withCard(2);
        expect(
            await cardSurfaceForAction(stubClient([staleProducer, otherOwner], [2]), CHAT, ACTION, 1),
        ).toBeUndefined();
    });

    it("returns undefined when the carried appId matches no known app", async () => {
        expect(
            await cardSurfaceForAction(stubClient([withCard(2)], [2]), CHAT, ACTION, 99),
        ).toBeUndefined();
    });

    it("still resolves by name when the card carries no appId (legacy card)", async () => {
        const owner = withCard(5);
        const opening = await cardSurfaceForAction(stubClient([owner], [5]), CHAT, ACTION);
        expect(opening?.app.id).toBe(5);
    });

    it("returns undefined when the bound app owns the action but declares NO 'card' surface", async () => {
        // app 1 IS the producer and still owns the action, but its manifest has no card surface. We
        // must render OC rows — never fall through to app 2's card surface just because it has one.
        const boundNoCard = app(1, {
            surfaces: [{ kind: "chat_link", url: CARD_URL }],
            actions: [{ name: ACTION }],
        });
        const otherWithCard = withCard(2);
        expect(
            await cardSurfaceForAction(stubClient([boundNoCard, otherWithCard], [2]), CHAT, ACTION, 1),
        ).toBeUndefined();
    });
});
