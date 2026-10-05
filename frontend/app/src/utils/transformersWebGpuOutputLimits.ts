/** Global user ceiling, not an unconditional generation budget for every adapter. */
export const TRANSFORMERS_WEBGPU_MAX_OUTPUT_TOKENS = 192;

/** Build-owned safety limits. Catalogs may reduce, but never expand, these budgets. */
export function transformersWebGpuAdapterOutputLimit(adapter: unknown): number {
    switch (adapter) {
        case "qwen3-vl-2b-staged-v1":
            return 96;
        case "gemma4-e2b-row-v1":
            return TRANSFORMERS_WEBGPU_MAX_OUTPUT_TOKENS;
        default:
            throw new Error("Unsupported all-WebGPU adapter output limit.");
    }
}
