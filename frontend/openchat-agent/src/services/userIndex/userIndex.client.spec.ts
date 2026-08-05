import { describe, expect, it } from "vitest";
import { MAX_AI_APP_LOOKUPS_PER_CLIENT_CALL, boundedAiAppLookupBatches } from "./userIndex.client";

describe("boundedAiAppLookupBatches", () => {
    it("accepts zero and splits the exact aggregate limit into backend-sized batches", () => {
        expect(boundedAiAppLookupBatches([])).toEqual([]);
        const lookups = Array.from({ length: MAX_AI_APP_LOOKUPS_PER_CLIENT_CALL }, (_, appId) => ({
            appId,
            revision: BigInt(appId),
        }));
        const batches = boundedAiAppLookupBatches(lookups);
        expect(batches).toHaveLength(4);
        expect(batches.every((batch) => batch.length === 8)).toBe(true);
        expect(batches.flat()).toEqual(lookups);
    });

    it("rejects one over the aggregate limit before creating requests", () => {
        const lookups = Array.from(
            { length: MAX_AI_APP_LOOKUPS_PER_CLIENT_CALL + 1 },
            (_, appId) => ({ appId }),
        );
        expect(() => boundedAiAppLookupBatches(lookups)).toThrow(/limited to 32/);
    });

    it("deduplicates an app id even when duplicates would cross a batch boundary", () => {
        const lookups = [
            ...Array.from({ length: 8 }, (_, appId) => ({ appId })),
            { appId: 0, revision: 99n },
            { appId: 8 },
        ];
        expect(boundedAiAppLookupBatches(lookups)).toEqual([
            Array.from({ length: 8 }, (_, appId) => ({ appId })),
            [{ appId: 8 }],
        ]);
    });
});
