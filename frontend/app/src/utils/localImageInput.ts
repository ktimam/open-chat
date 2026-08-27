import type { BlobReference, MessageContent } from "@client";

export const MAX_AI_IMAGE_DOWNLOAD_BYTES = 5 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 8_000;
export const AGENT_IMAGE_FETCH_TIMEOUT_MS = 15_000;

export type PublicBlobLoader = (
    ref: BlobReference,
    maxBytes: number,
) => Promise<Uint8Array | undefined>;

export type ImagePageLocation = Pick<Location, "protocol" | "hostname">;

function safeBytes(bytes: Uint8Array | undefined): Uint8Array | undefined {
    return bytes !== undefined &&
        bytes.byteLength > 0 &&
        bytes.byteLength <= MAX_AI_IMAGE_DOWNLOAD_BYTES
        ? bytes
        : undefined;
}

function isLoopback(hostname: string): boolean {
    const normalized = hostname.toLowerCase();
    return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function isExactLocalStorageBlob(url: string, ref: BlobReference | undefined): boolean {
    if (ref === undefined) return false;
    try {
        const parsed = new URL(url);
        return (
            parsed.protocol === "http:" &&
            parsed.port === "8080" &&
            parsed.hostname.toLowerCase() === `${ref.canisterId.toLowerCase()}.raw.localhost` &&
            parsed.pathname === `/blobs/${ref.blobId}` &&
            parsed.search === "" &&
            parsed.hash === ""
        );
    } catch {
        return false;
    }
}

function remoteHttpsCannotFetchLocalBlob(
    url: string,
    page: ImagePageLocation | undefined,
    ref: BlobReference | undefined,
): boolean {
    return (
        page?.protocol === "https:" &&
        !isLoopback(page.hostname) &&
        isExactLocalStorageBlob(url, ref)
    );
}

async function fetchBoundedImage(url: string): Promise<Uint8Array | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) return undefined;
        const contentLength = response.headers.get("Content-Length");
        if (
            contentLength !== null &&
            (/^\d+$/.test(contentLength) === false ||
                Number(contentLength) > MAX_AI_IMAGE_DOWNLOAD_BYTES)
        ) {
            return undefined;
        }
        const reader = response.body?.getReader();
        if (reader === undefined) return undefined;
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value === undefined || value.byteLength === 0) continue;
            total += value.byteLength;
            if (total > MAX_AI_IMAGE_DOWNLOAD_BYTES) {
                controller.abort();
                await reader.cancel().catch(() => undefined);
                return undefined;
            }
            chunks.push(value);
        }
        if (total === 0) return undefined;
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return bytes;
    } catch {
        return undefined;
    } finally {
        clearTimeout(timeout);
    }
}

async function loadReferencedImage(
    loader: PublicBlobLoader,
    ref: BlobReference,
): Promise<Uint8Array | undefined> {
    let cancelTimeout: (() => void) | undefined;
    try {
        const timeout = new Promise<undefined>((resolve) => {
            const timeoutId = setTimeout(resolve, AGENT_IMAGE_FETCH_TIMEOUT_MS);
            cancelTimeout = () => clearTimeout(timeoutId);
        });
        return safeBytes(await Promise.race([loader(ref, MAX_AI_IMAGE_DOWNLOAD_BYTES), timeout]));
    } catch {
        return undefined;
    } finally {
        cancelTimeout?.();
    }
}

export async function localImageBytes(
    content: MessageContent,
    loadPublicBlob?: PublicBlobLoader,
    page: ImagePageLocation | undefined = typeof window === "undefined"
        ? undefined
        : window.location,
): Promise<Uint8Array | undefined> {
    if (content.kind !== "image_content") return undefined;
    const inMemory = safeBytes(content.blobData);
    if (inMemory !== undefined) return inMemory;

    const ref = content.blobReference;
    if (
        content.blobUrl !== undefined &&
        !remoteHttpsCannotFetchLocalBlob(content.blobUrl, page, content.blobReference)
    ) {
        const fetched = await fetchBoundedImage(content.blobUrl);
        if (fetched !== undefined) return fetched;
    }

    if (ref !== undefined && loadPublicBlob !== undefined) {
        return loadReferencedImage(loadPublicBlob, ref);
    }
    return undefined;
}
