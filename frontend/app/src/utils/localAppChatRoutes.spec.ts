import { describe, expect, it, vi } from "vitest";
import { resolveLocalAppForChat, validateLocalAppChatRoutes } from "./localAppChatRoutes";
import { scopedAppFixture, scopedAccountId, routeHandle } from "./localAppChatRoutes.testFixtures";

describe("account connection and independent chat setup", () => {
    it("resolves two private chat configurations without modifying the account catalog", async () => {
        const f = await scopedAppFixture();
        const chatSetups = [f.route("chat-a", 1), f.route("chat-b", 2)];
        const data = validateLocalAppChatRoutes(
            f.catalog,
            [f.installation],
            f.connections,
            chatSetups,
        );
        expect(
            resolveLocalAppForChat(f.catalog, data.connections, data.chatSetups, "sample", "chat-a")
                ?.recipientLabel,
        ).toBe("Destination 1");
        expect(
            resolveLocalAppForChat(f.catalog, data.connections, data.chatSetups, "sample", "chat-b")
                ?.recipientLabel,
        ).toBe("Destination 2");
        expect(f.catalog.apps[0].recipientLabel).toBeUndefined();
        expect(
            resolveLocalAppForChat(
                f.catalog,
                data.connections,
                data.chatSetups,
                "sample",
                "chat-c",
            ),
        ).toBeUndefined();
        expect(
            resolveLocalAppForChat(f.catalog, data.connections, data.chatSetups, "sample"),
        ).toBeUndefined();
        expect(Object.isFrozen(data.chatSetups[0])).toBe(true);
    });
    it("limits a legacy shared configuration to its recorded existing chats", async () => {
        const f = await scopedAppFixture();
        const connections = [{ ...f.connections[0], legacyChatKeys: ["old-chat"] }];
        expect(resolveLocalAppForChat(f.catalog, connections, [], "sample", "old-chat")).toBe(
            f.catalog.apps[0],
        );
        expect(
            resolveLocalAppForChat(f.catalog, connections, [], "sample", "new-chat"),
        ).toBeUndefined();
        const pending = { ...f.route("old-chat", 1), catalogJson: undefined };
        expect(
            resolveLocalAppForChat(f.catalog, connections, [pending], "sample", "old-chat"),
        ).toBeUndefined();
        expect(
            validateLocalAppChatRoutes(f.catalog, [f.installation], connections, [pending])
                .chatSetups[0],
        ).not.toHaveProperty("catalogJson");
    });
    it("keeps unscoped version-one apps unchanged", async () => {
        const f = await scopedAppFixture();
        expect(resolveLocalAppForChat(f.pkg.catalog, [], [], "sample", "any-chat")).toBe(
            f.pkg.catalog.apps[0],
        );
    });
    it("rejects routes for another app account, unknown apps, duplicates and noncanonical IDs", async () => {
        const f = await scopedAppFixture();
        const route = f.route("chat", 1);
        for (const rows of [
            [{ ...route, accountId: routeHandle(5) }],
            [{ ...route, appId: "unknown" }],
            [{ ...route, handle: `${"A".repeat(42)}B` }],
            [{ ...route, handle: "A".repeat(44) }],
            [{ ...route, chatKey: "bad\nchat" }],
            [{ ...route, chatKey: "x".repeat(513) }],
            [route, { ...route, handle: routeHandle(2) }],
            [route, { ...route, chatKey: "second" }],
        ])
            expect(() =>
                validateLocalAppChatRoutes(f.catalog, [f.installation], f.connections, rows),
            ).toThrow();
        expect(
            resolveLocalAppForChat(
                f.catalog,
                f.connections,
                [{ ...route, accountId: routeHandle(5) }],
                "sample",
                "chat",
            ),
        ).toBeUndefined();
    });
    it("requires pinned publisher provenance and rejects changed recipes/destinations", async () => {
        const f = await scopedAppFixture();
        const route = f.route("chat", 1);
        expect(() => validateLocalAppChatRoutes(f.catalog, [], f.connections, [route])).toThrow();
        for (const change of [
            (app: Record<string, unknown>) => {
                app.destination = "https://other.test/import";
            },
            (app: Record<string, unknown>) => {
                app.revision = "other";
            },
            (app: Record<string, unknown>) => {
                app.processor = { sha256: "f".repeat(64), byteLength: 1 };
            },
        ]) {
            const catalog = JSON.parse(route.catalogJson!);
            change(catalog.apps[0]);
            const forged = { ...route, catalogJson: JSON.stringify(catalog) };
            expect(() =>
                validateLocalAppChatRoutes(f.catalog, [f.installation], f.connections, [forged]),
            ).toThrow();
            expect(
                resolveLocalAppForChat(f.catalog, f.connections, [forged], "sample", "chat"),
            ).toBeUndefined();
        }
    });
    it("enforces route/account limits, exact fields and immutable legacy keys", async () => {
        const f = await scopedAppFixture();
        for (const [connections, routes] of [
            [null, []],
            [f.connections, null],
            [[...f.connections, ...f.connections], []],
            [[{ ...f.connections[0], extra: true }], []],
            [[{ ...f.connections[0], legacyChatKeys: ["chat", "chat"] }], []],
            [f.connections, [{ ...f.route("chat", 1), extra: true }]],
            [Array.from({ length: 17 }, () => f.connections[0]), []],
            [
                f.connections,
                Array.from({ length: 33 }, (_, n) => ({
                    ...f.route(`chat-${n}`, 1),
                    handle: `${n.toString().padStart(42, "A")}A`,
                })),
            ],
        ])
            expect(() =>
                validateLocalAppChatRoutes(f.catalog, [f.installation], connections, routes),
            ).toThrow();
        const keys = ["original"];
        const data = validateLocalAppChatRoutes(
            f.catalog,
            [f.installation],
            [{ appId: "sample", accountId: scopedAccountId, legacyChatKeys: keys }],
            [],
        );
        keys[0] = "changed";
        expect(data.connections[0].legacyChatKeys).toEqual(["original"]);
    });
    it("rejects getters without invoking them", async () => {
        const f = await scopedAppFixture();
        const getter = vi.fn();
        const route = { ...f.route("chat", 1) };
        Object.defineProperty(route, "catalogJson", { enumerable: true, get: getter });
        expect(() =>
            validateLocalAppChatRoutes(f.catalog, [f.installation], f.connections, [route]),
        ).toThrow();
        expect(getter).not.toHaveBeenCalled();
    });
});
