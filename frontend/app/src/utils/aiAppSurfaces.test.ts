import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AiAppRegistration, AiAppSurface, ChatIdentifier, OpenChat } from "openchat-client";
import {
    appForPostConfirm,
    aiAppSurfaceMarkerForViewer,
    cardSurfaceOpening,
    cardSurfaceForAction,
    chatLinkSurfaceOpening,
    markSurfaceShownAfterConsent,
    parseAiAppSurfaceShownMarkers,
    resolveActionAppForCard,
    surfaceToOpenAfterConfirm,
    validatedAppIconUrl,
} from "./aiAppSurfaces";

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
        updated: BigInt(id * 10),
        published: true,
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

const CHAT: ChatIdentifier = {
    kind: "group_chat",
    groupId: "dgegb-daaaa-aaaar-arlhq-cai",
};
const CARD_URL = "https://app.example/chat/card?app={appId}";

describe("cardSurfaceOpening", () => {
    it("substitutes only the public {appId} when a 'card' surface exists", () => {
        const opening = cardSurfaceOpening(
            app(7, { surfaces: [{ kind: "card", url: CARD_URL }] }),
            CHAT,
        );
        expect(opening).toBeDefined();
        // chatKeyFor(direct_chat u1) === "direct:u1" → encodeURIComponent → "direct%3Au1"
        expect(opening!.url).toBe("https://app.example/chat/card?app=7");
        expect(opening!.dataDisclosures).toEqual(["app_id"]);
    });

    it("rejects chat, identity, capability, and every unknown card URL placeholder", () => {
        for (const placeholder of ["chatKey", "viewerId", "messageId", "capability", "future"]) {
            expect(
                cardSurfaceOpening(
                    app(7, {
                        surfaces: [
                            { kind: "card", url: `https://app.example/card?x={${placeholder}}` },
                        ],
                    }),
                    CHAT,
                ),
            ).toBeUndefined();
        }
    });

    it("returns undefined when the app declares no 'card' surface", () => {
        expect(
            cardSurfaceOpening(app(7, { surfaces: [{ kind: "chat_link", url: CARD_URL }] }), CHAT),
        ).toBeUndefined();
        expect(cardSurfaceOpening(app(7, {}), CHAT)).toBeUndefined();
    });
});

describe("surface destination disclosure and consent markers", () => {
    it("discloses only the public app id and rejects legacy raw-chat placeholders", () => {
        const direct: ChatIdentifier = { kind: "direct_chat", userId: "ed6q5-uqcai-ba" };
        const opening = chatLinkSurfaceOpening(
            app(73, {
                surfaces: [
                    {
                        kind: "chat_link",
                        url: "https://app.example/setup?app={appId}",
                    },
                ],
            }),
            direct,
            "scp3f-4qbae-aq",
        );
        expect(opening?.dataDisclosures).toEqual(["app_id"]);
        expect(opening?.url).toBe("https://app.example/setup?app=73");
        const legacy = app(73, {
            surfaces: [{ kind: "chat_link", url: "https://app.example/setup?chat={chatKey}" }],
        });
        expect(chatLinkSurfaceOpening(legacy, direct, "scp3f-4qbae-aq")).toBeUndefined();
    });

    it("treats malformed or oversized cached markers as empty", () => {
        for (const raw of [null, "not-json", "{}", JSON.stringify(new Array(1_001).fill("x"))]) {
            expect(parseAiAppSurfaceShownMarkers(raw).size).toBe(0);
        }
        expect(parseAiAppSurfaceShownMarkers(JSON.stringify(["ok", 1, ""]))).toEqual(
            new Set(["ok"]),
        );
    });

    it("scopes a marker to the signed-in viewer", () => {
        expect(aiAppSurfaceMarkerForViewer("viewer-a", 7, "group:g")).not.toBe(
            aiAppSurfaceMarkerForViewer("viewer-b", 7, "group:g"),
        );
        expect(aiAppSurfaceMarkerForViewer(undefined, 7, "group:g")).toBeUndefined();
    });

    it("does not mark a post-confirm surface until the host-owned consent choice", async () => {
        const producer = app(907, {
            surfaces: [
                {
                    kind: "chat_link",
                    url: "https://app.example/setup?app={appId}",
                },
            ],
            actions: [{ name: "sample.action" }],
        });
        const client = stubClient([producer], [producer.id]);
        const first = await surfaceToOpenAfterConfirm(
            client,
            CHAT,
            "sample.action",
            producer.id,
            producer.updated,
            "viewer-a",
        );
        expect(first).toBeDefined();
        expect(
            await surfaceToOpenAfterConfirm(
                client,
                CHAT,
                "sample.action",
                producer.id,
                producer.updated,
                "viewer-a",
            ),
        ).toBeDefined();
        expect(markSurfaceShownAfterConsent(first!, CHAT, "viewer-a")).toBe(true);
        expect(
            await surfaceToOpenAfterConfirm(
                client,
                CHAT,
                "sample.action",
                producer.id,
                producer.updated,
                "viewer-a",
            ),
        ).toBeUndefined();
        expect(
            await surfaceToOpenAfterConfirm(
                client,
                CHAT,
                "sample.action",
                producer.id,
                producer.updated,
                "viewer-b",
            ),
        ).toBeDefined();
    });
});

