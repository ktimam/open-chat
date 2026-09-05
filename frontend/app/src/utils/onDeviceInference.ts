import type {
    InferenceRequest,
    InferenceResult,
    ModelRuntime,
    OnDeviceInferenceCapability,
} from "@shared";
import { get } from "svelte/store";
import {
    infer as nativeInfer,
    inferenceRuntimeAvailable,
    listLocalModels,
} from "tauri-plugin-oc-api";
import { selectedModelId } from "../stores/onDeviceModels";
import { prepareImageRegionForInference } from "./inferenceImage";
import {
    defaultModelCatalog,
    nativeModelInstallStatus,
    selectedNativeModelStatus,
} from "./modelCatalog";
import {
    ensureWebModelRestored,
    isWebInferenceReady,
    webInfer,
    webModelCatalogId,
    webModelLabel,
    webModelModalities,
} from "./webInference";
import {
    transformersWebGpuClientEnabled,
    transformersWebGpuSelectionCanHandle,
} from "./transformersWebGpuInference";

// Generic on-device inference facade (design deliverable A). This is the seam any in-client feature calls
// to run the user's selected model with its OWN prompt. It feature-detects the native runtime and degrades
// to "unavailable" in the plain web/PWA build — there is never an autonomous fallback.

// Native runtimes this build supports. The Tauri plugin integrates llama.cpp (via llama-cpp-2, the
// `inference` cargo feature) on every platform, so the facade reports the capability as available once a
// matching model is downloaded and selected.
const SUPPORTED_RUNTIMES: ModelRuntime[] = ["llama-cpp"];
const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_OUTPUT_TOKENS = 4096;
export const NATIVE_INFERENCE_UPDATE_REQUIRED =
    "This OpenChat build does not include on-device inference. Update or reinstall OpenChat, then try again.";
export const NATIVE_MODEL_UPDATE_REQUIRED =
    "The selected on-device model has an update required. Open On-device models and update it before trying again.";
const encodedLength = (value: string): number => new TextEncoder().encode(value).byteLength;
let lastNativeInferenceRuntimeAvailable: boolean | undefined;
let lastNativeReadyModelId: string | undefined;

