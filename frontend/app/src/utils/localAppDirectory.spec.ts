// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
    bindConnectedLocalApp,
    loadLocalAppDirectory,
    loadLocalAppPublicPackage,
    parseLocalAppDirectory,
    publicLocalAppCatalog,
    validateLocalAppInstallation,
    localAppHasPrivateSetup,
} from "./localAppDirectory";
import { directoryFixture, directorySource } from "./localAppDirectory.testFixtures";

type DirectoryJson = {
    version: number;
    apps: { name: string; processor: { byteLength: number }; [key: string]: unknown }[];
};
type CatalogJson = {
    apps: {
        destination: string;
        processor: { sha256: string };
        actions: { definition: { promptTemplate: string } }[];
    }[];
};

describe("generic public app directory", () => {
    it("resolves same-origin resources, freezes declarations, and fetches no credentials or referrer", async () => {
        const fixture = await directoryFixture();
        const fetcher = vi.fn<typeof fetch>(async () => new Response(fixture.directoryJson));
        const controller = new AbortController();
        const directory = await loadLocalAppDirectory(directorySource, controller.signal, fetcher);
        expect(directory.apps[0].setupUrl).toBe("https://publisher.test/connect/sample");
        expect(Object.isFrozen(directory.apps[0].processor)).toBe(true);
        expect(fetcher).toHaveBeenCalledExactlyOnceWith(directorySource, {
            credentials: "omit",
            redirect: "error",
            referrerPolicy: "no-referrer",
            cache: "no-store",
            signal: controller.signal,
        });
    });
    it.each([
        "https://evil.test/catalog.json",
        "https://user:secret@publisher.test/catalog.json",
        "/catalog.json#hidden",
        "/catalog.json?token=x",
        "javascript:alert(1)",
    ])("rejects unsafe resource %s", async (url) => {
        const fixture = await directoryFixture();
        const value = JSON.parse(fixture.directoryJson);
        value.apps[0].catalog.url = url;
        expect(() => parseLocalAppDirectory(JSON.stringify(value), directorySource)).toThrow();
    });
    it("rejects duplicate apps, hidden labels, extra fields, unsupported versions and oversized files", async () => {
        const fixture = await directoryFixture();
        for (const mutate of [
            (value: DirectoryJson) => value.apps.push(value.apps[0]),
            (value: DirectoryJson) => (value.apps[0].name = "Safe\u202eevil"),
            (value: DirectoryJson) => (value.apps[0].token = "not allowed"),
            (value: DirectoryJson) => (value.version = 2),
            (value: DirectoryJson) => (value.apps[0].processor.byteLength = 1024 * 1024 + 1),
        ]) {
            const value = JSON.parse(fixture.directoryJson);
            mutate(value);
            expect(() => parseLocalAppDirectory(JSON.stringify(value), directorySource)).toThrow();
        }
    });
    it("verifies exact public recipe and processor bytes without executing code", async () => {
        const fixture = await directoryFixture();
        const fetcher = vi.fn<typeof fetch>(
            async (url) =>
                new Response(String(url).endsWith(".json") ? fixture.catalogJson : fixture.source),
        );
        const result = await loadLocalAppPublicPackage(
            fixture.descriptor,
            new AbortController().signal,
            fetcher,
        );
        expect(result.processor).toEqual(fixture.processor);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it.each(["hash", "size", "redirect", "oversize", "utf8"])(
        "rejects %s failures before installing",
        async (failure) => {
            const fixture = await directoryFixture();
            const fetcher = vi.fn<typeof fetch>(async () => {
                if (failure === "redirect") {
                    const response = new Response(fixture.catalogJson);
                    Object.defineProperty(response, "redirected", { value: true });
                    return response;
                }
                return new Response(
                    failure === "hash"
                        ? "x".repeat(fixture.descriptor.catalog.byteLength)
                        : failure === "size"
                          ? "x"
                          : failure === "utf8"
                            ? new Uint8Array([255])
                            : "x".repeat(fixture.descriptor.catalog.byteLength + 1),
                );
            });
            await expect(
                loadLocalAppPublicPackage(
                    fixture.descriptor,
                    new AbortController().signal,
                    fetcher,
                ),
            ).rejects.toThrow();
            expect(fetcher).toHaveBeenCalledTimes(1);
        },
    );
    it("bounds streaming bodies even without content-length", async () => {
        let cancelled = false;
        const fetcher = vi.fn<typeof fetch>(
            async () =>
                new Response(
                    new ReadableStream({
                        pull(controller) {
                            controller.enqueue(new Uint8Array(128 * 1024 + 1));
                        },
                        cancel() {
                            cancelled = true;
                        },
                    }),
                ),
        );
        await expect(
            loadLocalAppDirectory(directorySource, new AbortController().signal, fetcher),
        ).rejects.toThrow();
        expect(cancelled).toBe(true);
    });
    it("rejects public private-context leaks and binds private connection to immutable recipe", async () => {
        const fixture = await directoryFixture("sample", "1", true);
        expect(() => publicLocalAppCatalog(fixture.connectedJson, fixture.descriptor)).toThrow();
        const app = bindConnectedLocalApp(fixture.connectedJson, fixture.pkg.catalog);
        expect(app.actions[0].processorContext).toEqual({ privateLabels: ["Private choice"] });
        expect(localAppHasPrivateSetup(app, fixture.catalogJson)).toBe(true);
        expect(localAppHasPrivateSetup(fixture.pkg.catalog.apps[0], fixture.catalogJson)).toBe(
            false,
        );
        for (const mutate of [
            (value: CatalogJson) => (value.apps[0].destination = "https://elsewhere.test/import"),
            (value: CatalogJson) =>
                (value.apps[0].actions[0].definition.promptTemplate = "Changed prompt"),
            (value: CatalogJson) => (value.apps[0].processor.sha256 = "0".repeat(64)),
            (value: CatalogJson) => value.apps.push(value.apps[0]),
        ]) {
            const value = JSON.parse(fixture.connectedJson);
            mutate(value);
            expect(() =>
                bindConnectedLocalApp(JSON.stringify(value), fixture.pkg.catalog),
            ).toThrow();
        }
        await expect(
            validateLocalAppInstallation(
                {
                    appId: app.id,
                    sourceUrl: directorySource,
                    descriptor: fixture.descriptor,
                    publicCatalogJson: fixture.catalogJson,
                },
                app,
            ),
        ).resolves.toMatchObject({ appId: app.id });
    });
    it("stops an already-aborted load without accepting a package", async () => {
        const fixture = await directoryFixture();
        const controller = new AbortController();
        controller.abort();
        const fetcher = vi.fn<typeof fetch>(async () => new Response(fixture.directoryJson));
        await expect(
            loadLocalAppDirectory(directorySource, controller.signal, fetcher),
        ).rejects.toThrow();
    });
});
