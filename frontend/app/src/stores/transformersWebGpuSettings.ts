import { get, writable } from "svelte/store";
import { TRANSFORMERS_WEBGPU_MAX_OUTPUT_TOKENS } from "../utils/transformersWebGpuOutputLimits";

export const TRANSFORMERS_WEBGPU_SETTINGS_KEY = "openchat_transformers_webgpu_runtime_settings_v1";
const TRANSFORMERS_WEBGPU_SETTINGS_VERSION = 2;
const LEGACY_MAX_OUTPUT_TOKENS = 96;

export const TRANSFORMERS_WEBGPU_MAX_OUTPUT_TOKENS_DEFAULT = TRANSFORMERS_WEBGPU_MAX_OUTPUT_TOKENS;
export const TRANSFORMERS_WEBGPU_MAX_OUTPUT_TOKEN_LIMITS = {
    min: 1,
    max: TRANSFORMERS_WEBGPU_MAX_OUTPUT_TOKENS_DEFAULT,
} as const;

type PersistedTransformersWebGpuSettings = {
    version: typeof TRANSFORMERS_WEBGPU_SETTINGS_VERSION;
    maxOutputTokens: number;
};

function clampMaxOutputTokens(
    value: unknown,
    fallback: number = TRANSFORMERS_WEBGPU_MAX_OUTPUT_TOKENS_DEFAULT,
    maximum: number = TRANSFORMERS_WEBGPU_MAX_OUTPUT_TOKEN_LIMITS.max,
): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(
        maximum,
        Math.max(TRANSFORMERS_WEBGPU_MAX_OUTPUT_TOKEN_LIMITS.min, Math.round(value)),
    );
}

function loadMaxOutputTokens(): number {
    try {
        if (typeof localStorage === "undefined") {
            return TRANSFORMERS_WEBGPU_MAX_OUTPUT_TOKENS_DEFAULT;
        }
        const raw = localStorage.getItem(TRANSFORMERS_WEBGPU_SETTINGS_KEY);
        if (raw === null) return TRANSFORMERS_WEBGPU_MAX_OUTPUT_TOKENS_DEFAULT;
        const parsed = JSON.parse(raw) as { version?: number; maxOutputTokens?: unknown };
        // An old stored ceiling is a user choice, including 96. Preserve v1's exact clamp
        // semantics; only an explicit reset adopts the new default. Loading never rewrites it.
        if (parsed.version === 1) {
            return clampMaxOutputTokens(
                parsed.maxOutputTokens,
                LEGACY_MAX_OUTPUT_TOKENS,
                LEGACY_MAX_OUTPUT_TOKENS,
            );
        }
        if (parsed.version !== TRANSFORMERS_WEBGPU_SETTINGS_VERSION) {
            return TRANSFORMERS_WEBGPU_MAX_OUTPUT_TOKENS_DEFAULT;
        }
        return clampMaxOutputTokens(parsed.maxOutputTokens);
    } catch {
        return TRANSFORMERS_WEBGPU_MAX_OUTPUT_TOKENS_DEFAULT;
    }
}

export const transformersWebGpuMaxOutputTokens = writable(loadMaxOutputTokens());

function persist(maxOutputTokens: number): void {
    try {
        if (typeof localStorage === "undefined") return;
        localStorage.setItem(
            TRANSFORMERS_WEBGPU_SETTINGS_KEY,
            JSON.stringify({
                version: TRANSFORMERS_WEBGPU_SETTINGS_VERSION,
                maxOutputTokens,
            } satisfies PersistedTransformersWebGpuSettings),
        );
    } catch {
        // Storage can be disabled or full. The in-memory cap remains usable for this tab.
    }
}

export function updateTransformersWebGpuMaxOutputTokens(value: unknown): number {
    const resolved = clampMaxOutputTokens(value);
    transformersWebGpuMaxOutputTokens.set(resolved);
    persist(resolved);
    return resolved;
}

export function resetTransformersWebGpuMaxOutputTokens(): number {
    const resolved = TRANSFORMERS_WEBGPU_MAX_OUTPUT_TOKENS_DEFAULT;
    transformersWebGpuMaxOutputTokens.set(resolved);
    try {
        if (typeof localStorage !== "undefined") {
            localStorage.removeItem(TRANSFORMERS_WEBGPU_SETTINGS_KEY);
        }
    } catch {
        // Storage can be disabled. The in-memory default is already restored.
    }
    return resolved;
}

/**
 * Intersect the global user ceiling with the selected validated catalog's model ceiling.
 * Omitted requests use that effective ceiling; a smaller caller request never expands.
 * Invalid requests remain invalid so the existing inference bridge can reject them.
 */
export function resolveTransformersWebGpuMaxOutputTokens(
    requested: number | undefined,
    configured = get(transformersWebGpuMaxOutputTokens),
    modelCap: number = TRANSFORMERS_WEBGPU_MAX_OUTPUT_TOKENS,
): number {
    if (requested !== undefined && (!Number.isSafeInteger(requested) || requested < 1)) {
        return requested;
    }
    if (
        !Number.isSafeInteger(modelCap) ||
        modelCap < 1 ||
        modelCap > TRANSFORMERS_WEBGPU_MAX_OUTPUT_TOKENS
    ) {
        return Number.NaN; // Fail closed if an unvalidated catalog limit reaches this boundary.
    }
    const cap = Math.min(clampMaxOutputTokens(configured), modelCap);
    if (requested === undefined) return cap;
    return Math.min(requested, cap);
}
