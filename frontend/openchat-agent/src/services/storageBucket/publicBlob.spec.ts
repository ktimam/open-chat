import { HttpAgent } from "@icp-sdk/core/agent";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { describe, expect, it, vi } from "vitest";
import {
    MAX_PUBLIC_BLOB_QUERIES,
    MAX_PUBLIC_IMAGE_BYTES,
    PUBLIC_BLOB_CHUNK_BYTES,
    createAnonymousPublicBlobAgent,
    downloadPublicImageBlob,
    type PublicBlobHttpRequest,
    type PublicBlobHttpResponse,
} from "./publicBlob";

const PNG_MIME = "image/png";

function response(
    body: Uint8Array,
    start: number,
    total: number,
    mimeType = PNG_MIME,
): PublicBlobHttpResponse {
    return {
        status_code: 206,
        body,
        headers: [
            ["Content-Type", mimeType],
            ["Content-Length", body.byteLength.toString()],
            ["Content-Range", `bytes ${start}-${start + body.byteLength - 1}/${total}`],
        ],
        upgrade: [],
    };
}

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

describe("downloadPublicImageBlob", () => {
    it("reads a public image in bounded Range queries", async () => {
        const total = PUBLIC_BLOB_CHUNK_BYTES + 3;
        const first = new Uint8Array(PUBLIC_BLOB_CHUNK_BYTES);
        first.set(PNG_BYTES);
        const second = new Uint8Array([8, 9, 10]);
        const query = vi
            .fn<(request: PublicBlobHttpRequest) => Promise<PublicBlobHttpResponse>>()
            .mockResolvedValueOnce(response(first, 0, total))
            .mockResolvedValueOnce(response(second, first.byteLength, total));

        const bytes = await downloadPublicImageBlob(42n, total, query);

        expect(bytes).toHaveLength(total);
        expect(bytes?.slice(-3)).toEqual(second);
        expect(query).toHaveBeenNthCalledWith(1, {
            url: "/blobs/42",
            method: "GET",
            body: new Uint8Array(),
            headers: [["Range", `bytes=0-${PUBLIC_BLOB_CHUNK_BYTES}`]],
        });
        expect(query).toHaveBeenNthCalledWith(2, {
            url: "/blobs/42",
            method: "GET",
            body: new Uint8Array(),
            headers: [["Range", `bytes=${PUBLIC_BLOB_CHUNK_BYTES}-${PUBLIC_BLOB_CHUNK_BYTES * 2}`]],
        });
    });

    it("rejects a blob before allocation when the declared total exceeds the caller cap", async () => {
        const query = vi.fn(async () => response(PNG_BYTES, 0, MAX_PUBLIC_IMAGE_BYTES + 1));

        await expect(
            downloadPublicImageBlob(1n, MAX_PUBLIC_IMAGE_BYTES, query),
        ).resolves.toBeUndefined();
        expect(query).toHaveBeenCalledTimes(1);
    });

    it("rejects undersized non-final chunks instead of making attacker-sized query loops", async () => {
        expect(MAX_PUBLIC_BLOB_QUERIES).toBe(4);
        const query = vi.fn(async () => response(PNG_BYTES, 0, MAX_PUBLIC_IMAGE_BYTES));

        await expect(
            downloadPublicImageBlob(1n, MAX_PUBLIC_IMAGE_BYTES, query),
        ).resolves.toBeUndefined();
        expect(query).toHaveBeenCalledTimes(1);
    });

    it("rejects non-raster MIME types", async () => {
        const query = vi.fn(async () =>
            response(PNG_BYTES, 0, PNG_BYTES.byteLength, "image/svg+xml"),
        );

        await expect(downloadPublicImageBlob(1n, 1024, query)).resolves.toBeUndefined();
    });

    it("rejects malformed or discontinuous Content-Range responses", async () => {
        const query = vi.fn(
            async (): Promise<PublicBlobHttpResponse> => ({
                ...response(PNG_BYTES, 0, PNG_BYTES.byteLength),
                headers: [
                    ["Content-Type", PNG_MIME],
                    ["Content-Length", PNG_BYTES.byteLength.toString()],
                    ["Content-Range", `bytes 1-${PNG_BYTES.byteLength}/${PNG_BYTES.byteLength}`],
                ],
            }),
        );

        await expect(downloadPublicImageBlob(1n, 1024, query)).resolves.toBeUndefined();
    });

    it("rejects invalid caller caps without making a query", async () => {
        const query = vi.fn(async () => response(PNG_BYTES, 0, PNG_BYTES.byteLength));

        await expect(downloadPublicImageBlob(1n, 0, query)).resolves.toBeUndefined();
        await expect(
            downloadPublicImageBlob(1n, MAX_PUBLIC_IMAGE_BYTES + 1, query),
        ).resolves.toBeUndefined();
        expect(query).not.toHaveBeenCalled();
    });

    it("rejects sender-controlled MIME metadata that does not match the file signature", async () => {
        const query = vi.fn(async () => response(new Uint8Array(16).fill(1), 0, 16));

        await expect(downloadPublicImageBlob(1n, 1024, query)).resolves.toBeUndefined();
    });

    it("uses an anonymous no-retry agent for sender-selected public canisters", async () => {
        const source = HttpAgent.createSync({
            host: "http://127.0.0.1:4943",
            identity: Ed25519KeyIdentity.generate(new Uint8Array(32).fill(7)),
            verifyQuerySignatures: false,
        });
        const publicAgent = createAnonymousPublicBlobAgent(source);

        expect((await source.getPrincipal()).toText()).not.toBe("2vxsx-fae");
        expect((await publicAgent.getPrincipal()).toText()).toBe("2vxsx-fae");
        expect(publicAgent.config.retryTimes).toBe(0);
    });
});
