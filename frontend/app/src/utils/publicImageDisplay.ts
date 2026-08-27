import type { BlobReference } from "@client";
import { localReplicaImagePath } from "../../localReplicaImageProxy";

// OpenChat caps uploaded images at 5 MiB. Keep the worker response bounded to that same value so a
// malformed storage response cannot make the page allocate an unbounded Blob.
export const MAX_PUBLIC_IMAGE_DISPLAY_BYTES = 5 * 1024 * 1024;

export type PublicImageBlobLoader = (
    ref: BlobReference,
    maxBytes: number,
) => Promise<Uint8Array | undefined>;

export type PublicImagePageLocation = Pick<Location, "protocol" | "hostname">;

type ObjectUrlApi = {
    createObjectURL(blob: Blob): string;
    revokeObjectURL(url: string): void;
};

function safeImageMimeType(mimeType: string): string | undefined {
    const normalized = mimeType.trim().toLowerCase();
    return /^image\/[a-z0-9][a-z0-9.+-]{0,63}$/.test(normalized) ? normalized : undefined;
}

function isLoopback(hostname: string): boolean {
    const normalized = hostname.toLowerCase();
    return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

/**
 * A local PocketIC blob URL is valid on the development PC, but `localhost` names the phone when
 * the same UI is opened over Tailscale. In that one exact case the component should use OpenChat's
 * same-origin local-image route instead of navigating the browser to a different origin. The URL
 * and reference must agree exactly before this automatic path is used.
 */
export function shouldProxyLocalPublicImage(
    blobUrl: string | undefined,
    ref: BlobReference | undefined,
    page: PublicImagePageLocation | undefined = typeof window === "undefined"
        ? undefined
        : window.location,
): boolean {
    if (
        blobUrl === undefined ||
        ref === undefined ||
        page?.protocol !== "https:" ||
        isLoopback(page.hostname)
    ) {
        return false;
    }
    try {
        const parsed = new URL(blobUrl);
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

/**
 * Keep local public images same-origin when the development UI is reached through HTTPS.
 *
 * A phone cannot resolve the PC-only `*.raw.localhost:8080` URL embedded in the chat event. The
 * Vite route streams the original public image from that exact canister and blob id, so display no
 * longer depends on the OpenChat background worker completing an ArrayBuffer round trip first.
 */
export function publicImageDisplayUrl(
    blobUrl: string | undefined,
    ref: BlobReference | undefined,
    page: PublicImagePageLocation | undefined = typeof window === "undefined"
        ? undefined
        : window.location,
): string | undefined {
    if (!shouldProxyLocalPublicImage(blobUrl, ref, page) || ref === undefined) {
        return blobUrl;
    }
    return localReplicaImagePath(ref.canisterId, ref.blobId) ?? blobUrl;
}

/**
 * Owns at most one object URL. Repeated calls for the same message share the in-flight worker read;
 * changing messages or disposing the component invalidates stale reads and revokes the old URL.
 */
export class PublicImageObjectUrlResolver {
    readonly #load: PublicImageBlobLoader;
    readonly #urls: ObjectUrlApi;
    #generation = 0;
    #key: string | undefined;
    #objectUrl: string | undefined;
    #pending: Promise<string | undefined> | undefined;

    constructor(load: PublicImageBlobLoader, urls: ObjectUrlApi = URL) {
        this.#load = load;
        this.#urls = urls;
    }

    resolve(ref: BlobReference, mimeType: string): Promise<string | undefined> {
        const safeMimeType = safeImageMimeType(mimeType);
        if (safeMimeType === undefined) return Promise.resolve(undefined);

        const key = `${ref.canisterId}:${ref.blobId}:${safeMimeType}`;
        if (this.#key === key) {
            if (this.#objectUrl !== undefined) return Promise.resolve(this.#objectUrl);
            if (this.#pending !== undefined) return this.#pending;
        }

        this.clear();
        this.#key = key;
        const generation = this.#generation;
        const pending = this.#resolve(ref, safeMimeType, generation);
        this.#pending = pending;
        return pending;
    }

    clear(): void {
        this.#generation += 1;
        this.#key = undefined;
        this.#pending = undefined;
        if (this.#objectUrl !== undefined) {
            this.#urls.revokeObjectURL(this.#objectUrl);
            this.#objectUrl = undefined;
        }
    }

    async #resolve(
        ref: BlobReference,
        mimeType: string,
        generation: number,
    ): Promise<string | undefined> {
        try {
            const bytes = await this.#load(ref, MAX_PUBLIC_IMAGE_DISPLAY_BYTES);
            if (
                generation !== this.#generation ||
                bytes === undefined ||
                bytes.byteLength === 0 ||
                bytes.byteLength > MAX_PUBLIC_IMAGE_DISPLAY_BYTES
            ) {
                return undefined;
            }

            const data = bytes.slice().buffer as ArrayBuffer;
            const objectUrl = this.#urls.createObjectURL(new Blob([data], { type: mimeType }));
            if (generation !== this.#generation) {
                this.#urls.revokeObjectURL(objectUrl);
                return undefined;
            }
            this.#objectUrl = objectUrl;
            return objectUrl;
        } catch {
            return undefined;
        } finally {
            if (generation === this.#generation) this.#pending = undefined;
        }
    }
}
