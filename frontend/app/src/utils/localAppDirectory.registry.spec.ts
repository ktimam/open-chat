// @vitest-environment node
import { Principal } from "@icp-sdk/core/principal";
import { describe, expect, it, vi } from "vitest";
import {
    loadLocalAppDirectory,
    parseLocalAppDirectory,
    publicLocalAppCatalog,
    sameLocalAppPublisher,
    validateLocalAppInstallation,
} from "./localAppDirectory";
import { decodeLocalAppSetup, encodeLocalAppSetup } from "./localAppSetupStore";
import { directoryFixture, directorySource } from "./localAppDirectory.testFixtures";

const registry = "https://registry.test/apps-v2.json";
const publisher = {
    principal: Principal.fromUint8Array(new Uint8Array([1, 2, 3, 2])).toText(),
    origin: "https://publisher.test",
};
const otherPrincipal = Principal.fromUint8Array(new Uint8Array([4, 5, 6, 2])).toText();
async function fixture(id = "sample") {
    const original = await directoryFixture(id);
    const descriptor = { ...original.descriptor, publisher };
    return { ...original, descriptor };
}
function page(apps: unknown[], index = 0, next: string | null = null, generation = "42") {
    return { version: 2, generation, page: index, apps, next };
}
const response = (value: unknown) => new Response(JSON.stringify(value));
const parse = (value: unknown, source = registry) =>
    parseLocalAppDirectory(JSON.stringify(value), source);

