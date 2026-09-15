import type { InferenceImageRegion } from "@shared";
import { intrinsicImageDimensions } from "./imageDimensions";

const MAX_INFERENCE_IMAGE_PIXELS = 256 * 1024;
const MAX_INFERENCE_IMAGE_EDGE = 768;
const MAX_INFERENCE_SOURCE_PIXELS = 40_000_000;
const MAX_INFERENCE_SOURCE_EDGE = 8_192;
const INFERENCE_JPEG_QUALITY = 0.85;
// Decode ordinary receipt bands at their cropped source resolution, then let the canvas perform the
// one resize. Chromium's crop+decode-resize overload visibly discarded thin date glyphs on Android
// (the same 909x352 band changed `14 Aug 2026` into `14 Aug`). Keep a hard bitmap ceiling so an
// adversarial maximum-size source cannot force a phone to materialize a huge RGBA crop.
const MAX_HIGH_QUALITY_REGION_BITMAP_PIXELS = 4 * 1024 * 1024;
export const BROWSER_INFERENCE_IMAGE_PREPARE_TIMEOUT_MS = 15_000;

export type ImageDimensions = { width: number; height: number };

type ResizeRequest = ImageDimensions & {
    mimeType: "image/jpeg";
    quality: number;
    signal: AbortSignal;
};

export type InferenceImageResizer = (
    bytes: Uint8Array,
    request: ResizeRequest,
) => Promise<Uint8Array>;

type RegionCropRequest = ResizeRequest & {
    sourceX: number;
    sourceY: number;
    sourceWidth: number;
    sourceHeight: number;
};

export type InferenceImageRegionCropper = (
    bytes: Uint8Array,
    request: RegionCropRequest,
) => Promise<Uint8Array>;

function validDimensions(dimensions: ImageDimensions | undefined): dimensions is ImageDimensions {
    return (
        dimensions !== undefined &&
        Number.isFinite(dimensions.width) &&
        Number.isFinite(dimensions.height) &&
        dimensions.width > 0 &&
        dimensions.height > 0
    );
}

function sourceDimensionsWithinBounds(dimensions: ImageDimensions): boolean {
    return (
        validDimensions(dimensions) &&
        dimensions.width <= MAX_INFERENCE_SOURCE_EDGE &&
        dimensions.height <= MAX_INFERENCE_SOURCE_EDGE &&
        dimensions.width * dimensions.height <= MAX_INFERENCE_SOURCE_PIXELS
    );
}

export function inferenceImageDimensions(dimensions: ImageDimensions): ImageDimensions {
    const pixelScale = Math.sqrt(
        MAX_INFERENCE_IMAGE_PIXELS / (dimensions.width * dimensions.height),
    );
    const edgeScale = MAX_INFERENCE_IMAGE_EDGE / Math.max(dimensions.width, dimensions.height);
    const scale = Math.min(1, pixelScale, edgeScale);
    return {
        width: Math.max(1, Math.floor(dimensions.width * scale)),
        height: Math.max(1, Math.floor(dimensions.height * scale)),
    };
}

function needsResize(dimensions: ImageDimensions): boolean {
    return (
        dimensions.width * dimensions.height > MAX_INFERENCE_IMAGE_PIXELS ||
        Math.max(dimensions.width, dimensions.height) > MAX_INFERENCE_IMAGE_EDGE
    );
}

function cancelled(): Error {
    return new Error("Image preparation was cancelled.");
}

function awaitAbortable<T>(
    operation: Promise<T>,
    signal: AbortSignal,
    releaseLate?: (value: T) => void,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const onAbort = (): void => {
            if (settled) return;
            settled = true;
            reject(cancelled());
        };
        if (signal.aborted) {
            settled = true;
            reject(cancelled());
        } else {
            signal.addEventListener("abort", onAbort, { once: true });
        }
        void operation.then(
            (value) => {
                if (settled) {
                    releaseLate?.(value);
                    return;
                }
                settled = true;
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            (error) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener("abort", onAbort);
                reject(error);
            },
        );
    });
}

async function encodeCanvas(
    canvas: HTMLCanvasElement,
    request: ResizeRequest,
): Promise<Uint8Array> {
    if (request.signal.aborted) throw cancelled();
    const blob = await new Promise<Blob>((resolve, reject) => {
        let settled = false;
        const onAbort = (): void => {
            if (settled) return;
            settled = true;
            reject(cancelled());
        };
        request.signal.addEventListener("abort", onAbort, { once: true });
        canvas.toBlob(
            (result) => {
                if (settled) return;
                settled = true;
                request.signal.removeEventListener("abort", onAbort);
                if (result === null) {
                    reject(new Error("image encoding failed"));
                } else {
                    resolve(result);
                }
            },
            request.mimeType,
            request.quality,
        );
    });
    const buffer = await awaitAbortable(blob.arrayBuffer(), request.signal);
    const encoded = new Uint8Array(buffer);
    if (encoded.byteLength === 0) throw new Error("image encoding returned no data");
    return encoded;
}

