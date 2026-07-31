import type {
    InferenceRequest,
    InferenceResult,
    ModelRuntime,
    OnDeviceInferenceCapability,
} from "openchat-shared";
import { get } from "svelte/store";
import { infer as nativeInfer, listLocalModels } from "tauri-plugin-oc-api";
import { selectedModelId } from "../stores/onDeviceModels";
import { defaultModelCatalog } from "./modelCatalog";
import { isWebInferenceReady, webInfer, webModelLabel, webModelModalities } from "./webInference";

// Generic on-device inference facade (design deliverable A). This is the seam any in-client feature calls
// to run the user's selected model with its OWN prompt. It feature-detects the native runtime and degrades
// to "unavailable" in the plain web/PWA build — there is never an autonomous fallback.

// Native runtimes this build supports. The Tauri plugin integrates llama.cpp (via llama-cpp-2, the
// `inference` cargo feature) on every platform, so the facade reports the capability as available once a
// matching model is downloaded and selected.
const SUPPORTED_RUNTIMES: ModelRuntime[] = ["llama-cpp"];

// On-device inference runs wherever the Tauri native bridge is present (Android, iOS and desktop) — not
// just the mobile OS targets that `OpenChat.isNativeApp()` reports. Detect the bridge directly so the UI
// and this facade agree, and the plain web/PWA build (no bridge) degrades to "unavailable".
export function isNativeClient(): boolean {
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// Can THIS client run an on-device inference right now — natively (Tauri + llama.cpp) or in the
// BROWSER (llama.cpp-WASM over a GGUF the user attached from disk; see webInference.ts)? This is
// the gate propose flows should use: a browser with a model attached runs the model exactly like
// the native app, and only clients with NEITHER degrade to the manual-extraction fallback.
export function canInferOnDevice(): boolean {
    return isNativeClient() || isWebInferenceReady();
}

// The native llama.cpp backend is a single process-global (`LlamaBackend::init()` at the top of every
// inference) that is NOT re-entrant: two overlapping calls make the second fail with
// "BackendAlreadyInitialized", and each call also reloads the whole model. Several independent callers
// exist (AI-action extraction, the /ai command, …), so funnel every inference through one queue — at
// most one runs at a time; the rest await their turn. Failures don't break the chain.
let inferenceQueue: Promise<unknown> = Promise.resolve();

export function inferOnDevice(request: InferenceRequest): Promise<InferenceResult> {
    const run = inferenceQueue.then(() => runInference(request));
    inferenceQueue = run.catch(() => undefined);
    return run;
}

async function runInference(request: InferenceRequest): Promise<InferenceResult> {
    if (!isNativeClient() || SUPPORTED_RUNTIMES.length === 0) {
        // Browser path: a GGUF (from disk or the catalog) runs via llama.cpp-WASM — text, and images
        // too when the attached model has a vision projector. A browser with no model attached still
        // degrades to "unavailable" exactly as before.
        if (isWebInferenceReady()) {
            return webInfer(request);
        }
        return { kind: "unavailable", reason: "on-device inference requires the native client" };
    }

    const modelId = request.modelId ?? get(selectedModelId);
    if (modelId === undefined || modelId === "") {
        return { kind: "unavailable", reason: "no on-device model selected" };
    }

    try {
        const local = (await listLocalModels()).find((m) => m.modelId === modelId);
        if (local === undefined) {
            return { kind: "unavailable", reason: "the selected model is not downloaded" };
        }

        const res = await nativeInfer({
            modelId,
            runtime: local.runtime,
            prompt: request.prompt,
            image: request.image !== undefined ? Array.from(request.image) : undefined,
            text: request.text,
            maxTokens: request.maxTokens,
            responseSchema:
                request.responseSchema !== undefined
                    ? JSON.stringify(request.responseSchema)
                    : undefined,
        });
        return { kind: "ok", text: res.text };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A build without the `inference` cargo feature reports the runtime as missing. That's a capability
        // gap, not a runtime error — surface it as "unavailable" so callers degrade to their manual fallback.
        if (/inference runtime|inference.*cargo feature|compiled without/i.test(message)) {
            return { kind: "unavailable", reason: message };
        }
        return { kind: "error", error: message };
    }
}

// Tracks the model we've already kicked a warm-up for, so re-selecting the same model doesn't reload
// it. Cleared again if the warm-up didn't actually load a model, so a later attempt can retry.
let warmedModelId: string | undefined;

// Pre-load the selected model into the native cache with a throwaway 1-token inference, so the first
// REAL inference (an AI-action propose/extract, or an /ai command) doesn't pay the multi-GB cold load
// — which, with no token streaming, otherwise reads as a frozen UI. Fire-and-forget and idempotent per
// model: failures are swallowed (the real call surfaces any error), and it no-ops off the native client
// or with no model selected. Routed through the same queue, so a real inference just waits behind it.
export function prewarmSelectedModel(modelId?: string): void {
    if (!isNativeClient()) return;
    const id = modelId ?? get(selectedModelId);
    if (id === undefined || id === "" || id === warmedModelId) return;
    warmedModelId = id;
    void inferOnDevice({ modelId: id, prompt: "hi", maxTokens: 1 }).then(
        (result) => {
            // Only a real model load counts as warmed; anything else clears the marker so selecting
            // the model again (e.g. after downloading it) can retry the warm-up.
            if (result.kind !== "ok") warmedModelId = undefined;
        },
        () => {
            warmedModelId = undefined;
        },
    );
}

export function onDeviceInferenceCapability(): OnDeviceInferenceCapability {
    const selected = get(selectedModelId);
    // Modalities come from the catalog entry for the selected model (the native store doesn't track them).
    const entry = defaultModelCatalog.models.find((m) => m.id === selected);
    if (!isNativeClient() && isWebInferenceReady()) {
        // Browser model: ask the model what it can read. This used to be hardcoded to ["text"], which
        // made every browser look image-blind no matter what was attached — the UI gate downstream
        // (imageUnsupportedReason) reads nothing else, so the hardcode WAS the ban on browser vision.
        return {
            available: true,
            runtimesSupported: ["llama-cpp"],
            selectedModelId: webModelLabel(),
            selectedModalities: webModelModalities(),
        };
    }
    return {
        available: isNativeClient() && SUPPORTED_RUNTIMES.length > 0 && selected !== "",
        runtimesSupported: SUPPORTED_RUNTIMES,
        selectedModelId: selected === "" ? undefined : selected,
        selectedModalities: entry?.modalities ?? [],
    };
}
