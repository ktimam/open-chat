export const MAX_BROWSER_OCR_IMAGE_PIXELS = 2_000_000;
export const MAX_BROWSER_OCR_IMAGE_EDGE = 1_600;
export const BROWSER_OCR_PREPARE_TIMEOUT_MS = 15_000;
const MAX_BROWSER_OCR_SOURCE_PIXELS = 40_000_000;
const MAX_BROWSER_OCR_SOURCE_EDGE = 8_192;
const OCR_JPEG_QUALITY = 0.9;
const OCR_UI_SCREENSHOT_SAMPLE_EDGE = 64;
const OCR_UI_SCREENSHOT_WHITE_CHANNEL = 235;
const OCR_UI_SCREENSHOT_DARK_LUMA = 180;
const OCR_UI_SCREENSHOT_MIN_WHITE_RATIO = 0.88;
const OCR_UI_SCREENSHOT_MIN_DARK_RATIO = 0.005;
const OCR_UI_SCREENSHOT_MAX_DARK_RATIO = 0.12;
const OCR_UI_SCREENSHOT_MAX_CHROMATIC_RATIO = 0.08;
const OCR_UI_SCREENSHOT_CHROMA_DELTA = 24;
const OCR_UI_BINARY_THRESHOLD = 235;

export type OcrImageDimensions = { width: number; height: number };

type OcrResizeRequest = OcrImageDimensions & {
    mimeType: "image/jpeg";
    quality: number;
    signal: AbortSignal;
};

export type OcrImageResizer = (bytes: Uint8Array, request: OcrResizeRequest) => Promise<Uint8Array>;

type OcrEnhanceRequest = OcrImageDimensions & {
    signal: AbortSignal;
};

/** `undefined` means that the image is not confidently eligible and must remain byte-identical. */
export type OcrImageEnhancer = (
    bytes: Uint8Array,
    request: OcrEnhanceRequest,
) => Promise<Uint8Array | undefined>;

function pixelLuma(red: number, green: number, blue: number): number {
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/**
 * Deliberately narrow, content-agnostic gate for rendered light-theme UI screenshots. Photographs,
 * scans with shadows, colourful images and nearly blank images stay on the original byte path.
 */
export function shouldThresholdMostlyWhiteUiScreenshot(pixels: Uint8ClampedArray): boolean {
    const pixelCount = Math.floor(pixels.length / 4);
    if (pixelCount === 0 || pixels.length % 4 !== 0) return false;
    let neutralWhite = 0;
    let dark = 0;
    let chromatic = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
        const red = pixels[offset];
        const green = pixels[offset + 1];
        const blue = pixels[offset + 2];
        if (Math.min(red, green, blue) >= OCR_UI_SCREENSHOT_WHITE_CHANNEL) neutralWhite++;
        if (pixelLuma(red, green, blue) <= OCR_UI_SCREENSHOT_DARK_LUMA) dark++;
        if (
            Math.max(red, green, blue) - Math.min(red, green, blue) >=
            OCR_UI_SCREENSHOT_CHROMA_DELTA
        ) {
            chromatic++;
        }
    }
    const whiteRatio = neutralWhite / pixelCount;
    const darkRatio = dark / pixelCount;
    const chromaticRatio = chromatic / pixelCount;
    return (
        whiteRatio >= OCR_UI_SCREENSHOT_MIN_WHITE_RATIO &&
        darkRatio >= OCR_UI_SCREENSHOT_MIN_DARK_RATIO &&
        darkRatio <= OCR_UI_SCREENSHOT_MAX_DARK_RATIO &&
        chromaticRatio <= OCR_UI_SCREENSHOT_MAX_CHROMATIC_RATIO
    );
}

/** Convert a confidently selected UI screenshot into high-contrast monochrome OCR input. */
export function thresholdOcrUiPixels(pixels: Uint8ClampedArray): void {
    for (let offset = 0; offset + 3 < pixels.length; offset += 4) {
        const value =
            pixelLuma(pixels[offset], pixels[offset + 1], pixels[offset + 2]) >=
            OCR_UI_BINARY_THRESHOLD
                ? 255
                : 0;
        pixels[offset] = value;
        pixels[offset + 1] = value;
        pixels[offset + 2] = value;
        pixels[offset + 3] = 255;
    }
}