describe("cardSurfaceForAction — owner resolution + labelToField", () => {
    const ACTION = "sample.action";
    const withCard = (id: number) =>
        app(id, {
            surfaces: [{ kind: "card", url: CARD_URL }],
            actions: [
                {
                    name: ACTION,
                    rows: [
                        { label: "Amount", valueKey: "amount" },
                        { label: "Currency", valueKey: "currency" },
                    ],
                },
            ],
        });

    it("uses the exact carried owner even when another owner is enabled", async () => {
        const first = withCard(1);
        const enabled = withCard(2);
        const opening = await cardSurfaceForAction(
            stubClient([first, enabled], [2]),
            CHAT,
            ACTION,
            enabled.id,
            enabled.updated,
        );
        expect(opening?.app.id).toBe(2);
        expect(opening?.url).toContain("app=2");
    });

    it("does not render an app surface without immutable producer provenance", async () => {
        const first = withCard(1);
        const other = withCard(2);
        const opening = await cardSurfaceForAction(stubClient([first, other], []), CHAT, ACTION);
        expect(opening).toBeUndefined();
    });

    it("builds labelToField from the owning action's card.rows", async () => {
        const producer = withCard(1);
        const opening = await cardSurfaceForAction(
            stubClient([producer], [1]),
            CHAT,
            ACTION,
            producer.id,
            producer.updated,
        );
        expect(opening?.labelToField).toEqual({ Amount: "amount", Currency: "currency" });
    });

    it("returns undefined when no app owns the action", async () => {
        const strangerAction = app(1, {
            surfaces: [{ kind: "card", url: CARD_URL }],
            actions: [{ name: "other.action" }],
        });
        expect(
            await cardSurfaceForAction(
                stubClient([strangerAction], [1]),
                CHAT,
                ACTION,
                strangerAction.id,
                strangerAction.updated,
            ),
        ).toBeUndefined();
    });

    it("returns undefined when the owning app declares no 'card' surface (falls back to OC rows)", async () => {
        const noCard = app(1, {
            surfaces: [{ kind: "chat_link", url: CARD_URL }],
            actions: [{ name: ACTION }],
        });
        expect(
            await cardSurfaceForAction(
                stubClient([noCard], [1]),
                CHAT,
                ACTION,
                noCard.id,
                noCard.updated,
            ),
        ).toBeUndefined();
    });

    it("degrades to undefined on any lookup failure (try/catch)", async () => {
        const throwing = {
            aiApps: async () => {
                throw new Error("network");
            },
            enabledAiApps: async () => [],
        } as unknown as OpenChat;
        expect(await cardSurfaceForAction(throwing, CHAT, ACTION, 1, 10n)).toBeUndefined();
    });
});

describe("cardSurfaceForAction — appId binding (anti-impersonation)", () => {
    const ACTION = "sample.action";
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
            stubClient([producer, squatter], [1, 2]),
            CHAT,
            ACTION,
            1,
            producer.updated,
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
            await cardSurfaceForAction(
                stubClient([staleProducer, otherOwner], [2]),
                CHAT,
                ACTION,
                1,
                staleProducer.updated,
            ),
        ).toBeUndefined();
    });

    it("returns undefined when the carried appId matches no known app", async () => {
        expect(
            await cardSurfaceForAction(stubClient([withCard(2)], [2]), CHAT, ACTION, 99, 990n),
        ).toBeUndefined();
    });

    it("does not embed third-party content for a legacy card", async () => {
        const owner = withCard(5);
        const opening = await cardSurfaceForAction(stubClient([owner], [5]), CHAT, ACTION);
        expect(opening).toBeUndefined();
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
            await cardSurfaceForAction(
                stubClient([boundNoCard, otherWithCard], [2]),
                CHAT,
                ACTION,
                1,
                boundNoCard.updated,
            ),
        ).toBeUndefined();
    });

    it("rejects a card from an older app revision after republish", async () => {
        const producer = withCard(1);
        expect(
            await cardSurfaceForAction(
                stubClient([producer], [1]),
                CHAT,
                ACTION,
                producer.id,
                producer.updated - 1n,
            ),
        ).toBeUndefined();
    });
});

