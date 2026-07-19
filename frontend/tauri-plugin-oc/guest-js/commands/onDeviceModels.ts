import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// Native bridge for the generic on-device model manager + inference (design deliverable A).
// These wrap the Rust `plugin:oc|*` commands. They only resolve in the native (Tauri) client; the app
// feature-detects the native runtime before calling them and degrades to "unavailable" otherwise.

export type ModelFileSpec = {
    url: string;
    // Expected SHA-256. Curated catalog files provide it (verified after download). Custom "add from URL"
    // files may omit it — trust-on-first-use: the hash is computed during download and returned so the
    // caller can record it, then passed back on a later re-download to verify integrity.
    sha256?: string;
    bytes: number;
    // Optional on-disk filename override (sanitised natively). Lets the caller control the stored name so
    // runtime discovery works regardless of the URL tail (e.g. force a projector to contain "mmproj").
    filename?: string;
};

export type DownloadModelRequest = {
    modelId: string;
    runtime: string;
    files: ModelFileSpec[];
};

// The SHA-256 actually observed per file. Persist these for custom (unverified) models so a later
// re-download can be integrity-checked against the first.
export type DownloadedFile = {
    url: string;
    sha256: string;
};

export type DownloadModelResponse = {
    files: DownloadedFile[];
};

export type ProbeModelUrlResponse = {
    ok: boolean;
    status?: number;
    contentLength?: number;
    contentType?: string;
    // Best-effort download filename (from Content-Disposition, else the URL's last path segment).
    filename: string;
    // Whether the server advertises byte-range support (resumable/streamable download).
    acceptsRanges: boolean;
    error?: string;
};

export type SystemResources = {
    // Free space on the volume that holds the model store.
    freeDiskBytes: number;
    totalRamBytes: number;
    availableRamBytes: number;
    cpuCount: number;
};

export type LocalModel = {
    modelId: string;
    runtime: string;
    sizeBytes: number;
    path: string;
};

export type InferRequest = {
    modelId: string;
    runtime: string;
    prompt: string;
    // Raw image bytes for vision-capable models (serialised as a byte array over the Tauri IPC).
    image?: number[];
    text?: string;
    maxTokens?: number;
    // A JSON Schema (already serialised to a string) the output should conform to.
    responseSchema?: string;
};

export type InferResponse = {
    text: string;
};

export type ModelDownloadProgress = {
    modelId: string;
    receivedBytes: number;
    totalBytes: number;
};

// Download (and, when an expected hash is given, verify) a model's files into the app's local model
// store. Idempotent per modelId. Returns the observed per-file SHA-256s so custom models can be recorded.
export async function downloadModel(
    payload: DownloadModelRequest,
): Promise<DownloadModelResponse> {
    return await invoke<DownloadModelResponse>("plugin:oc|download_model", { payload });
}

// Preflight a candidate model URL (native HEAD / ranged GET — the WebView can't, CORS blocks it): learn
// the download size, content type, filename and range support without downloading. Never rejects; a
// failed probe is reported via `ok: false` + `error`.
export async function probeModelUrl(url: string): Promise<ProbeModelUrlResponse> {
    return await invoke<ProbeModelUrlResponse>("plugin:oc|probe_model_url", { payload: { url } });
}

// Read the device's free disk / RAM / CPU headroom so the UI can warn before a model that won't fit or
// run well is downloaded.
export async function systemResources(): Promise<SystemResources> {
    return await invoke<SystemResources>("plugin:oc|system_resources");
}

export async function listLocalModels(): Promise<LocalModel[]> {
    return await invoke<LocalModel[]>("plugin:oc|list_local_models");
}

export async function deleteModel(modelId: string): Promise<void> {
    return await invoke<void>("plugin:oc|delete_model", { payload: { modelId } });
}

// Run the selected on-device model with a caller-supplied prompt. The native side loads the model into
// the matching runtime and returns the generated text.
export async function infer(payload: InferRequest): Promise<InferResponse> {
    return await invoke<InferResponse>("plugin:oc|infer", { payload });
}

// Subscribe to streamed download progress (emitted per chunk by download_model, across all models).
// Returns an unlisten function the caller should invoke on teardown.
export async function onModelDownloadProgress(
    handler: (progress: ModelDownloadProgress) => void,
): Promise<UnlistenFn> {
    return await listen<ModelDownloadProgress>("model-download-progress", (event) =>
        handler(event.payload),
    );
}
