import { afterEach, describe, expect, it, vi } from "vitest";
import {
    BROWSER_INFERENCE_IMAGE_PREPARE_TIMEOUT_MS,
    prepareImageForBrowserInference,
} from "./inferenceImage";

function pngBytes(width: number, height: number): Uint8Array {
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    bytes.set([0x49, 0x48, 0x44, 0x52], 12);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, width);
    view.setUint32(20, height);
    return bytes;
}

function jpegBytes(width: number, height: number): Uint8Array {
    return new Uint8Array([
        0xff,
        0xd8,
        0xff,
        0xc0,
        0x00,
        0x11,
        0x08,
        height >> 8,
        height & 0xff,
        width >> 8,
        width & 0xff,
        0x03,
        0x01,
        0x11,
        0x00,
        0x02,
        0x11,
        0x00,
        0x03,
        0x11,
        0x00,
    ]);
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("prepareImageForBrowserInference", () => {
    it("passes an already-small image through without decoding or copying it", async () => {
        const bytes = jpegBytes(500, 400);
        const decode = vi.fn();

        await expect(
            prepareImageForBrowserInference(bytes, { width: 500, height: 400 }, decode),
        ).resolves.toBe(bytes);
        expect(decode).not.toHaveBeenCalled();
    });

    it("shrinks a large phone photo to the bounded inference pixel budget", async () => {
        const bytes = jpegBytes(4032, 3024);
        const decode = vi.fn().mockResolvedValue(new Uint8Array([9, 8, 7]));

        await expect(
            prepareImageForBrowserInference(bytes, { width: 4032, height: 3024 }, decode),
        ).resolves.toEqual(new Uint8Array([9, 8, 7]));
        expect(decode).toHaveBeenCalledOnce();
        expect(decode).toHaveBeenCalledWith(
            bytes,
            expect.objectContaining({
                width: 591,
                height: 443,
                mimeType: "image/jpeg",
                quality: 0.85,
                signal: expect.any(AbortSignal),
            }),
        );
    });

    it("also constrains a very wide image by the 768px long-edge limit", async () => {
        const bytes = jpegBytes(4000, 1000);
        const decode = vi.fn().mockResolvedValue(new Uint8Array([1]));

        await prepareImageForBrowserInference(bytes, { width: 4000, height: 1000 }, decode);

        expect(decode).toHaveBeenCalledWith(
            bytes,
            expect.objectContaining({
                width: 768,
                height: 192,
                mimeType: "image/jpeg",
                quality: 0.85,
                signal: expect.any(AbortSignal),
            }),
        );
    });

    it("uses intrinsic header dimensions and requests a bounded browser decode", async () => {
        const bytes = pngBytes(3000, 2000);
        const close = vi.fn();
        const bitmap = { width: 627, height: 418, close };
        const canvas = {
            width: 0,
            height: 0,
            getContext: vi.fn().mockReturnValue({ drawImage: vi.fn() }),
            toBlob: vi.fn((callback: (blob: Blob | null) => void) => {
                const encoded = new Blob([], { type: "image/jpeg" });
                Object.defineProperty(encoded, "arrayBuffer", {
                    value: async () => new Uint8Array([4, 5]).buffer,
                });
                callback(encoded);
            }),
        };
        vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
        vi.spyOn(document, "createElement").mockReturnValue(canvas as unknown as HTMLCanvasElement);

        await expect(prepareImageForBrowserInference(bytes)).resolves.toEqual(
            new Uint8Array([4, 5]),
        );
        expect(createImageBitmap).toHaveBeenCalledWith(expect.any(Blob), {
            resizeWidth: 627,
            resizeHeight: 418,
            resizeQuality: "high",
        });
        expect(canvas.width).toBe(627);
        expect(canvas.height).toBe(418);
        expect(close).toHaveBeenCalledOnce();
    });

    it("fails closed if browser decoding or encoding fails", async () => {
        const bytes = jpegBytes(4032, 3024);
        const decode = vi.fn().mockRejectedValue(new Error("unsupported image"));

        await expect(
            prepareImageForBrowserInference(bytes, { width: 4032, height: 3024 }, decode),
        ).rejects.toThrow(/safely prepared.*smaller image/i);
    });

    it("fails closed at the bounded deadline when browser image preparation never settles", async () => {
        const bytes = jpegBytes(4032, 3024);
        const decode = vi.fn().mockReturnValue(new Promise<Uint8Array>(() => undefined));
        vi.useFakeTimers();
        try {
            const pending = prepareImageForBrowserInference(
                bytes,
                { width: 4032, height: 3024 },
                decode,
            );
            const rejection = expect(pending).rejects.toThrow(/finish preparing.*in time/i);
            await vi.advanceTimersByTimeAsync(BROWSER_INFERENCE_IMAGE_PREPARE_TIMEOUT_MS);

            await rejection;
        } finally {
            vi.useRealTimers();
        }
    });

    it("closes a decoded bitmap that arrives after the preparation deadline", async () => {
        const bytes = pngBytes(3000, 2000);
        const close = vi.fn();
        let resolveBitmap!: (bitmap: ImageBitmap) => void;
        const bitmap = { width: 3000, height: 2000, close } as unknown as ImageBitmap;
        vi.stubGlobal(
            "createImageBitmap",
            vi.fn().mockReturnValue(
                new Promise<ImageBitmap>((resolve) => {
                    resolveBitmap = resolve;
                }),
            ),
        );
        vi.useFakeTimers();
        try {
            const pending = prepareImageForBrowserInference(bytes);
            const rejection = expect(pending).rejects.toThrow(/finish preparing.*in time/i);
            await vi.advanceTimersByTimeAsync(BROWSER_INFERENCE_IMAGE_PREPARE_TIMEOUT_MS);
            await rejection;

            resolveBitmap(bitmap);
            await Promise.resolve();
            await Promise.resolve();
            expect(close).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it("rejects unverifiable or dangerously oversized raster headers before decoding", async () => {
        const decode = vi.fn();
        await expect(
            prepareImageForBrowserInference(new Uint8Array([1, 2, 3]), undefined, decode),
        ).rejects.toThrow(/dimensions could not be verified/i);
        await expect(
            prepareImageForBrowserInference(pngBytes(9_000, 1_000), undefined, decode),
        ).rejects.toThrow(/too large.*safely/i);
        expect(decode).not.toHaveBeenCalled();
    });
});