async function encodeBitmap(bitmap: ImageBitmap, request: ResizeRequest): Promise<Uint8Array> {
    if (request.signal.aborted) throw cancelled();
    const canvas = document.createElement("canvas");
    canvas.width = request.width;
    canvas.height = request.height;
    const context = canvas.getContext("2d", { alpha: false });
    if (context === null) throw new Error("canvas 2d context unavailable");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, request.width, request.height);
    return encodeCanvas(canvas, request);
}

async function canvasResize(bytes: Uint8Array, request: ResizeRequest): Promise<Uint8Array> {
    const bitmap = await awaitAbortable(
        createImageBitmap(new Blob([bytes.slice().buffer as ArrayBuffer]), {
            imageOrientation: "from-image",
            resizeWidth: request.width,
            resizeHeight: request.height,
            resizeQuality: "high",
        }),
        request.signal,
        (lateBitmap) => lateBitmap.close(),
    );
    let closed = false;
    const close = (): void => {
        if (closed) return;
        closed = true;
        bitmap.close();
    };
    request.signal.addEventListener("abort", close, { once: true });
    try {
        return await encodeBitmap(bitmap, request);
    } finally {
        request.signal.removeEventListener("abort", close);
        close();
    }
}

async function canvasRegionCrop(
    bytes: Uint8Array,
    request: RegionCropRequest,
): Promise<Uint8Array> {
    const preserveCroppedPixelsUntilCanvas =
        request.sourceWidth * request.sourceHeight <= MAX_HIGH_QUALITY_REGION_BITMAP_PIXELS;
    const bitmap = await awaitAbortable(
        createImageBitmap(
            new Blob([bytes.slice().buffer as ArrayBuffer]),
            request.sourceX,
            request.sourceY,
            request.sourceWidth,
            request.sourceHeight,
            preserveCroppedPixelsUntilCanvas
                ? { imageOrientation: "from-image" }
                : {
                      imageOrientation: "from-image",
                      resizeWidth: request.width,
                      resizeHeight: request.height,
                      resizeQuality: "high",
                  },
        ),
        request.signal,
        (lateBitmap) => lateBitmap.close(),
    );
    let closed = false;
    const close = (): void => {
        if (closed) return;
        closed = true;
        bitmap.close();
    };
    request.signal.addEventListener("abort", close, { once: true });
    try {
        return await encodeBitmap(bitmap, request);
    } finally {
        request.signal.removeEventListener("abort", close);
        close();
    }
}

function lowerHalfCrop(dimensions: ImageDimensions): Omit<RegionCropRequest, keyof ResizeRequest> {
    const sourceY = Math.floor(dimensions.height / 2);
    return {
        sourceX: 0,
        sourceY,
        sourceWidth: dimensions.width,
        sourceHeight: dimensions.height - sourceY,
    };
}

function detailCardCrop(dimensions: ImageDimensions): Omit<RegionCropRequest, keyof ResizeRequest> {
    // Stable version-3 contract: a content-agnostic band that enlarges the labelled detail card on
    // tall phone receipts without allowing app-provided coordinates or locating text.
    const sourceY = Math.floor((dimensions.height * 58) / 100);
    const sourceBottom = Math.ceil((dimensions.height * 86) / 100);
    return {
        sourceX: 0,
        sourceY,
        sourceWidth: dimensions.width,
        sourceHeight: sourceBottom - sourceY,
    };
}

function lowerDetailRowsCrop(
    dimensions: ImageDimensions,
): Omit<RegionCropRequest, keyof ResizeRequest> {
    // Stable version-4 contract: focus the lower labelled rows on tall receipts while retaining
    // full width. As with every region, landscape/near-square inputs keep their original pixels.
    const sourceY = Math.floor((dimensions.height * 68) / 100);
    const sourceBottom = Math.ceil((dimensions.height * 90) / 100);
    return {
        sourceX: 0,
        sourceY,
        sourceWidth: dimensions.width,
        sourceHeight: sourceBottom - sourceY,
    };
}

