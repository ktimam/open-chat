import type { BlobReference } from "@client";
import { describe, expect, it, vi } from "vitest";
import {
    MAX_PUBLIC_IMAGE_DISPLAY_BYTES,
    PublicImageObjectUrlResolver,
    publicImageDisplayUrl,
    shouldProxyLocalPublicImage,
} from "./publicImageDisplay";

const REF: BlobReference = {
    canisterId: "ucwa4-rx777-77774-qaada-cai",
    blobId: 55n,
};

function urlApi() {
    return {
        createObjectURL: vi.fn((_blob: Blob): string => "blob:worker-image"),
        revokeObjectURL: vi.fn((_url: string): void => undefined),
    };
}

describe("PublicImageObjectUrlResolver", () => {
    it("downloads a bounded public blob and exposes it as an image object URL", async () => {
        const bytes = new Uint8Array([11, 12, 13]);
        const loader = vi.fn(async () => bytes);
        const urls = urlApi();
        const resolver = new PublicImageObjectUrlResolver(loader, urls);

        await expect(resolver.resolve(REF, "image/png")).resolves.toBe("blob:worker-image");

        expect(loader).toHaveBeenCalledWith(REF, MAX_PUBLIC_IMAGE_DISPLAY_BYTES);
        expect(urls.createObjectURL).toHaveBeenCalledOnce();
        const blob = urls.createObjectURL.mock.calls[0][0];
        expect(blob.type).toBe("image/png");
        expect(blob.size).toBe(bytes.byteLength);
    });

    it("shares one in-flight download for the same image", async () => {
        let finish!: (bytes: Uint8Array) => void;
        const loader = vi.fn(
            () =>
                new Promise<Uint8Array>((resolve) => {
                    finish = resolve;
                }),
        );
        const resolver = new PublicImageObjectUrlResolver(loader, urlApi());

        const first = resolver.resolve(REF, "image/jpeg");
        const second = resolver.resolve(REF, "image/jpeg");
        finish(new Uint8Array([1]));

        await expect(first).resolves.toBe("blob:worker-image");
        await expect(second).resolves.toBe("blob:worker-image");
        expect(loader).toHaveBeenCalledOnce();
    });

    it("revokes the old object URL when the image changes or the component is disposed", async () => {
        const urls = urlApi();
        const resolver = new PublicImageObjectUrlResolver(
            vi.fn(async () => new Uint8Array([1])),
            urls,
        );

        await resolver.resolve(REF, "image/webp");
        resolver.clear();

        expect(urls.revokeObjectURL).toHaveBeenCalledWith("blob:worker-image");
        expect(urls.revokeObjectURL).toHaveBeenCalledOnce();
    });

    it("does not create an object URL when an obsolete download finishes", async () => {
        let finish!: (bytes: Uint8Array) => void;
        const urls = urlApi();
        const resolver = new PublicImageObjectUrlResolver(
            () =>
                new Promise<Uint8Array>((resolve) => {
                    finish = resolve;
                }),
            urls,
        );

        const pending = resolver.resolve(REF, "image/png");
        resolver.clear();
        finish(new Uint8Array([1, 2]));

        await expect(pending).resolves.toBeUndefined();
        expect(urls.createObjectURL).not.toHaveBeenCalled();
    });

    it("rejects empty, oversized, and non-image responses", async () => {
        const empty = new PublicImageObjectUrlResolver(async () => new Uint8Array(), urlApi());
        await expect(empty.resolve(REF, "image/png")).resolves.toBeUndefined();

        const oversized = new PublicImageObjectUrlResolver(
            async () => new Uint8Array(MAX_PUBLIC_IMAGE_DISPLAY_BYTES + 1),
            urlApi(),
        );
        await expect(oversized.resolve(REF, "image/png")).resolves.toBeUndefined();

        const unsafeUrls = urlApi();
        const unsafe = new PublicImageObjectUrlResolver(
            async () => new Uint8Array([1]),
            unsafeUrls,
        );
        await expect(unsafe.resolve(REF, "text/html")).resolves.toBeUndefined();
        expect(unsafeUrls.createObjectURL).not.toHaveBeenCalled();
    });
});

describe("shouldProxyLocalPublicImage", () => {
    const localBlobUrl = `http://${REF.canisterId}.raw.localhost:8080/blobs/${REF.blobId}`;

    it("recognises the local PocketIC blob URL that a remote HTTPS phone cannot reach", () => {
        expect(
            shouldProxyLocalPublicImage(localBlobUrl, REF, {
                protocol: "https:",
                hostname: "openchat-dev.example.ts.net",
            }),
        ).toBe(true);
    });

    it("keeps the direct URL on the local PC and on normal production blob hosts", () => {
        expect(
            shouldProxyLocalPublicImage(localBlobUrl, REF, {
                protocol: "http:",
                hostname: "localhost",
            }),
        ).toBe(false);
        expect(
            shouldProxyLocalPublicImage("https://storage.example/blobs/55", REF, {
                protocol: "https:",
                hostname: "chat.example",
            }),
        ).toBe(false);
    });

    it("does not redirect a URL whose canister or blob id does not match the message reference", () => {
        expect(
            shouldProxyLocalPublicImage(
                `http://${REF.canisterId}.raw.localhost:8080/blobs/56`,
                REF,
                { protocol: "https:", hostname: "openchat-dev.example.ts.net" },
            ),
        ).toBe(false);
    });
});

describe("publicImageDisplayUrl", () => {
    const localBlobUrl = `http://${REF.canisterId}.raw.localhost:8080/blobs/${REF.blobId}`;

    it("uses a same-origin proxy path for the exact local blob on remote HTTPS", () => {
        expect(
            publicImageDisplayUrl(localBlobUrl, REF, {
                protocol: "https:",
                hostname: "openchat-dev.example.ts.net",
            }),
        ).toBe(`/__oc-local-image/${REF.canisterId}/blobs/${REF.blobId}`);
    });

    it("leaves loopback and production image URLs unchanged", () => {
        expect(
            publicImageDisplayUrl(localBlobUrl, REF, {
                protocol: "http:",
                hostname: "localhost",
            }),
        ).toBe(localBlobUrl);

        const production = "https://storage.example/blobs/55";
        expect(
            publicImageDisplayUrl(production, REF, {
                protocol: "https:",
                hostname: "chat.example",
            }),
        ).toBe(production);
    });
});
