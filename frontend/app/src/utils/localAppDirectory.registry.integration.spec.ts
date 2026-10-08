// @vitest-environment node
import { Principal } from "@icp-sdk/core/principal";
import { describe, expect, it, vi } from "vitest";
import { loadLocalAppDirectory, loadLocalAppPublicPackage } from "./localAppDirectory";
import * as isolatedProcessor from "./isolatedAppProcessor";

const config = {
    url: process.env.OC_REGISTRY_TEST_URL,
    appId: process.env.OC_REGISTRY_TEST_APP_ID,
    publisher: process.env.OC_REGISTRY_TEST_PUBLISHER,
};
// An incomplete opt-in must fail, not quietly skip a supposedly enabled integration run.
const enabled = Object.values(config).some((value) => value !== undefined);

function loopbackHttp(value: string): string {
    const url = new URL(value);
    if (
        url.href !== value ||
        url.protocol !== "http:" ||
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
    )
        throw new Error("Registry integration tests require canonical HTTP loopback URLs");
    return url.href;
}

describe("live standalone app registry (explicit local opt-in)", () => {
    it.skipIf(!enabled)(
        "verifies a published package through the real directory and integrity loaders without executing it",
        async () => {
            if (!config.url || !config.appId || !config.publisher) {
                throw new Error(
                    "Set OC_REGISTRY_TEST_URL, OC_REGISTRY_TEST_APP_ID and OC_REGISTRY_TEST_PUBLISHER together",
                );
            }
            const source = loopbackHttp(config.url);
            expect(config.appId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/);
            const identity = Principal.fromText(config.publisher);
            expect(identity.toText()).toBe(config.publisher);
            expect(identity.isAnonymous()).toBe(false);
            expect(identity.toText()).not.toBe("aaaaa-aa");
            // This spy delegates to the real function if called. No parser, integrity check,
            // fetch implementation or processor implementation is replaced by the test.
            const execution = vi.spyOn(isolatedProcessor, "runIsolatedAppProcessor");
            try {
                const signal = AbortSignal.timeout(30_000);
                const directory = await loadLocalAppDirectory(source, signal);
                expect(directory.version).toBe(2);
                const descriptor = directory.apps.find((entry) => entry.id === config.appId);
                expect(
                    descriptor,
                    "The requested published app is absent from the complete registry snapshot",
                ).toBeDefined();
                expect(descriptor!.publisher?.principal).toBe(config.publisher);
                // The opt-in exercises only local staging servers, even if another listing
                // in the registry advertises a public publisher.
                loopbackHttp(descriptor!.catalog.url);
                loopbackHttp(descriptor!.processor.url);
                expect(new URL(descriptor!.catalog.url).origin).toBe(descriptor!.publisher!.origin);
                expect(new URL(descriptor!.processor.url).origin).toBe(
                    descriptor!.publisher!.origin,
                );
                const pkg = await loadLocalAppPublicPackage(descriptor!, signal);
                expect(pkg.catalog.apps).toHaveLength(1);
                expect(pkg.catalog.apps[0]).toMatchObject({
                    id: descriptor!.id,
                    revision: descriptor!.revision,
                    name: descriptor!.name,
                    description: descriptor!.description,
                    processor: {
                        sha256: descriptor!.processor.sha256,
                        byteLength: descriptor!.processor.byteLength,
                    },
                });
                expect(new URL(pkg.catalog.apps[0].destination).origin).toBe(
                    descriptor!.publisher!.origin,
                );
                expect(new TextEncoder().encode(pkg.catalogJson).byteLength).toBe(
                    descriptor!.catalog.byteLength,
                );
                expect(new TextEncoder().encode(pkg.processor.source).byteLength).toBe(
                    descriptor!.processor.byteLength,
                );
                expect(pkg.processor.sha256).toBe(descriptor!.processor.sha256);
                expect(execution).not.toHaveBeenCalled();
                // Discovery/package verification does not prove account connection,
                // authentication, proposal accuracy, delivery, or a saved app entry.
            } finally {
                execution.mockRestore();
            }
        },
        35_000,
    );
});
