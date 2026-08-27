import { AnonymousIdentity, HttpAgent, type ActorMethod } from "@icp-sdk/core/agent";
import type { IDL } from "@icp-sdk/core/candid";

// Leave headroom below the storage bucket's 1.5 MiB response ceiling for Candid/HTTP metadata.
// Range requests do not use the HTTP streaming callback, so this path stays a short sequence of
// ordinary read-only HttpAgent queries and works when a phone cannot resolve `*.raw.localhost`.
export const PUBLIC_BLOB_CHUNK_BYTES = (3 << 19) - 1024;
export const MAX_PUBLIC_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PUBLIC_BLOB_QUERIES = Math.ceil(MAX_PUBLIC_IMAGE_BYTES / PUBLIC_BLOB_CHUNK_BYTES);
export const PUBLIC_BLOB_AGENT_TIMEOUT_MS = 12_000;

const MAX_FILE_ID = (1n << 128n) - 1n;
const RASTER_IMAGE_MIME_TYPES = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/bmp",
]);

export interface PublicBlobHttpRequest {
    url: string;
    method: string;
    body: Uint8Array | number[];
    headers: Array<[string, string]>;
}

export interface PublicBlobHttpResponse {
    body: Uint8Array | number[];
    headers: Array<[string, string]>;
    upgrade: [] | [boolean];
    status_code: number;
}

export interface PublicBlobHttpService {
    http_request: ActorMethod<[PublicBlobHttpRequest], PublicBlobHttpResponse>;
}

export type PublicBlobQuery = (request: PublicBlobHttpRequest) => Promise<PublicBlobHttpResponse>;

// A deliberately narrow local IDL for the public HTTP query. The canister response also carries an
// optional streaming_strategy field; Candid record width subtyping lets this Range-only client omit
// it, and every accepted 206 response is bounded and assembled locally. Keeping this separate avoids
// hand-editing generated StorageBucket bindings, which would be overwritten on regeneration.
export const publicBlobIdlFactory: IDL.InterfaceFactory = ({ IDL }) => {
    const HttpRequest = IDL.Record({
        url: IDL.Text,
        method: IDL.Text,
        body: IDL.Vec(IDL.Nat8),
        headers: IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text)),
    });
    const HttpResponse = IDL.Record({
        body: IDL.Vec(IDL.Nat8),
        headers: IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text)),
        upgrade: IDL.Opt(IDL.Bool),
        status_code: IDL.Nat16,
    });
    return IDL.Service({
        http_request: IDL.Func([HttpRequest], [HttpResponse], ["query"]),
    });
};

function deadlineFetch(sourceFetch: typeof fetch, deadline: number): typeof fetch {
    return async (input, init) => {
        const controller = new AbortController();
        const upstreamSignal = init?.signal;
        const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);
        if (upstreamSignal?.aborted) {
            abortFromUpstream();
        } else {
            upstreamSignal?.addEventListener("abort", abortFromUpstream, { once: true });
        }
        const timeoutId = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
        try {
            return await sourceFetch(input, { ...init, signal: controller.signal });
        } finally {
            clearTimeout(timeoutId);
            upstreamSignal?.removeEventListener("abort", abortFromUpstream);
        }
    };
}

/**
 * Clone only the transport/network configuration needed for a bounded public query. The selected
 * blob canister is message-controlled, so it must never receive the signed user's principal. The
 * single overall deadline is shared by all chunks and agent retries are disabled.
 */
export function createAnonymousPublicBlobAgent(agent: HttpAgent): HttpAgent {
    const sourceFetch = agent.config.fetch ?? globalThis.fetch;
    return HttpAgent.createSync({
        ...agent.config,
        host: agent.host.toString(),
        identity: new AnonymousIdentity(),
        fetch: deadlineFetch(sourceFetch, Date.now() + PUBLIC_BLOB_AGENT_TIMEOUT_MS),
        retryTimes: 0,
        rootKey: agent.rootKey ?? undefined,
        shouldFetchRootKey: false,
        shouldSyncTime: false,
    });
}

function uniqueHeader(headers: Array<[string, string]>, name: string): string | undefined {
    const values = headers
        .filter(([key]) => key.localeCompare(name, undefined, { sensitivity: "accent" }) === 0)
        .map(([, value]) => value.trim());
    return values.length === 1 && values[0].length > 0 ? values[0] : undefined;
}

function normalizedRasterMimeType(value: string | undefined): string | undefined {
    const mimeType = value?.split(";", 1)[0].trim().toLowerCase();
    return mimeType !== undefined && RASTER_IMAGE_MIME_TYPES.has(mimeType) ? mimeType : undefined;
}