describe("independent publisher app registry", () => {
    it("accepts and freezes publisher-owned resources without relaxing v1 origin checks", async () => {
        const f = await fixture();
        const directory = parse(page([f.descriptor]));
        expect(directory).toEqual({ version: 2, generation: "42", apps: [f.descriptor] });
        expect(Object.isFrozen(directory.apps[0].publisher)).toBe(true);
        expect(Object.isFrozen(directory.apps)).toBe(true);
        expect(() => parse({ version: 1, apps: f.directory.apps })).toThrow();
        expect(() => parse({ version: 1, apps: [f.descriptor] }, directorySource)).toThrow();
        expect(publicLocalAppCatalog(f.catalogJson, directory.apps[0])).toEqual(f.pkg.catalog);
    });

    it.each(["2vxsx-fae", "aaaaa-aa", "", "not-a-principal", "aaaaa-aa ", "AAAAA-AA", "aaaaaaa"])(
        "rejects anonymous, malformed, or noncanonical publisher principal %s",
        async (principal) => {
            const f = await fixture();
            expect(() =>
                parse(page([{ ...f.descriptor, publisher: { ...publisher, principal } }])),
            ).toThrow();
        },
    );

    it.each([
        "https://publisher.test/",
        "https://publisher.test/path",
        "https://publisher.test?x=1",
        "https://publisher.test#fragment",
        "https://user:secret@publisher.test",
        "https://PUBLISHER.test",
        "https://publisher.test:443",
        "http://publisher.test",
        "http://localhost:3000",
        "https://localhost",
        "https://127.0.0.1",
        "https://[::1]",
        "https://publisher.test\u200b",
    ])("rejects noncanonical or unsafe publisher origin %s", async (origin) => {
        const f = await fixture();
        expect(() =>
            parse(page([{ ...f.descriptor, publisher: { ...publisher, origin } }])),
        ).toThrow();
    });

    it.each([
        "http://localhost:3000",
        "https://localhost:3000",
        "https://127.0.0.1",
        "https://[::1]",
    ])("permits a local publisher only with a loopback registry: %s", async (origin) => {
        const f = await fixture();
        const local = {
            ...f.descriptor,
            publisher: { ...publisher, origin },
            catalog: { ...f.descriptor.catalog, url: "/catalog.json" },
            processor: { ...f.descriptor.processor, url: "/processor.js" },
            setupUrl: "/connect",
        };
        for (const source of [
            "http://localhost:8000/apps-v2.json",
            "https://127.0.0.1/apps-v2.json",
        ]) {
            expect(parse(page([local]), source).apps[0].setupUrl).toBe(`${origin}/connect`);
        }
        expect(() => parse(page([local]))).toThrow();
    });

    it.each(["catalog", "processor", "setupUrl"])(
        "rejects %s outside the publisher origin",
        async (field) => {
            const f = await fixture();
            const changed =
                field === "setupUrl"
                    ? { ...f.descriptor, setupUrl: "https://other-publisher.test/connect" }
                    : {
                          ...f.descriptor,
                          [field]: {
                              ...f.descriptor.catalog,
                              url: "https://other-publisher.test/file",
                          },
                      };
            expect(() => parse(page([changed]))).toThrow();
        },
    );

    it("does not accept a public package that delivers to another publisher", async () => {
        const f = await fixture();
        const catalog = JSON.parse(f.catalogJson);
        catalog.apps[0].destination = "https://other-publisher.test/import";
        expect(() => publicLocalAppCatalog(JSON.stringify(catalog), f.descriptor)).toThrow();
    });

    it.each(["-1", "01", "1.0", "1e2", "18446744073709551616", 42, null])(
        "rejects a non-u64 generation %s",
        async (generation) => {
            expect(() => parse({ ...page([]), generation })).toThrow();
        },
    );

    it("loads all pages under the configured registry path before returning a snapshot", async () => {
        const first = await fixture("one");
        const second = await fixture("two");
        const source = "https://registry.test/discovery/apps-v2.json";
        const next = "/discovery/pages/42/1.json";
        const fetcher = vi.fn<typeof fetch>(async (url) =>
            response(
                String(url) === source
                    ? page([first.descriptor], 0, next)
                    : page([second.descriptor], 1),
            ),
        );
        const controller = new AbortController();
        const snapshot = await loadLocalAppDirectory(source, controller.signal, fetcher);
        expect(snapshot).toEqual({
            version: 2,
            generation: "42",
            apps: [first.descriptor, second.descriptor],
        });
        expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
            source,
            `https://registry.test${next}`,
        ]);
        expect(
            fetcher.mock.calls.every(
                ([, options]) =>
                    options?.credentials === "omit" &&
                    options?.redirect === "error" &&
                    options?.referrerPolicy === "no-referrer" &&
                    options?.cache === "no-store" &&
                    options?.signal === controller.signal,
            ),
        ).toBe(true);
        expect(() => parse(page([first.descriptor], 0, "/pages/42/1.json"))).toThrow();
    });

    it.each([
        "https://registry.test/pages/42/1.json",
        "https://evil.test/pages/42/1.json",
        "//evil.test/pages/42/1.json",
        "/pages/43/1.json",
        "/pages/42/2.json",
        "/pages/42/1.json?x=1",
        "/pages/42/1.json#hidden",
        "/pages/42/../42/1.json",
        "/pages/42/%31.json",
        "/pages/42/0.json",
        "/pages/42/01.json",
        "pages/42/1.json",
    ])("rejects an unapproved next-page location %s without fetching it", async (next) => {
        const fetcher = vi.fn<typeof fetch>(async () => response(page([], 0, next)));
        await expect(
            loadLocalAppDirectory(registry, new AbortController().signal, fetcher),
        ).rejects.toThrow();
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it.each([
        "generation",
        "page",
        "duplicate",
        "version",
        "unknown-field",
        "network",
        "redirect",
        "abort",
        "oversize",
    ])("rejects the entire snapshot on a subsequent-page %s failure", async (failure) => {
        const f = await fixture();
        const controller = new AbortController();
        const fetcher = vi.fn<typeof fetch>(async (_url) => {
            if (fetcher.mock.calls.length === 1)
                return response(page([f.descriptor], 0, "/pages/42/1.json"));
            if (failure === "network") throw new Error("offline");
            if (failure === "abort") controller.abort();
            if (failure === "oversize") return new Response(" ".repeat(128 * 1024 + 1));
            const value = page(
                failure === "duplicate" ? [f.descriptor] : [],
                failure === "page" ? 2 : 1,
                null,
                failure === "generation" ? "43" : "42",
            );
            const result = response({
                ...value,
                ...(failure === "version" ? { version: 1 } : {}),
                ...(failure === "unknown-field" ? { extra: true } : {}),
            });
            if (failure === "redirect")
                Object.defineProperty(result, "redirected", { value: true });
            return result;
        });
        await expect(loadLocalAppDirectory(registry, controller.signal, fetcher)).rejects.toThrow();
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("bounds the registry at 16 pages and 256 unique apps", async () => {
        const f = await fixture();
        const fetcher = vi.fn<typeof fetch>(async (): Promise<Response> => {
            const index = fetcher.mock.calls.length - 1;
            return response(
                page(
                    Array.from({ length: 16 }, (_, n) => ({
                        ...f.descriptor,
                        id: `app-${index * 16 + n}`,
                    })),
                    index,
                    index === 15 ? null : `/pages/42/${index + 1}.json`,
                ),
            );
        });
        expect(
            (await loadLocalAppDirectory(registry, new AbortController().signal, fetcher)).apps,
        ).toHaveLength(256);
        expect(fetcher).toHaveBeenCalledTimes(16);
        fetcher.mockReset().mockImplementation(async () => {
            const index = fetcher.mock.calls.length - 1;
            return response(page([], index, `/pages/42/${index + 1}.json`));
        });
        await expect(
            loadLocalAppDirectory(registry, new AbortController().signal, fetcher),
        ).rejects.toThrow();
        expect(fetcher).toHaveBeenCalledTimes(16);
        expect(() =>
            parse(
                page(Array.from({ length: 17 }, (_, n) => ({ ...f.descriptor, id: `app-${n}` }))),
            ),
        ).toThrow();
    });

    it("requires Connect for a changed registry, publisher, origin, or legacy-v1 provenance", async () => {
        const f = await fixture();
        const installation = {
            appId: "sample",
            sourceUrl: registry,
            descriptor: f.descriptor,
            publicCatalogJson: f.catalogJson,
        };
        expect(sameLocalAppPublisher(installation, f.descriptor, registry)).toBe(true);
        expect(
            sameLocalAppPublisher(
                installation,
                f.descriptor,
                "https://other-registry.test/apps-v2.json",
            ),
        ).toBe(false);
        expect(
            sameLocalAppPublisher(
                installation,
                { ...f.descriptor, publisher: { ...publisher, principal: otherPrincipal } },
                registry,
            ),
        ).toBe(false);
        expect(
            sameLocalAppPublisher(
                installation,
                {
                    ...f.descriptor,
                    publisher: { ...publisher, origin: "https://other-publisher.test" },
                },
                registry,
            ),
        ).toBe(false);
        const legacy = { ...installation, descriptor: { ...f.descriptor, publisher: undefined } };
        expect(sameLocalAppPublisher(legacy, f.descriptor, registry)).toBe(false);
        expect(sameLocalAppPublisher(installation, legacy.descriptor, registry)).toBe(false);
    });

    it("round-trips verified registry provenance without network requests or execution", async () => {
        const f = await fixture();
        const installation = {
            appId: "sample",
            sourceUrl: registry,
            descriptor: f.descriptor,
            publicCatalogJson: f.catalogJson,
        };
        await expect(
            validateLocalAppInstallation(installation, f.pkg.catalog.apps[0]),
        ).resolves.toEqual(installation);
        const scope = { account: "synthetic-account", backend: "https://backend.test|index" };
        const snapshot = {
            catalog: f.pkg.catalog,
            processors: [{ appId: "sample", artifact: f.processor }],
            installations: [installation],
            enabledChats: [{ chatKey: "chat", appIds: ["sample"] }],
        };
        const restored = await decodeLocalAppSetup(
            scope,
            await encodeLocalAppSetup(scope, snapshot),
        );
        expect(restored.installations).toEqual([installation]);
        expect(restored.enabledChats).toEqual(snapshot.enabledChats);
        await expect(
            validateLocalAppInstallation(
                {
                    ...installation,
                    descriptor: {
                        ...f.descriptor,
                        publisher: { ...publisher, principal: "2vxsx-fae" },
                    },
                },
                f.pkg.catalog.apps[0],
            ),
        ).rejects.toThrow();
        await expect(
            validateLocalAppInstallation(
                {
                    ...installation,
                    descriptor: {
                        ...f.descriptor,
                        publisher: { ...publisher, origin: "https://substitute.test" },
                    },
                },
                f.pkg.catalog.apps[0],
            ),
        ).rejects.toThrow();
    });
});