/**
 * Derive a bounded model-only detail raster from the original image pixels. This is deliberately a
 * closed, content-agnostic transform: it neither locates text nor performs OCR, and the source image
 * remains unchanged. Cropping before the ordinary pixel cap gives small labelled fields on tall
 * receipts enough visual resolution for a focused VLM pass.
 */
export async function prepareImageRegionForInference(
    bytes: Uint8Array,
    region: InferenceImageRegion,
    crop: InferenceImageRegionCropper = canvasRegionCrop,
): Promise<Uint8Array> {
    if (region !== "lower_half" && region !== "detail_card" && region !== "lower_detail_rows") {
        throw new Error("Unsupported inference image region.");
    }
    const intrinsicDimensions = intrinsicImageDimensions(bytes);
    if (intrinsicDimensions === undefined) {
        throw new Error("The image dimensions could not be verified for focused inference.");
    }
    if (!sourceDimensionsWithinBounds(intrinsicDimensions)) {
        throw new Error("The image is too large to focus safely for inference.");
    }
    // The lower detail band is useful only when whole-document letterboxing materially shrinks a
    // tall receipt. Landscape and near-square documents already spend the bounded vision surface on
    // their full pixels; preserve them so a focused pass can still see a date or item near the top.
    if (intrinsicDimensions.height * 3 < intrinsicDimensions.width * 4) return bytes;
    const source =
        region === "detail_card"
            ? detailCardCrop(intrinsicDimensions)
            : region === "lower_detail_rows"
              ? lowerDetailRowsCrop(intrinsicDimensions)
              : lowerHalfCrop(intrinsicDimensions);
    const output = inferenceImageDimensions({
        width: source.sourceWidth,
        height: source.sourceHeight,
    });
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const request: RegionCropRequest = {
        ...source,
        ...output,
        mimeType: "image/jpeg",
        quality: INFERENCE_JPEG_QUALITY,
        signal: controller.signal,
    };
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            timedOut = true;
            reject(new Error("Focused image preparation timed out."));
            controller.abort();
        }, BROWSER_INFERENCE_IMAGE_PREPARE_TIMEOUT_MS);
    });
    try {
        const prepared = await Promise.race([crop(bytes, request), timeout]);
        if (prepared.byteLength === 0) throw new Error("image encoding returned no data");
        return prepared;
    } catch (error) {
        if (timedOut) {
            throw new Error("The image detail did not finish preparing for inference in time.");
        }
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`The image detail could not be safely prepared for inference. (${detail})`);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

/**
 * Make a bounded, inference-only copy of a chat image. The stored/displayed attachment is unchanged.
 * Qwen's phone compatibility profile receives about 0.25 megapixels (256 vision tokens), while a
 * phone never hands a multi-megapixel camera decode to the Wllama worker.
 */
export async function prepareImageForBrowserInference(
    bytes: Uint8Array,
    dimensions?: ImageDimensions,
    resize: InferenceImageResizer = canvasResize,
): Promise<Uint8Array> {
    if (dimensions !== undefined && !validDimensions(dimensions)) {
        throw new Error("The image dimensions are unavailable for safe browser inference.");
    }
    const intrinsicDimensions = intrinsicImageDimensions(bytes);
    if (intrinsicDimensions === undefined) {
        throw new Error(
            "The image dimensions could not be verified for safe browser inference. Try a supported raster image.",
        );
    }
    if (!sourceDimensionsWithinBounds(intrinsicDimensions)) {
        throw new Error(
            "The image is too large to prepare safely for the browser model. Try a smaller image.",
        );
    }
    // Passing bytes through is safe only when the encoded header itself proves the raster already
    // fits the model's pixel and edge budget. Sender metadata can be stale or forged.
    if (!needsResize(intrinsicDimensions)) return bytes;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const request: ResizeRequest = {
        ...inferenceImageDimensions(intrinsicDimensions),
        mimeType: "image/jpeg",
        quality: INFERENCE_JPEG_QUALITY,
        signal: controller.signal,
    };
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            timedOut = true;
            reject(new Error("Image preparation timed out."));
            controller.abort();
        }, BROWSER_INFERENCE_IMAGE_PREPARE_TIMEOUT_MS);
    });
    try {
        const prepared = await Promise.race([resize(bytes, request), timeout]);
        if (prepared.byteLength === 0) throw new Error("image encoding returned no data");
        return prepared;
    } catch (error) {
        if (timedOut) {
            throw new Error(
                "The image did not finish preparing for the browser model in time. Try a smaller image.",
            );
        }
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
            `The image could not be safely prepared for browser inference. Try a smaller image. (${detail})`,
        );
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}