type ParsedContentRange = { start: number; end: number; total: number };

function parseContentRange(value: string | undefined): ParsedContentRange | undefined {
    const match = /^bytes (0|[1-9]\d*)-(0|[1-9]\d*)\/(0|[1-9]\d*)$/.exec(value ?? "");
    if (match === null) return undefined;
    const [start, end, total] = match.slice(1).map(Number);
    if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        !Number.isSafeInteger(total) ||
        start < 0 ||
        end < start ||
        total < 1 ||
        end >= total
    ) {
        return undefined;
    }
    return { start, end, total };
}

function validCap(maxBytes: number): boolean {
    return Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= MAX_PUBLIC_IMAGE_BYTES;
}

/**
 * Download one public StorageBucket raster image through anonymous HttpAgent query plumbing.
 * Failure is intentionally collapsed to `undefined`: this is an optional fallback for a locally
 * unreadable blob URL, never an authorization or mutation API.
 */
export async function downloadPublicImageBlob(
    fileId: bigint,
    maxBytes: number,
    query: PublicBlobQuery,
): Promise<Uint8Array | undefined> {
    if (fileId < 0n || fileId > MAX_FILE_ID || !validCap(maxBytes)) return undefined;

    let expectedTotal: number | undefined;
    let expectedMimeType: string | undefined;
    let output: Uint8Array | undefined;
    let offset = 0;
    let queryCount = 0;

    do {
        queryCount += 1;
        if (queryCount > MAX_PUBLIC_BLOB_QUERIES) return undefined;
        const request: PublicBlobHttpRequest = {
            url: `/blobs/${fileId}`,
            method: "GET",
            body: new Uint8Array(),
            // The storage bucket interprets the second value as an exclusive limit and reports the
            // conventional inclusive end in Content-Range.
            headers: [["Range", `bytes=${offset}-${offset + PUBLIC_BLOB_CHUNK_BYTES}`]],
        };
        const response = await query(request);
        if (response.status_code !== 206) return undefined;

        const bytes =
            response.body instanceof Uint8Array ? response.body : new Uint8Array(response.body);
        const range = parseContentRange(uniqueHeader(response.headers, "Content-Range"));
        const contentLength = uniqueHeader(response.headers, "Content-Length");
        const mimeType = normalizedRasterMimeType(uniqueHeader(response.headers, "Content-Type"));
        if (
            range === undefined ||
            range.start !== offset ||
            range.end !== offset + bytes.byteLength - 1 ||
            bytes.byteLength !== Math.min(PUBLIC_BLOB_CHUNK_BYTES, range.total - offset) ||
            contentLength === undefined ||
            !/^\d+$/.test(contentLength) ||
            Number(contentLength) !== bytes.byteLength ||
            mimeType === undefined
        ) {
            return undefined;
        }

        if (expectedTotal === undefined) {
            if (range.total > maxBytes) return undefined;
            expectedTotal = range.total;
            expectedMimeType = mimeType;
            output = new Uint8Array(expectedTotal);
        } else if (range.total !== expectedTotal || mimeType !== expectedMimeType) {
            return undefined;
        }

        if (output === undefined || offset + bytes.byteLength > output.byteLength) return undefined;
        output.set(bytes, offset);
        offset += bytes.byteLength;
    } while (expectedTotal !== undefined && offset < expectedTotal);

    return output !== undefined &&
        offset === output.byteLength &&
        expectedMimeType !== undefined &&
        imageSignatureMatches(output, expectedMimeType)
        ? output
        : undefined;
}

function bytesEqual(bytes: Uint8Array, expected: readonly number[], offset = 0): boolean {
    return (
        bytes.byteLength >= offset + expected.length &&
        expected.every((value, index) => bytes[offset + index] === value)
    );
}

function imageSignatureMatches(bytes: Uint8Array, mimeType: string): boolean {
    switch (mimeType) {
        case "image/jpeg":
            return bytesEqual(bytes, [0xff, 0xd8, 0xff]);
        case "image/png":
            return bytesEqual(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        case "image/webp":
            return (
                bytesEqual(bytes, [0x52, 0x49, 0x46, 0x46]) &&
                bytesEqual(bytes, [0x57, 0x45, 0x42, 0x50], 8)
            );
        case "image/gif":
            return (
                bytesEqual(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
                bytesEqual(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
            );
        case "image/bmp":
            return bytesEqual(bytes, [0x42, 0x4d]);
        default:
            return false;
    }
}
