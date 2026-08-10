import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OpenChat } from "@client";
import type { AiAppRegistration, AiAppSurface, ChatIdentifier } from "@shared";

// Surface URL tests do not exercise local inference; isolate them from the multi-GB WASM loader.
vi.mock("./onDeviceInference", () => ({ isNativeClient: () => false }));
import {
    cardSurfaceOpening,
    cardSurfaceForAction,
    createChatLinkSurfaceOpening,
    hasChatLinkSurface,
    privateMatchSurfaceOpening,
    resolveActionAppForCard,
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
        createAiAppChatLinkToken: async () => ({
            token: Uint8Array.from({ length: 32 }, (_, index) => index),
            expiresAt: 123n,
        }),
        cancelAiAppChatLinkToken: async () => true,
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

describe("privateMatchSurfaceOpening", () => {
    function privateApp(
        surface: { kind: string; url: string; display: "sheet" | "external" },
        perUserKeys = true,
    ): AiAppRegistration {
        const value = app(9, { surfaces: [surface] });
        value.manifest.perUserKeys = perUserKeys;
        return value;
    }

    it("resolves only a paired-app sheet surface without private URL material", () => {
        const opening = privateMatchSurfaceOpening(
            privateApp({
                kind: "private_match",
                url: "https://app.example/openchat/private-match",
                display: "sheet",
            }),
            CHAT,
        );
        expect(opening?.url).toBe("https://app.example/openchat/private-match");
        expect(opening?.dataDisclosures).toEqual([]);
    });

    it("rejects external, unpaired and capability-bearing matcher surfaces", () => {
        expect(
            privateMatchSurfaceOpening(
                privateApp({
                    kind: "private_match",
                    url: "https://app.example/match",
                    display: "external",
                }),
                CHAT,
            ),
        ).toBeUndefined();
        expect(
            privateMatchSurfaceOpening(
                privateApp(
                    {
                        kind: "private_match",
                        url: "https://app.example/match",
                        display: "sheet",
                    },
                    false,
                ),
                CHAT,
            ),
        ).toBeUndefined();
        expect(
            privateMatchSurfaceOpening(
                privateApp({
                    kind: "private_match",
                    url: "https://app.example/match#cap={capability}",
                    display: "sheet",
                }),
                CHAT,
            ),
        ).toBeUndefined();
    });
});

describe("surface destination disclosure and consent markers", () => {
    it("mints a canonical fragment bearer without exposing raw chat or user identifiers", async () => {
        const direct: ChatIdentifier = { kind: "direct_chat", userId: "ed6q5-uqcai-ba" };
        const target = app(73, {
            surfaces: [
                {
                    kind: "chat_link",
                    url: "https://app.example/setup#app={appId}&token={chatLinkToken}",
                },
            ],
        });
        expect(hasChatLinkSurface(target)).toBe(true);
        const client = stubClient([], []);
        const opening = await createChatLinkSurfaceOpening(client, target, direct, "Manager");
        expect(opening?.dataDisclosures).toEqual([
            "app_id",
            "one_time_chat_link_token",
            "chat_display_name",
        ]);
        expect(opening?.url).toBe(
            "https://app.example/setup#app=73&token=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
        );
        expect(opening?.url).not.toContain(direct.userId);
        const legacy = app(73, {
            surfaces: [{ kind: "chat_link", url: "https://app.example/setup?chat={chatKey}" }],
        });
        expect(hasChatLinkSurface(legacy)).toBe(false);
    });

    it("preserves a path-like fragment route around the canonical token", async () => {
        const target = app(73, {
            surfaces: [
                {
                    kind: "chat_link",
                    url: "https://app.example/settings#openchat-routing/{chatLinkToken}",
                },
            ],
        });

        const opening = await createChatLinkSurfaceOpening(
            stubClient([], []),
            target,
            CHAT,
            "Household",
        );

        expect(opening?.url).toBe(
            "https://app.example/settings#openchat-routing/AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
        );
        expect(opening?.dataDisclosures).toEqual([
            "one_time_chat_link_token",
            "chat_display_name",
        ]);
    });

    it("uses unpadded base64url rather than hex or standard base64", async () => {
        const target = app(73, {
            surfaces: [
                {
                    kind: "chat_link",
                    url: "https://app.example/settings#token={chatLinkToken}",
                },
            ],
        });
        const client = {
            createAiAppChatLinkToken: async () => ({
                token: new Uint8Array(32).fill(0xff),
                expiresAt: 123n,
            }),
            cancelAiAppChatLinkToken: async () => true,
        } as unknown as OpenChat;

        const opening = await createChatLinkSurfaceOpening(client, target, CHAT, "Household");
        const encoded = opening?.url.split("#token=")[1];

        expect(encoded).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(encoded).toContain("_");
        expect(encoded).not.toMatch(/[+/=]/);
    });

    it("cancels a malformed minted bearer instead of constructing a URL", async () => {
        const token = new Uint8Array(31);
        const cancelAiAppChatLinkToken = vi.fn(async () => true);
        const client = {
            createAiAppChatLinkToken: async () => ({ token, expiresAt: 123n }),
            cancelAiAppChatLinkToken,
        } as unknown as OpenChat;
        const target = app(73, {
            surfaces: [
                {
                    kind: "chat_link",
                    url: "https://app.example/settings#token={chatLinkToken}",
                },
            ],
        });

        await expect(
            createChatLinkSurfaceOpening(client, target, CHAT, "Household"),
        ).resolves.toBeUndefined();
        expect(cancelAiAppChatLinkToken).toHaveBeenCalledOnce();
        expect(cancelAiAppChatLinkToken).toHaveBeenCalledWith(token);
    });

    it("uses one immutable validated descriptor across the mint await", async () => {
        const originalUrl = "https://app.example/settings#token={chatLinkToken}";
        const target = app(41, {
            surfaces: [{ kind: "chat_link", url: originalUrl }],
        });
        let resolveMint!: (value: { token: Uint8Array; expiresAt: bigint }) => void;
        const mint = new Promise<{ token: Uint8Array; expiresAt: bigint }>((resolve) => {
            resolveMint = resolve;
        });
        const createAiAppChatLinkToken = vi.fn(() => mint);
        const client = {
            createAiAppChatLinkToken,
            cancelAiAppChatLinkToken: vi.fn(async () => true),
        } as unknown as OpenChat;

        const openingPromise = createChatLinkSurfaceOpening(client, target, CHAT, "Household");
        target.id = 99;
        target.updated = 999n;
        target.manifest.name = "mutated app";
        target.manifest.surfaces![0].url =
            "https://attacker.example/settings#token={chatLinkToken}";
        resolveMint({ token: new Uint8Array(32).fill(7), expiresAt: 123n });
        const opening = await openingPromise;

        expect(createAiAppChatLinkToken).toHaveBeenCalledWith(CHAT, "Household", 41, 410n);
        expect(opening?.url).toMatch(/^https:\/\/app\.example\/settings#token=/);
        expect(opening?.app.id).toBe(41);
        expect(opening?.app.updated).toBe(410n);
        expect(opening?.app.manifest.name).toBe("app41");
        expect(opening?.surface.url).toBe(originalUrl);
    });

    it("requires exactly one canonical token placeholder after the fragment marker", () => {
        const urls = [
            "https://app.example/setup?token={chatLinkToken}",
            "https://app.example/setup#{chatLinkToken}{chatLinkToken}",
            "https://app.example/setup#token=%7BchatLinkToken%7D",
            "https://app.example/setup#token={chat_link_token}",
            "https://app.example/setup#token={chatLinkToken}&chat={chatId}",
            "https://app.example/setup#token={chatLinkToken}&user={viewerId}",
        ];
        for (const url of urls) {
            expect(hasChatLinkSurface(app(73, { surfaces: [{ kind: "chat_link", url }] }))).toBe(
                false,
            );
        }
    });

    it("creates distinct URLs for distinct chats and opaque tokens", async () => {
        const target = app(73, {
            surfaces: [
                {
                    kind: "chat_link",
                    url: "https://app.example/setup#token={chatLinkToken}",
                },
            ],
        });
        const firstChat: ChatIdentifier = { kind: "group_chat", groupId: "group-one" };
        const secondChat: ChatIdentifier = { kind: "group_chat", groupId: "group-two" };
        const client = {
            createAiAppChatLinkToken: async (chatId: ChatIdentifier) => ({
                token: new Uint8Array(32).fill(chatId === firstChat ? 1 : 2),
                expiresAt: 123n,
            }),
            cancelAiAppChatLinkToken: async () => true,
        } as unknown as OpenChat;
        const first = await createChatLinkSurfaceOpening(client, target, firstChat, "First");
        const second = await createChatLinkSurfaceOpening(client, target, secondChat, "Second");
        expect(first?.url).not.toBe(second?.url);
        expect(first?.url).not.toContain(firstChat.groupId);
        expect(second?.url).not.toContain(secondChat.groupId);
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
            resolve(__dirname, "../components/home/ActionCardContent.svelte"),
            "utf8",
        );
        expect(source).toContain('class="app-identity"');
        expect(source).toContain("{resolvedAppIdentity.name}");
        expect(source).toContain('class="card-url"');
        expect(source).not.toContain("Security details");
        expect(source).not.toContain("{resolvedAppIdentity.id}");
        expect(source).toContain('class="sender-title"');
        expect(source).toContain("{content.title}");
        expect(source).toContain('title="Isolated action app card"');
        expect(source).not.toContain("title={content.title}");
    });
});
