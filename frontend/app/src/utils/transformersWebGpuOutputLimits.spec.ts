import { describe, expect, it } from "vitest";
import {
    TRANSFORMERS_WEBGPU_MAX_OUTPUT_TOKENS,
    transformersWebGpuAdapterOutputLimit,
} from "./transformersWebGpuOutputLimits";

describe("build-owned all-WebGPU output limits", () => {
    it("keeps the Qwen limit below the global and Gemma ceilings", () => {
        expect(TRANSFORMERS_WEBGPU_MAX_OUTPUT_TOKENS).toBe(192);
        expect(transformersWebGpuAdapterOutputLimit("qwen3-vl-2b-staged-v1")).toBe(96);
        expect(transformersWebGpuAdapterOutputLimit("gemma4-e2b-row-v1")).toBe(192);
    });

    it.each(
        [undefined, null, "", "unknown", "gemma4-e2b-row-v2", 192, {}, []].map((adapter) => ({
            adapter,
        })),
    )(
        "rejects unsupported adapter $adapter instead of assigning the global ceiling",
        ({ adapter }) => {
            expect(() => transformersWebGpuAdapterOutputLimit(adapter)).toThrow(
                "Unsupported all-WebGPU adapter",
            );
        },
    );
});
