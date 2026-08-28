import { afterEach, describe, expect, it, vi } from "vitest";
import {
    BROWSER_OCR_PREPARE_TIMEOUT_MS,
    browserOcrImageDimensions,
    intrinsicOcrImageDimensions,
    prepareImageForBrowserOcr,
    shouldThresholdMostlyWhiteUiScreenshot,
    thresholdOcrUiPixels,
} from "./ocrImage";
import type { OcrImageEnhancer, OcrImageResizer } from "./ocrImage";

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

const preserveNative: OcrImageEnhancer = async () => undefined;

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("prepareImageForBrowserOcr", () => {
    it("selects a sanitized mostly-white UI screenshot without using document text", () => {
        const pixels = new Uint8ClampedArray(100 * 4);
        for (let index = 0; index < 100; index++) {
            const offset = index * 4;
            const color = index < 92 ? [252, 252, 252] : index < 97 ? [70, 70, 70] : [230, 95, 30];
            pixels.set([...color, 255], offset);
        }

        expect(shouldThresholdMostlyWhiteUiScreenshot(pixels)).toBe(true);
    });

    it("leaves a shaded synthetic photograph outside the screenshot threshold gate", () => {
        const pixels = new Uint8ClampedArray(100 * 4);
        for (let index = 0; index < 100; index++) {
            const offset = index * 4;
            const shade = index < 45 ? 245 : index < 80 ? 190 : 80;
            pixels.set([shade, shade - 5, shade - 12, 255], offset);
        }

        expect(shouldThresholdMostlyWhiteUiScreenshot(pixels)).toBe(false);
    });

    it("turns qualifying UI pixels into bounded black-on-white OCR input", () => {
        const pixels = new Uint8ClampedArray([
            250, 250, 250, 255, 234, 234, 234, 255, 235, 235, 235, 255, 240, 90, 20, 255,
        ]);

        thresholdOcrUiPixels(pixels);

        expect([...pixels]).toEqual([
            255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255,
        ]);
    });

    it("uses a native-size screenshot enhancement without invoking the resize path", async () => {
        const bytes = pngBytes(900, 700);
        const enhanced = new Uint8Array([9, 8, 7]);
        const resize = vi.fn<OcrImageResizer>();
        const enhance = vi.fn<OcrImageEnhancer>().mockResolvedValue(enhanced);

        await expect(
            prepareImageForBrowserOcr(bytes, { width: 900, height: 700 }, resize, enhance),
        ).resolves.toBe(enhanced);
        expect(resize).not.toHaveBeenCalled();
        expect(enhance).toHaveBeenCalledWith(bytes, {
            width: 900,
            height: 700,
            signal: expect.any(AbortSignal),
        });
    });

    it("preserves native photo bytes when the screenshot enhancer declines them", async () => {
        const bytes = pngBytes(1200, 900);
        const resize = vi.fn<OcrImageResizer>();
        const enhance = vi.fn<OcrImageEnhancer>().mockResolvedValue(undefined);

        await expect(
            prepareImageForBrowserOcr(bytes, { width: 1200, height: 900 }, resize, enhance),
        ).resolves.toBe(bytes);
        expect(resize).not.toHaveBeenCalled();
    });

    it("runs the screenshot enhancer on resized bytes using the resized dimensions", async () => {
        const bytes = pngBytes(1080, 1748);
        const resized = jpegBytes(988, 1600);
        const enhanced = new Uint8Array([9, 8, 7]);
        const resize = vi.fn<OcrImageResizer>().mockResolvedValue(resized);
        const enhance = vi.fn<OcrImageEnhancer>().mockResolvedValue(enhanced);

        await expect(
            prepareImageForBrowserOcr(bytes, { width: 1080, height: 1748 }, resize, enhance),
        ).resolves.toBe(enhanced);
        expect(resize).toHaveBeenCalledWith(
            bytes,
            expect.objectContaining({ width: 988, height: 1600 }),
        );
        expect(enhance).toHaveBeenCalledWith(resized, {
            width: 988,
            height: 1600,
            signal: expect.any(AbortSignal),
        });
        expect(enhance.mock.calls[0][1].signal).toBe(resize.mock.calls[0][1].signal);
    });

    it.each([
        [900, 700],
        [1200, 900],
    ])(
        "preserves the validated %sx%s fixture resolution and exact bytes",
        async (width, height) => {
            const bytes = pngBytes(width, height);
            const resize = vi.fn();
            await expect(
                prepareImageForBrowserOcr(bytes, { width, height }, resize, preserveNative),
            ).resolves.toBe(bytes);
            expect(resize).not.toHaveBeenCalled();
        },
    );

    it("bounds a 12MP camera image while retaining receipt-text resolution", async () => {
        const bytes = pngBytes(4032, 3024);
        const resized = new Uint8Array([9, 8, 7]);
        const resize = vi.fn().mockResolvedValue(resized);

        await expect(
            prepareImageForBrowserOcr(bytes, { width: 4032, height: 3024 }, resize, preserveNative),
        ).resolves.toBe(resized);
        expect(resize).toHaveBeenCalledWith(bytes, {
            width: 1600,
            height: 1200,
            mimeType: "image/jpeg",
            quality: 0.9,
            signal: expect.any(AbortSignal),
        });
    });

    it("uses intrinsic dimensions instead of forged or stale chat metadata", async () => {
        const resize = vi.fn().mockResolvedValue(new Uint8Array([9]));
        await prepareImageForBrowserOcr(
            pngBytes(4032, 3024),
            { width: 900, height: 700 },
            resize,
            preserveNative,
        );
        expect(resize).toHaveBeenCalledWith(
            expect.any(Uint8Array),
            expect.objectContaining({ width: 1600, height: 1200 }),
        );

        const alreadyStored = pngBytes(1500, 1125);
        resize.mockClear();
        await expect(
            prepareImageForBrowserOcr(
                alreadyStored,
                { width: 4032, height: 3024 },
                resize,
                preserveNative,
            ),
        ).resolves.toBe(alreadyStored);
        expect(resize).not.toHaveBeenCalled();
    });

    it("reads common raster headers without decoding their pixels", () => {
        expect(intrinsicOcrImageDimensions(pngBytes(900, 700))).toEqual({
            width: 900,
            height: 700,
        });
        expect(intrinsicOcrImageDimensions(jpegBytes(1200, 900))).toEqual({
            width: 1200,
            height: 900,
        });
    });

    it("keeps both dimensions under the pixel and long-edge bounds", () => {
        expect(browserOcrImageDimensions({ width: 6000, height: 1000 })).toEqual({
            width: 1600,
            height: 266,
        });
        expect(browserOcrImageDimensions({ width: 2000, height: 2000 })).toEqual({
            width: 1414,
            height: 1414,
        });
    });

    it("does not require sender metadata when intrinsic dimensions are verifiable", async () => {
        const bytes = pngBytes(900, 700);
        await expect(
            prepareImageForBrowserOcr(bytes, undefined, vi.fn(), preserveNative),
        ).resolves.toBe(bytes);
    });

    it("fails closed when encoded dimensions cannot be verified or exceed safe source bounds", async () => {
        await expect(
            prepareImageForBrowserOcr(new Uint8Array([1, 2, 3]), { width: 900, height: 700 }),
        ).rejects.toThrow("Image dimensions could not be verified.");
        await expect(
            prepareImageForBrowserOcr(pngBytes(8192, 8192), { width: 900, height: 700 }),
        ).rejects.toThrow("Image dimensions exceed the safe local-reading limit.");
    });

    it("fails closed if an oversized image cannot be resized", async () => {
        const bytes = pngBytes(4032, 3024);
        const resize = vi.fn().mockRejectedValue(new Error("unsupported"));
        await expect(
            prepareImageForBrowserOcr(bytes, { width: 4032, height: 3024 }, resize),
        ).rejects.toThrow("unsupported");
    });

    it("settles a stalled decoder/encoder instead of displaying Reading image forever", async () => {
        vi.useFakeTimers();
        const bytes = pngBytes(4032, 3024);
        const resize = vi.fn<OcrImageResizer>(
            (_bytes, _request) => new Promise<Uint8Array>(() => undefined),
        );
        const pending = prepareImageForBrowserOcr(bytes, { width: 4032, height: 3024 }, resize);
        const assertion = expect(pending).rejects.toThrow("Image preparation timed out.");

        await vi.advanceTimersByTimeAsync(BROWSER_OCR_PREPARE_TIMEOUT_MS);
        await assertion;
        expect(resize.mock.calls[0][1].signal.aborted).toBe(true);
    });

    it("uses decoder-side resize options and closes the bitmap on the production path", async () => {
        const close = vi.fn();
        const drawImage = vi.fn();
        const bitmap = { close } as unknown as ImageBitmap;
        const createImageBitmapMock = vi.fn().mockResolvedValue(bitmap);
        vi.stubGlobal("createImageBitmap", createImageBitmapMock);
        vi.spyOn(document, "createElement").mockReturnValue({
            width: 0,
            height: 0,
            getContext: () => ({ drawImage }),
            toBlob: (callback: BlobCallback) =>
                callback({
                    arrayBuffer: async () => new Uint8Array([9, 8, 7]).buffer,
                } as Blob),
        } as unknown as HTMLCanvasElement);

        await expect(
            prepareImageForBrowserOcr(
                pngBytes(4032, 3024),
                { width: 4032, height: 3024 },
                undefined,
                preserveNative,
            ),
        ).resolves.toEqual(new Uint8Array([9, 8, 7]));
        expect(createImageBitmapMock).toHaveBeenCalledWith(expect.any(Blob), {
            resizeWidth: 1600,
            resizeHeight: 1200,
            resizeQuality: "high",
        });
        expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 1600, 1200);
        expect(close).toHaveBeenCalledOnce();
    });
});