// On-device inference runs wherever the Tauri native bridge is present (Android, iOS and desktop) — not
// just the mobile OS targets that `OpenChat.isNativeApp()` reports. Detect the bridge directly so the UI
// and this facade agree, and the plain web/PWA build (no bridge) degrades to "unavailable".
export function isNativeClient(): boolean {
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Browser builds use the web runtime as before. A deliberately feature-flagged Android WebView also
 * uses it, so Qwen embeddings, vision and decoding all stay on WebGPU instead of entering llama.cpp.
 * Other native clients keep the existing native-runtime route.
 */
export function usesWebInferenceRuntime(): boolean {
    return !isNativeClient() || transformersWebGpuClientEnabled();
}

function webInferenceReadyForClient(): boolean {
    return (
        isWebInferenceReady() &&
        (!isNativeClient() || transformersWebGpuSelectionCanHandle(webModelCatalogId()))
    );
}

// Can THIS client run an on-device inference right now — natively (Tauri + llama.cpp) or in the
// BROWSER (llama.cpp-WASM over a GGUF the user attached from disk; see webInference.ts)? This is
// the gate propose flows should use: a browser with a model attached runs the model exactly like
// the native app, and only clients with NEITHER degrade to the manual-extraction fallback.
async function probeNativeInferenceRuntime(): Promise<boolean> {
    let available = false;
    try {
        available = await inferenceRuntimeAvailable();
    } catch {
        // A shell without the command predates the capability contract and must fail closed.
    }
    lastNativeInferenceRuntimeAvailable = available;
    return available;
}

export type OnDeviceInferenceReadiness = {
    available: boolean;
    reason?: string;
};

// Unlike the old synchronous bridge check, this asks the exact native binary whether its optional
// runtime exists. Proposal entry points await it, so an old/dev shell cannot advertise inference
// during the gap before the actual infer command runs.
export async function onDeviceInferenceReadiness(): Promise<OnDeviceInferenceReadiness> {
    if (usesWebInferenceRuntime()) {
        await ensureWebModelRestored();
        const ready = webInferenceReadyForClient();
        return {
            available: ready,
            ...(isNativeClient() && !ready
                ? { reason: "no accelerated on-device model selected" }
                : {}),
        };
    }
    if (isNativeClient()) {
        lastNativeReadyModelId = undefined;
        if (!(await probeNativeInferenceRuntime())) {
            return { available: false, reason: NATIVE_INFERENCE_UPDATE_REQUIRED };
        }
        try {
            const selected = selectedNativeModelStatus(
                get(selectedModelId),
                await listLocalModels(),
            );
            if (selected.kind === "none") {
                return { available: false, reason: "no on-device model selected" };
            }
            if (selected.kind === "untrusted") {
                return {
                    available: false,
                    reason: "the selected model is not in the trusted catalog",
                };
            }
            if (selected.kind === "missing") {
                return { available: false, reason: "the selected model is not downloaded" };
            }
            if (selected.kind === "update_required") {
                return { available: false, reason: NATIVE_MODEL_UPDATE_REQUIRED };
            }
            lastNativeReadyModelId = selected.entry.id;
            return { available: true };
        } catch {
            return { available: false, reason: "could not read installed on-device models" };
        }
    }
    return { available: false };
}

export async function canInferOnDevice(): Promise<boolean> {
    return (await onDeviceInferenceReadiness()).available;
}

// The native llama.cpp backend is a single process-global (`LlamaBackend::init()` at the top of every
// inference) that is NOT re-entrant: two overlapping calls make the second fail with
// "BackendAlreadyInitialized", and each call also reloads the whole model. Several independent callers
// exist (AI-action extraction, the /ai command, …), so funnel every inference through one queue — at
// most one runs at a time; the rest await their turn. Failures don't break the chain.
let inferenceQueue: Promise<unknown> = Promise.resolve();

export function inferOnDevice(request: InferenceRequest): Promise<InferenceResult> {
    return enqueueInference(request);
}

export function inferOnDeviceTextOnlyNoProjector(
    request: InferenceRequest,
): Promise<InferenceResult> {
    if (request.image !== undefined) {
        return Promise.resolve({
            kind: "error",
            error: "projector-free inference accepts text only",
        });
    }
    return enqueueInference(request, { requireProjectorAbsent: true });
}

function enqueueInference(
    request: InferenceRequest,
    options: { requireProjectorAbsent?: boolean } = {},
): Promise<InferenceResult> {
    const run = inferenceQueue.then(() => runInference(request, options));
    inferenceQueue = run.catch(() => undefined);
    return run;
}

async function runInference(
    request: InferenceRequest,
    options: { requireProjectorAbsent?: boolean } = {},
): Promise<InferenceResult> {
    if (request.imageRegion !== undefined) {
        if (
            request.image === undefined ||
            request.image.byteLength === 0 ||
            request.image.byteLength > MAX_IMAGE_BYTES ||
            (request.imageRegion !== "lower_half" &&
                request.imageRegion !== "detail_card" &&
                request.imageRegion !== "lower_detail_rows")
        ) {
            return { kind: "error", error: "inference image region is invalid" };
        }
        try {
            const focusedImage = await prepareImageRegionForInference(
                request.image,
                request.imageRegion,
            );
            const { imageRegion: _imageRegion, ...withoutRegion } = request;
            request = { ...withoutRegion, image: focusedImage };
        } catch (error) {
            return {
                kind: "error",
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
    if (usesWebInferenceRuntime() || SUPPORTED_RUNTIMES.length === 0) {
        // Browser path: a GGUF (from disk or the catalog) runs via llama.cpp-WASM — text, and images
        // too when the attached model has a vision projector. A browser with no model attached still
        // degrades to "unavailable" exactly as before.
        await ensureWebModelRestored();
        if (webInferenceReadyForClient()) {
            return webInfer(request, {
                requireProjectorAbsent: options.requireProjectorAbsent === true,
            });
        }
        return {
            kind: "unavailable",
            reason: isNativeClient()
                ? "no accelerated on-device model selected"
                : "on-device inference requires the native client",
        };
    }

    // A native bridge proves only that this is a Tauri shell, not that its optional llama.cpp feature
    // was compiled in. Probe before reading model metadata so old/dev shells fail with an actionable
    // update message and never enter an inference command they cannot execute. A missing command means
    // the shell predates this probe and therefore also needs an update.
    if (!(await probeNativeInferenceRuntime())) {
        return { kind: "unavailable", reason: NATIVE_INFERENCE_UPDATE_REQUIRED };
    }

    const modelId = request.modelId ?? get(selectedModelId);
    if (modelId === undefined || modelId === "") {
        return { kind: "unavailable", reason: "no on-device model selected" };
    }
    const catalogEntry = defaultModelCatalog.models.find((model) => model.id === modelId);
    if (catalogEntry === undefined || !SUPPORTED_RUNTIMES.includes(catalogEntry.runtime)) {
        return { kind: "unavailable", reason: "the selected model is not in the trusted catalog" };
    }
    if (
        request.prompt.length === 0 ||
        encodedLength(request.prompt) > MAX_PROMPT_BYTES ||
        (request.text !== undefined && encodedLength(request.text) > MAX_TEXT_BYTES) ||
        (request.image !== undefined && request.image.byteLength > MAX_IMAGE_BYTES) ||
        (request.maxTokens !== undefined &&
            (request.maxTokens < 1 ||
                request.maxTokens > MAX_OUTPUT_TOKENS ||
                !Number.isInteger(request.maxTokens)))
    ) {
        return { kind: "error", error: "inference request exceeds native safety limits" };
    }
    let responseSchema: string | undefined;
    try {
        responseSchema =
            request.responseSchema === undefined
                ? undefined
                : JSON.stringify(request.responseSchema);
    } catch {
        return { kind: "error", error: "response schema is not serializable" };
    }
    if (responseSchema !== undefined && encodedLength(responseSchema) > MAX_SCHEMA_BYTES) {
        return { kind: "error", error: "inference request exceeds native safety limits" };
    }

    try {
        const localModels = await listLocalModels();
        const installStatus = nativeModelInstallStatus(catalogEntry, localModels);
        if (installStatus === "missing") {
            return { kind: "unavailable", reason: "the selected model is not downloaded" };
        }
        if (installStatus === "update_required") {
            return {
                kind: "unavailable",
                reason: NATIVE_MODEL_UPDATE_REQUIRED,
            };
        }
        const local = localModels.find((model) => model.modelId === modelId)!;
        const res = await nativeInfer({
            modelId,
            runtime: local.runtime,
            prompt: request.prompt,
            image: request.image !== undefined ? Array.from(request.image) : undefined,
            text: request.text,
            maxTokens: request.maxTokens,
            responseSchema,
        });
        return { kind: "ok", text: res.text };
    } catch (err) {
        return { kind: "error", error: err instanceof Error ? err.message : String(err) };
    }
}

export function onDeviceInferenceCapability(): OnDeviceInferenceCapability {
    const selected = get(selectedModelId);
    // Modalities come from the catalog entry for the selected model (the native store doesn't track them).
    const entry = defaultModelCatalog.models.find((m) => m.id === selected);
    if (usesWebInferenceRuntime()) {
        const runtime: ModelRuntime = transformersWebGpuClientEnabled()
            ? "transformers-webgpu"
            : "llama-cpp";
        if (webInferenceReadyForClient()) {
            // Browser/Android-WebView model: ask the selected runtime what it can read. The explicit
            // runtime identity prevents the APK from advertising llama.cpp while Qwen is on WebGPU.
            return {
                available: true,
                runtimesSupported: [runtime],
                selectedModelId: webModelCatalogId() ?? webModelLabel(),
                selectedModalities: webModelModalities(),
            };
        }
        if (transformersWebGpuClientEnabled()) {
            return {
                available: false,
                runtimesSupported: [runtime],
                selectedModelId: webModelCatalogId() ?? webModelLabel(),
                selectedModalities: [],
            };
        }
    }
    return {
        available:
            isNativeClient() &&
            lastNativeInferenceRuntimeAvailable === true &&
            lastNativeReadyModelId === selected &&
            entry !== undefined &&
            SUPPORTED_RUNTIMES.includes(entry.runtime),
        runtimesSupported: SUPPORTED_RUNTIMES,
        selectedModelId: selected === "" ? undefined : selected,
        selectedModalities: entry?.modalities ?? [],
    };
}