function validDimensions(
    dimensions: OcrImageDimensions | undefined,
): dimensions is OcrImageDimensions {
    return (
        dimensions !== undefined &&
        Number.isFinite(dimensions.width) &&
        Number.isFinite(dimensions.height) &&
        dimensions.width > 0 &&
        dimensions.height > 0
    );
}

function sourceDimensionsWithinBounds(dimensions: OcrImageDimensions): boolean {
    return (
        validDimensions(dimensions) &&
        dimensions.width <= MAX_BROWSER_OCR_SOURCE_EDGE &&
        dimensions.height <= MAX_BROWSER_OCR_SOURCE_EDGE &&
        dimensions.width * dimensions.height <= MAX_BROWSER_OCR_SOURCE_PIXELS
    );
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
    return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function u16be(bytes: Uint8Array, offset: number): number {
    return bytes[offset] * 0x100 + bytes[offset + 1];
}

function u16le(bytes: Uint8Array, offset: number): number {
    return bytes[offset] + bytes[offset + 1] * 0x100;
}

function u24le(bytes: Uint8Array, offset: number): number {
    return bytes[offset] + bytes[offset + 1] * 0x100 + bytes[offset + 2] * 0x1_0000;
}

function u32be(bytes: Uint8Array, offset: number): number {
    return bytes[offset] * 0x1_000000 + bytes[offset + 1] * 0x1_0000 + u16be(bytes, offset + 2);
}

function i32le(bytes: Uint8Array, offset: number): number {
    const unsigned =
        bytes[offset] +
        bytes[offset + 1] * 0x100 +
        bytes[offset + 2] * 0x1_0000 +
        bytes[offset + 3] * 0x1_000000;
    return unsigned > 0x7fff_ffff ? unsigned - 0x1_0000_0000 : unsigned;
}

function jpegDimensions(bytes: Uint8Array): OcrImageDimensions | undefined {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
    const sofMarkers = new Set([
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
    ]);
    let offset = 2;
    const scanLimit = Math.min(bytes.length, 1024 * 1024);
    while (offset + 3 < scanLimit) {
        while (offset < scanLimit && bytes[offset] !== 0xff) offset++;
        while (offset < scanLimit && bytes[offset] === 0xff) offset++;
        if (offset >= scanLimit) break;
        const marker = bytes[offset++];
        if (marker === 0xda || marker === 0xd9) break;
        if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
        if (offset + 1 >= scanLimit) return undefined;
        const segmentLength = u16be(bytes, offset);
        if (segmentLength < 2 || offset + segmentLength > bytes.length) return undefined;
        if (sofMarkers.has(marker)) {
            if (segmentLength < 7) return undefined;
            return {
                width: u16be(bytes, offset + 5),
                height: u16be(bytes, offset + 3),
            };
        }
        offset += segmentLength;
    }
    return undefined;
}

/** Read raster dimensions from bounded headers without decoding attacker-controlled pixels. */
export function intrinsicOcrImageDimensions(bytes: Uint8Array): OcrImageDimensions | undefined {
    if (
        bytes.length >= 24 &&
        bytes[0] === 0x89 &&
        ascii(bytes, 1, 3) === "PNG" &&
        ascii(bytes, 12, 4) === "IHDR"
    ) {
        return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
    }
    if (
        bytes.length >= 10 &&
        (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")
    ) {
        return { width: u16le(bytes, 6), height: u16le(bytes, 8) };
    }
    if (bytes.length >= 26 && ascii(bytes, 0, 2) === "BM") {
        const dibSize =
            bytes[14] + bytes[15] * 0x100 + bytes[16] * 0x1_0000 + bytes[17] * 0x1_000000;
        if (dibSize === 12) {
            return { width: u16le(bytes, 18), height: u16le(bytes, 20) };
        }
        if (dibSize >= 40) {
            return { width: Math.abs(i32le(bytes, 18)), height: Math.abs(i32le(bytes, 22)) };
        }
    }
    if (bytes.length >= 30 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
        const kind = ascii(bytes, 12, 4);
        if (kind === "VP8X") {
            return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
        }
        if (kind === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
            return {
                width: u16le(bytes, 26) & 0x3fff,
                height: u16le(bytes, 28) & 0x3fff,
            };
        }
        if (kind === "VP8L" && bytes[20] === 0x2f) {
            return {
                width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
                height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
            };
        }
    }
    return jpegDimensions(bytes);
}

export function browserOcrImageDimensions(dimensions: OcrImageDimensions): OcrImageDimensions {
    const pixelScale = Math.sqrt(
        MAX_BROWSER_OCR_IMAGE_PIXELS / (dimensions.width * dimensions.height),
    );
    const edgeScale = MAX_BROWSER_OCR_IMAGE_EDGE / Math.max(dimensions.width, dimensions.height);
    const scale = Math.min(1, pixelScale, edgeScale);
    return {
        width: Math.max(1, Math.floor(dimensions.width * scale)),
        height: Math.max(1, Math.floor(dimensions.height * scale)),
    };
}

function needsResize(dimensions: OcrImageDimensions): boolean {
    return (
        dimensions.width * dimensions.height > MAX_BROWSER_OCR_IMAGE_PIXELS ||
        Math.max(dimensions.width, dimensions.height) > MAX_BROWSER_OCR_IMAGE_EDGE
    );
}

async function encodeCanvas(canvas: HTMLCanvasElement, signal: AbortSignal): Promise<Uint8Array> {
    if (signal.aborted) throw new Error("Image preparation was cancelled.");
    const blob = await new Promise<Blob>((resolve, reject) => {
        let settled = false;
        const onAbort = (): void => {
            if (settled) return;
            settled = true;
            reject(new Error("Image preparation was cancelled."));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        canvas.toBlob(
            (result) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener("abort", onAbort);
                if (result === null) {
                    reject(new Error("image encoding failed"));
                } else {
                    resolve(result);
                }
            },
            "image/jpeg",
            OCR_JPEG_QUALITY,
        );
    });
    const encoded = new Uint8Array(await blob.arrayBuffer());
    if (encoded.byteLength === 0) throw new Error("image encoding returned no data");
    return encoded;
}

async function encodeBitmap(bitmap: ImageBitmap, request: OcrResizeRequest): Promise<Uint8Array> {
    if (request.signal.aborted) throw new Error("Image preparation was cancelled.");
    const canvas = document.createElement("canvas");
    canvas.width = request.width;
    canvas.height = request.height;
    const context = canvas.getContext("2d", { alpha: false });
    if (context === null) throw new Error("canvas 2d context unavailable");
    context.drawImage(bitmap, 0, 0, request.width, request.height);
    return encodeCanvas(canvas, request.signal);
}

async function canvasResize(bytes: Uint8Array, request: OcrResizeRequest): Promise<Uint8Array> {
    const bitmap = await createImageBitmap(new Blob([bytes.slice().buffer as ArrayBuffer]), {
        resizeWidth: request.width,
        resizeHeight: request.height,
        resizeQuality: "high",
    });
    const close = (): void => bitmap.close();
    request.signal.addEventListener("abort", close, { once: true });
    try {
        return await encodeBitmap(bitmap, request);
    } finally {
        request.signal.removeEventListener("abort", close);
        bitmap.close();
    }
}

async function canvasEnhanceMostlyWhiteUiScreenshot(
    bytes: Uint8Array,
    request: OcrEnhanceRequest,
): Promise<Uint8Array | undefined> {
    if (request.signal.aborted) throw new Error("Image preparation was cancelled.");
    const bitmap = await createImageBitmap(new Blob([bytes.slice().buffer as ArrayBuffer]));
    if (request.signal.aborted) {
        bitmap.close();
        throw new Error("Image preparation was cancelled.");
    }
    const close = (): void => bitmap.close();
    request.signal.addEventListener("abort", close, { once: true });
    try {
        const sample = document.createElement("canvas");
        sample.width = OCR_UI_SCREENSHOT_SAMPLE_EDGE;
        sample.height = OCR_UI_SCREENSHOT_SAMPLE_EDGE;
        const sampleContext = sample.getContext("2d", { alpha: false });
        if (sampleContext === null) throw new Error("canvas 2d context unavailable");
        sampleContext.fillStyle = "white";
        sampleContext.fillRect(0, 0, sample.width, sample.height);
        sampleContext.drawImage(bitmap, 0, 0, sample.width, sample.height);
        const samplePixels = sampleContext.getImageData(0, 0, sample.width, sample.height).data;
        if (!shouldThresholdMostlyWhiteUiScreenshot(samplePixels)) return undefined;
        if (request.signal.aborted) throw new Error("Image preparation was cancelled.");

        const canvas = document.createElement("canvas");
        canvas.width = request.width;
        canvas.height = request.height;
        const context = canvas.getContext("2d", { alpha: false });
        if (context === null) throw new Error("canvas 2d context unavailable");
        context.fillStyle = "white";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        thresholdOcrUiPixels(pixels.data);
        context.putImageData(pixels, 0, 0);
        return encodeCanvas(canvas, request.signal);
    } finally {
        request.signal.removeEventListener("abort", close);
        bitmap.close();
    }
}

/**
 * Bound camera-photo decode memory without throwing away the text resolution Tesseract needs.
 * The accepted 900x700 and 1200x900 fixtures stay byte-identical; multi-megapixel phone photos are
 * re-encoded at up to 1600px / 2MP. This is deliberately separate from Qwen's much smaller image
 * tensor profile.
 */
async function prepareImageForBrowserOcrInternal(
    bytes: Uint8Array,
    declaredDimensions: OcrImageDimensions | undefined,
    signal: AbortSignal,
    resize: OcrImageResizer = canvasResize,
    enhance: OcrImageEnhancer = canvasEnhanceMostlyWhiteUiScreenshot,
): Promise<Uint8Array> {
    if (declaredDimensions !== undefined && !validDimensions(declaredDimensions)) {
        throw new Error("Image dimensions are unavailable.");
    }
    const dimensions = intrinsicOcrImageDimensions(bytes);
    if (dimensions === undefined) throw new Error("Image dimensions could not be verified.");
    if (!sourceDimensionsWithinBounds(dimensions)) {
        throw new Error("Image dimensions exceed the safe local-reading limit.");
    }
    if (!needsResize(dimensions)) {
        return (await enhance(bytes, { ...dimensions, signal })) ?? bytes;
    }
    const resizedDimensions = browserOcrImageDimensions(dimensions);
    const resized = await resize(bytes, {
        ...resizedDimensions,
        mimeType: "image/jpeg",
        quality: OCR_JPEG_QUALITY,
        signal,
    });
    // Resizing is only a memory bound. A tall phone screenshot is still the same eligible light UI
    // document afterward, so run the bounded content-agnostic enhancer on the resized bytes too.
    return (await enhance(resized, { ...resizedDimensions, signal })) ?? resized;
}

export async function prepareImageForBrowserOcr(
    bytes: Uint8Array,
    dimensions: OcrImageDimensions | undefined,
    resize: OcrImageResizer = canvasResize,
    enhance: OcrImageEnhancer = canvasEnhanceMostlyWhiteUiScreenshot,
): Promise<Uint8Array> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            // Settle with the stable user-facing deadline before cooperative cleanup can reject.
            reject(new Error("Image preparation timed out."));
            controller.abort();
        }, BROWSER_OCR_PREPARE_TIMEOUT_MS);
    });
    try {
        return await Promise.race([
            prepareImageForBrowserOcrInternal(
                bytes,
                dimensions,
                controller.signal,
                resize,
                enhance,
            ),
            timeout,
        ]);
    } finally {
        clearTimeout(timer);
    }
}
