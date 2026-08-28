export const LOCAL_REPLICA_IMAGE_ROUTE_PREFIX = "/__oc-local-image";
export const MAX_LOCAL_REPLICA_IMAGE_BYTES = 5 * 1024 * 1024;

const MAX_FILE_ID = (1n << 128n) - 1n;
const CANISTER_ID_PATTERN = /^(?=.{5,63}$)(?!-)(?!.*--)[a-z0-9-]+(?<!-)$/;

export type LocalReplicaImageRoute = {
    canisterId: string;
    blobId: bigint;
    upstreamPath: string;
};

function validCanisterId(canisterId: string): boolean {
    return CANISTER_ID_PATTERN.test(canisterId);
}

function validBlobId(blobId: bigint): boolean {
    return blobId >= 0n && blobId <= MAX_FILE_ID;
}

/**
 * Build a same-origin development URL for one public PocketIC image.
 *
 * The route contains only the canonical principal text and u128 file id. It never accepts an
 * arbitrary upstream host or path; the Vite middleware always forwards to the configured local
 * replica and constructs the raw-canister Host header itself.
 */
export function localReplicaImagePath(canisterId: string, blobId: bigint): string | undefined {
    const normalizedCanisterId = canisterId.trim().toLowerCase();
    if (!validCanisterId(normalizedCanisterId) || !validBlobId(blobId)) return undefined;
    return `${LOCAL_REPLICA_IMAGE_ROUTE_PREFIX}/${normalizedCanisterId}/blobs/${blobId}`;
}

/** Parse and validate the exact route accepted by the development image proxy. */
export function parseLocalReplicaImagePath(pathname: string): LocalReplicaImageRoute | undefined {
    const match = new RegExp(
        `^${LOCAL_REPLICA_IMAGE_ROUTE_PREFIX}/([a-z0-9-]{5,63})/blobs/(0|[1-9]\\d{0,38})$`,
    ).exec(pathname);
    if (match === null || !validCanisterId(match[1])) return undefined;

    try {
        const blobId = BigInt(match[2]);
        if (!validBlobId(blobId)) return undefined;
        return {
            canisterId: match[1],
            blobId,
            upstreamPath: `/blobs/${blobId}`,
        };
    } catch {
        return undefined;
    }
}