describe("resolveActionAppForCard — authoritative host identity", () => {
    const ACTION = "sample.action";

    it("exposes immutable registry name/id/icon instead of the sender-controlled card title", async () => {
        const producer = app(41, {
            surfaces: [{ kind: "card", url: CARD_URL }],
            actions: [{ name: ACTION }],
        });
        producer.manifest.name = "Trusted Ledger";
        producer.manifest.iconUrl = "https://assets.example/ledger.png";

        const resolved = await resolveActionAppForCard(
            stubClient([producer], [producer.id]),
            CHAT,
            ACTION,
            producer.id,
            producer.updated,
        );

        expect(resolved?.identity).toEqual({
            id: 41,
            name: "Trusted Ledger",
            iconUrl: "https://assets.example/ledger.png",
        });
        expect(resolved?.cardSurface?.app.id).toBe(41);
    });

    it("fails closed for missing, stale, and unpublished registry provenance", async () => {
        const producer = app(41, { actions: [{ name: ACTION }] });
        expect(
            await resolveActionAppForCard(
                stubClient([producer], []),
                CHAT,
                ACTION,
                undefined,
                producer.updated,
            ),
        ).toBeUndefined();
        expect(
            await resolveActionAppForCard(
                stubClient([producer], []),
                CHAT,
                ACTION,
                producer.id,
                producer.updated - 1n,
            ),
        ).toBeUndefined();
        producer.published = false;
        expect(
            await resolveActionAppForCard(
                stubClient([producer], []),
                CHAT,
                ACTION,
                producer.id,
                producer.updated,
            ),
        ).toBeUndefined();
    });

    it("only exposes credential-free HTTPS or loopback HTTP icons", () => {
        expect(validatedAppIconUrl("https://assets.example/icon.png")).toBe(
            "https://assets.example/icon.png",
        );
        expect(validatedAppIconUrl("http://localhost:5000/icon.png")).toBe(
            "http://localhost:5000/icon.png",
        );
        expect(validatedAppIconUrl("http://assets.example/icon.png")).toBeUndefined();
        expect(validatedAppIconUrl("https://user:pass@assets.example/icon.png")).toBeUndefined();
        expect(validatedAppIconUrl("data:image/svg+xml,unsafe")).toBeUndefined();
    });

    it("renders registry identity in host-owned chrome separately from the sender title", () => {
        const source = readFileSync(
            resolve(process.cwd(), "src/components/home/ActionCardContent.svelte"),
            "utf8",
        );
        expect(source).toContain('class="app-identity"');
        expect(source).toContain("{resolvedAppIdentity.name}");
        expect(source).toContain("{resolvedAppIdentity.id}");
        expect(source).toContain('class="sender-title"');
        expect(source).toContain("{content.title}");
        expect(source).toContain('title="Isolated action app card"');
        expect(source).not.toContain("title={content.title}");
    });
});

describe("appForPostConfirm — exact producer binding", () => {
    const ACTION = "sample.action";
    const producer = app(11, { actions: [{ name: ACTION }] });
    const collision = app(12, { actions: [{ name: ACTION }] });

    it("selects only the carried producing app id", () => {
        expect(
            appForPostConfirm([collision, producer], [11, 12], ACTION, 11, producer.updated)?.id,
        ).toBe(11);
    });

    it("does not use global action-name fallback for a legacy or unknown producer", () => {
        expect(appForPostConfirm([producer], [11], ACTION, undefined, undefined)).toBeUndefined();
        expect(appForPostConfirm([producer], [11], ACTION, 99, 990n)).toBeUndefined();
    });

    it("does not navigate through a disabled or stale producing app", () => {
        expect(appForPostConfirm([producer], [], ACTION, 11, producer.updated)).toBeUndefined();
        expect(
            appForPostConfirm(
                [app(11, { actions: [{ name: "other.action" }] })],
                [11],
                ACTION,
                11,
                producer.updated,
            ),
        ).toBeUndefined();
        expect(
            appForPostConfirm([producer], [11], ACTION, 11, producer.updated - 1n),
        ).toBeUndefined();
    });
});
