import { describe, expect, it } from "vitest";
import {
    LOCAL_REPLICA_IMAGE_ROUTE_PREFIX,
    localReplicaImagePath,
    parseLocalReplicaImagePath,
} from "../../localReplicaImageProxy";

const CANISTER_ID = "ucwa4-rx777-77774-qaada-cai";

describe("local replica image proxy routes", () => {
    it("round-trips one canonical canister and u128 blob reference", () => {
        const pathname = localReplicaImagePath(CANISTER_ID, 55n);

        expect(pathname).toBe(`${LOCAL_REPLICA_IMAGE_ROUTE_PREFIX}/${CANISTER_ID}/blobs/55`);
        expect(parseLocalReplicaImagePath(pathname!)).toEqual({
            canisterId: CANISTER_ID,
            blobId: 55n,
            upstreamPath: "/blobs/55",
        });
    });

    it("normalizes harmless principal whitespace and casing when building a route", () => {
        expect(localReplicaImagePath(`  ${CANISTER_ID.toUpperCase()}  `, 7n)).toBe(
            `${LOCAL_REPLICA_IMAGE_ROUTE_PREFIX}/${CANISTER_ID}/blobs/7`,
        );
    });

    it("rejects path, host-header and oversized-id injection", () => {
        const aboveU128 = 1n << 128n;

        expect(localReplicaImagePath("../../attacker", 1n)).toBeUndefined();
        expect(localReplicaImagePath("aaaaa-aa\r\nX-Test: injected", 1n)).toBeUndefined();
        expect(localReplicaImagePath(CANISTER_ID, aboveU128)).toBeUndefined();
        expect(
            parseLocalReplicaImagePath(
                `${LOCAL_REPLICA_IMAGE_ROUTE_PREFIX}/${CANISTER_ID}/blobs/55/extra`,
            ),
        ).toBeUndefined();
        expect(
            parseLocalReplicaImagePath(
                `${LOCAL_REPLICA_IMAGE_ROUTE_PREFIX}/${CANISTER_ID}/blobs/${aboveU128}`,
            ),
        ).toBeUndefined();
    });
});
