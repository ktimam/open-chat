import { describe, expect, it, vi } from "vitest";
import {
    LOCAL_APP_SCOPED_SETUP_MAX_BYTES,
    parseLocalAppSetupContext,
    parseLocalAppScopedSetupResult,
} from "./localAppScopedSetup";
const catalogJson = JSON.stringify({ version: 1, apps: [{ id: "sample" }] });
const handle = "A".repeat(43),
    accountId = "B".repeat(42) + "A",
    other = "C".repeat(42) + "A";
const account = () => ({
    version: 2,
    scope: "account",
    accountId,
    routes: [{ handle, catalogJson }],
});
const response = (scope = "account") => ({
    version: 2,
    scope,
    appId: "sample",
    accountId,
    catalogJson,
    routes: [{ handle, catalogJson }],
});
describe("strict scoped app setup", () => {
    it("snapshots only generic metadata and binds a complete account reconnect", () => {
        const input = account();
        const context = parseLocalAppSetupContext(input);
        input.routes[0].handle = other;
        const result = parseLocalAppScopedSetupResult(
            JSON.stringify(response()),
            "sample",
            context,
        );
        expect(result.routes[0].handle).toBe(handle);
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.isFrozen(result.routes)).toBe(true);
        expect(Object.isFrozen(result.routes[0])).toBe(true);
    });
    it("accepts first account connection without inventing chat routes", () => {
        const context = parseLocalAppSetupContext({ version: 2, scope: "account", routes: [] });
        expect(
            parseLocalAppScopedSetupResult(
                JSON.stringify({ ...response(), routes: [] }),
                "sample",
                context,
            ).accountId,
        ).toBe(accountId);
    });
    it("allows legacy configuration only in account scope", () => {
        expect(
            parseLocalAppSetupContext({ ...account(), legacyCatalogJson: catalogJson }),
        ).toMatchObject({ legacyCatalogJson: catalogJson });
        expect(() =>
            parseLocalAppSetupContext({
                version: 2,
                scope: "chat",
                accountId,
                handle,
                legacyCatalogJson: catalogJson,
            }),
        ).toThrow();
    });
    it("binds one chat handle and the established account", () => {
        const context = parseLocalAppSetupContext({ version: 2, scope: "chat", accountId, handle });
        expect(
            parseLocalAppScopedSetupResult(JSON.stringify(response("chat")), "sample", context)
                .scope,
        ).toBe("chat");
        expect(() =>
            parseLocalAppScopedSetupResult(JSON.stringify(response()), "sample", context),
        ).toThrow();
    });
    it.each([
        { version: 1 },
        { scope: "other" },
        { accountId: "bad" },
        { accountId: "B".repeat(43) },
        { accountId: null },
        { handle },
        { extra: true },
        { routes: null },
        {
            routes: [
                { handle, catalogJson },
                { handle, catalogJson },
            ],
        },
        { routes: [{ handle: "raw-chat-coordinates", catalogJson }] },
        { routes: [{ handle, catalogJson: "{}" }] },
        { routes: [{ handle, catalogJson, credential: "no" }] },
    ])("rejects malformed request metadata %j", (change) => {
        expect(() => parseLocalAppSetupContext({ ...account(), ...change })).toThrow();
    });
    it.each([
        { version: 1 },
        { scope: "chat" },
        { appId: "other" },
        { accountId: other },
        { extra: "no" },
        { routes: [] },
        { routes: [{ handle: other, catalogJson }] },
        {
            routes: [
                { handle, catalogJson },
                { handle: other, catalogJson },
            ],
        },
        {
            routes: [
                { handle, catalogJson },
                { handle, catalogJson },
            ],
        },
        { catalogJson: JSON.stringify({ version: 1, apps: [{ id: "other" }] }) },
        {
            routes: [
                { handle, catalogJson: JSON.stringify({ version: 1, apps: [{ id: "other" }] }) },
            ],
        },
    ])("rejects mismatched/partial response %j", (change) => {
        expect(() =>
            parseLocalAppScopedSetupResult(
                JSON.stringify({ ...response(), ...change }),
                "sample",
                parseLocalAppSetupContext(account()),
            ),
        ).toThrow();
    });
    it("rejects duplicate JSON keys, prototype fields, accessors and nonplain objects", () => {
        const text = JSON.stringify(response());
        const context = parseLocalAppSetupContext(account());
        expect(() =>
            parseLocalAppScopedSetupResult(text.replace("{", '{"version":2,'), "sample", context),
        ).toThrow();
        expect(() =>
            parseLocalAppScopedSetupResult(
                text.replace("{", '{"__proto__":{},'),
                "sample",
                context,
            ),
        ).toThrow();
        expect(() => parseLocalAppSetupContext(Object.create(account()))).toThrow();
        const getter = vi.fn(() => 2);
        expect(() =>
            parseLocalAppSetupContext(
                Object.defineProperty(account(), "version", { get: getter, enumerable: true }),
            ),
        ).toThrow();
        expect(getter).not.toHaveBeenCalled();
        const routeGetter = vi.fn(() => ({ handle, catalogJson }));
        const unsafe = account();
        Object.defineProperty(unsafe.routes, "0", { get: routeGetter, enumerable: true });
        expect(() => parseLocalAppSetupContext(unsafe)).toThrow();
        expect(routeGetter).not.toHaveBeenCalled();
    });
    it("checks request catalogs against the selected app before any transmission", () => {
        expect(() => parseLocalAppSetupContext(account(), "other")).toThrow();
        expect(() =>
            parseLocalAppSetupContext(
                { version: 2, scope: "chat", accountId, handle, catalogJson },
                "other",
            ),
        ).toThrow();
        expect(() =>
            parseLocalAppSetupContext(
                { version: 2, scope: "account", routes: [], legacyCatalogJson: catalogJson },
                "other",
            ),
        ).toThrow();
    });
    it("bounds both cumulative UTF-8 size and route count", () => {
        const makeRoutes = (count: number) =>
            Array.from({ length: count }, (_, i) => ({
                handle: i.toString().padStart(42, "0") + "A",
                catalogJson,
            }));
        expect(parseLocalAppSetupContext({ ...account(), routes: makeRoutes(32) })).toBeDefined();
        expect(() => parseLocalAppSetupContext({ ...account(), routes: makeRoutes(33) })).toThrow();
        const large = JSON.stringify({
            version: 1,
            apps: [{ id: "sample", text: "é".repeat(300000) }],
        });
        expect(() =>
            parseLocalAppSetupContext({
                ...account(),
                legacyCatalogJson: large,
                routes: [{ handle, catalogJson: large }],
            }),
        ).toThrow();
        expect(() =>
            parseLocalAppScopedSetupResult(
                " ".repeat(LOCAL_APP_SCOPED_SETUP_MAX_BYTES + 1),
                "sample",
                parseLocalAppSetupContext(account()),
            ),
        ).toThrow();
    });
});
