import type { InferenceRequest, InferenceResult } from "@shared";
import { sha256 } from "@noble/hashes/sha2.js";
import { transformersWebGpuFeatureEnabled } from "../../transformersWebGpuFeatureFlag.mjs";
import { readTransformersWebGpuDevRuntimeVersion } from "./transformersWebGpuDevRuntimeVersion";
import {
    PHONE_QWEN3_VL_2B_MODEL_ID,
    TRANSFORMERS_QWEN_ARTIFACT_BYTES,
    TRANSFORMERS_QWEN_ARTIFACTS,
    TRANSFORMERS_QWEN_MODEL_ID,
    TRANSFORMERS_QWEN_REVISION,
    TRANSFORMERS_WEBGPU_ADAPTER_UNAVAILABLE_REASON,
    TRANSFORMERS_WEBGPU_CACHE_KEY,
    TRANSFORMERS_WEBGPU_MODEL_PROXY_BASE,
    TRANSFORMERS_WEBGPU_RUNTIME_ASSETS,
    type TransformersWebGpuFromWorker,
    type TransformersWebGpuProgressPhase,
    type TransformersWebGpuToWorker,
} from "./transformersWebGpuProtocol";

export interface TransformersWebGpuWorker {
    onmessage: ((event: MessageEvent<TransformersWebGpuFromWorker>) => void) | null;
    onerror: ((event: ErrorEvent) => void) | null;
    postMessage(message: TransformersWebGpuToWorker, transfer?: Transferable[]): void;
    terminate(): void;
}

export type TransformersWebGpuWorkerFactory = () => TransformersWebGpuWorker;

export type TransformersWebGpuRuntimeAvailability =
    | { available: true }
    | { available: false; reason: string };

export type TransformersWebGpuStatus = {
    phase: TransformersWebGpuProgressPhase | "idle";
    stage?: "text" | "image";
    progress?: number;
    file?: string;
};

export type TransformersWebGpuEngine = {
    infer(request: InferenceRequest): Promise<InferenceResult>;
    dispose(): Promise<void>;
};

type SpikeEligibility = {
    enabled: boolean;
    mobile: boolean;
    selectedModelId: string | undefined;
};

const DEFAULT_JOB_TIMEOUT_MS = 15 * 60_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_OUTPUT_TOKENS = 512;
const CACHE_DIGEST_HEADER = "x-content-sha256";
const RUNTIME_VERSION_HEADER = "x-openchat-runtime-version";
const RUNTIME_ASSET_HEADER = "x-openchat-runtime-asset";

let defaultCacheVerification: Promise<boolean> | undefined;
let defaultRuntimeOfflineVerification: Promise<boolean> | undefined;

export const TRANSFORMERS_WEBGPU_MODEL_NOT_DOWNLOADED_MESSAGE =
    "Qwen3-VL 2B is selected but its all-WebGPU model or runtime files are not completely downloaded. Open On-device models and tap Retry download before running an image.";

export type TransformersWebGpuArtifactCache = Pick<Cache, "match" | "put" | "delete">;
export type TransformersWebGpuArtifactCacheStorage = {
    open(name: string): Promise<TransformersWebGpuArtifactCache>;
};

export type TransformersWebGpuPreloadOptions = {
    signal?: AbortSignal;
    onProgress?: (received: number, total: number) => void;
    cacheStorage?: TransformersWebGpuArtifactCacheStorage;
    fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    baseUrl?: string;
    runtimeVersion?: string;
    /** Test seam. Production always streams and hashes the stored response body. */
    cacheBodyVerifier?: (
        response: Response,
        bytes: number,
        sha256: string,
        signal?: AbortSignal,
    ) => Promise<boolean>;
};

function runtimeVersion(explicit?: string): string {
    const developmentGeneration = readTransformersWebGpuDevRuntimeVersion(
        typeof document === "undefined" ? undefined : document,
    );
    return explicit ?? developmentGeneration ?? import.meta.env.OC_WEBSITE_VERSION ?? "development";
}

function usesDefaultReadinessDependencies(
    options: Pick<
        TransformersWebGpuPreloadOptions,
        "cacheStorage" | "baseUrl" | "runtimeVersion" | "cacheBodyVerifier" | "fetcher"
    >,
): boolean {
    return (
        options.cacheStorage === undefined &&
        options.baseUrl === undefined &&
        options.runtimeVersion === undefined &&
        options.cacheBodyVerifier === undefined &&
        options.fetcher === undefined
    );
}

/** Invalidate the per-page proof when selection/cancellation changes the underlying cache. */
export function invalidateTransformersWebGpuReadiness(): void {
    defaultCacheVerification = undefined;
    defaultRuntimeOfflineVerification = undefined;
}

function artifactUrl(path: string, baseUrl?: string): string {
    const base =
        baseUrl ??
        (typeof globalThis.location === "undefined"
            ? "http://localhost/"
            : globalThis.location.href);
    return new URL(
        `${TRANSFORMERS_WEBGPU_MODEL_PROXY_BASE}${TRANSFORMERS_QWEN_MODEL_ID}/resolve/${TRANSFORMERS_QWEN_REVISION}/${path}`,
        base,
    ).href;
}

export function transformersWebGpuRuntimeAssetUrl(
    asset: (typeof TRANSFORMERS_WEBGPU_RUNTIME_ASSETS)[number],
    baseUrl?: string,
    explicitRuntimeVersion?: string,
): string {
    const base =
        baseUrl ??
        (typeof globalThis.location === "undefined"
            ? "http://localhost/"
            : globalThis.location.href);
    const url = new URL(asset.path, base);
    if (asset.kind === "worker") url.searchParams.set("v", runtimeVersion(explicitRuntimeVersion));
    return url.href;
}

function digestHex(digest: Uint8Array): string {
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new DOMException("cancelled", "AbortError");
}

function cachedArtifactMatches(
    response: Response | undefined,
    artifact: (typeof TRANSFORMERS_QWEN_ARTIFACTS)[number],
): boolean {
    if (response === undefined || !response.ok) return false;
    return (
        Number(response.headers.get("content-length")) === artifact.bytes &&
        response.headers.get(CACHE_DIGEST_HEADER)?.toLowerCase() === artifact.sha256
    );
}

async function openArtifactCache(
    storage: TransformersWebGpuArtifactCacheStorage | undefined,
): Promise<TransformersWebGpuArtifactCache> {
    const available = storage ?? globalThis.caches;
    if (available === undefined) {
        throw new Error("This browser cannot store the all-WebGPU model files.");
    }
    return available.open(TRANSFORMERS_WEBGPU_CACHE_KEY);
}

/** True only when every pinned worker input is present under the exact cache key and digest. */
export async function transformersWebGpuModelDownloaded(
    options: Pick<
        TransformersWebGpuPreloadOptions,
        "cacheStorage" | "baseUrl" | "runtimeVersion" | "cacheBodyVerifier" | "signal"
    > = {},
): Promise<boolean> {
    const useMemo = usesDefaultReadinessDependencies(options);
    if (useMemo && defaultCacheVerification !== undefined) return defaultCacheVerification;

    const verification = (async (): Promise<boolean> => {
        try {
            const cache = await openArtifactCache(options.cacheStorage);
            const verifyBody = options.cacheBodyVerifier ?? cachedResponseBodyMatches;
            for (const artifact of TRANSFORMERS_QWEN_ARTIFACTS) {
                const url = artifactUrl(artifact.path, options.baseUrl);
                const cached = await cache.match(url);
                if (
                    !cachedArtifactMatches(cached, artifact) ||
                    !(await verifyBody(cached!, artifact.bytes, artifact.sha256, options.signal))
                ) {
                    if (cached !== undefined) await cache.delete(url).catch(() => undefined);
                    return false;
                }
            }
            for (const asset of TRANSFORMERS_WEBGPU_RUNTIME_ASSETS) {
                const url = transformersWebGpuRuntimeAssetUrl(
                    asset,
                    options.baseUrl,
                    options.runtimeVersion,
                );
                const cached = await cache.match(url);
                if (
                    !(await cachedRuntimeAssetMatches(
                        cached,
                        asset,
                        options.runtimeVersion,
                        verifyBody,
                        options.signal,
                    ))
                ) {
                    if (cached !== undefined) await cache.delete(url).catch(() => undefined);
                    return false;
                }
            }
            return true;
        } catch (error) {
            if (options.signal?.aborted === true) throw abortReason(options.signal);
            return false;
        }
    })();
    if (useMemo) defaultCacheVerification = verification;
    let verified: boolean;
    try {
        verified = await verification;
    } catch (error) {
        if (useMemo && defaultCacheVerification === verification) {
            defaultCacheVerification = undefined;
        }
        throw error;
    }
    if (useMemo && !verified && defaultCacheVerification === verification) {
        defaultCacheVerification = undefined;
    }
    return verified;
}

function signalAborted(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true;
}

async function runtimeResponseBytes(
    response: Response,
    asset: (typeof TRANSFORMERS_WEBGPU_RUNTIME_ASSETS)[number],
): Promise<{ bytes: Uint8Array; digest: string }> {
    if (!response.ok || response.body === null) {
        throw new Error(`Failed to download ${asset.path} (HTTP ${response.status}).`);
    }
    if (asset.kind === "worker") {
        const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
        if (!contentType.includes("javascript")) {
            throw new Error("The all-WebGPU worker endpoint did not return JavaScript.");
        }
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = digestHex(sha256(bytes));
    if (asset.kind === "pinned") {
        if (bytes.byteLength !== asset.bytes || digest !== asset.sha256) {
            throw new Error(`${asset.path} failed its pinned SHA-256 check.`);
        }
    } else if (bytes.byteLength < asset.minimumBytes || bytes.byteLength > asset.maximumBytes) {
        throw new Error("The all-WebGPU worker has an invalid byte count.");
    }
    return { bytes, digest };
}

async function fetchRuntimeAssetForSelection(
    fetcher: NonNullable<TransformersWebGpuPreloadOptions["fetcher"]>,
    url: string,
    signal: AbortSignal | undefined,
): Promise<{ response: Response; cacheOnly: boolean }> {
    // A cache-only lookup never reaches the network. On a miss, the selection page owns the one
    // reload fetch that primes the HTTP cache used by Worker construction and ORT's module loader.
    try {
        const cached = await fetcher(url, {
            signal,
            cache: "only-if-cached",
            mode: "same-origin",
            credentials: "same-origin",
        });
        if (cached.ok) return { response: cached, cacheOnly: true };
    } catch {
        if (signal?.aborted === true) throw abortReason(signal);
    }
    return {
        response: await fetcher(url, {
            signal,
            cache: "reload",
            mode: "same-origin",
            credentials: "same-origin",
        }),
        cacheOnly: false,
    };
}

async function preloadTransformersWebGpuRuntimeAssets(
    cache: TransformersWebGpuArtifactCache,
    options: TransformersWebGpuPreloadOptions,
): Promise<void> {
    const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    const verifyBody = options.cacheBodyVerifier ?? cachedResponseBodyMatches;
    for (const asset of TRANSFORMERS_WEBGPU_RUNTIME_ASSETS) {
        if (options.signal?.aborted === true) throw abortReason(options.signal);
        const url = transformersWebGpuRuntimeAssetUrl(
            asset,
            options.baseUrl,
            options.runtimeVersion,
        );
        const selected = await fetchRuntimeAssetForSelection(fetcher, url, options.signal);
        let response = selected.response;
        let verified: Awaited<ReturnType<typeof runtimeResponseBytes>>;
        try {
            verified = await runtimeResponseBytes(response, asset);
        } catch (error) {
            if (!selected.cacheOnly || signalAborted(options.signal)) throw error;
            // A corrupt/stale HTTP-cache entry must not trap Retry forever. Refreshing is still
            // owned by Model Manager and happens before the model can become selectable.
            response = await fetcher(url, {
                signal: options.signal,
                cache: "reload",
                mode: "same-origin",
                credentials: "same-origin",
            });
            verified = await runtimeResponseBytes(response, asset);
        }
        const { bytes, digest } = verified;
        const headers = new Headers(response.headers);
        headers.delete("content-encoding");
        headers.delete("transfer-encoding");
        headers.set("content-length", String(bytes.byteLength));
        headers.set(CACHE_DIGEST_HEADER, digest);
        headers.set(RUNTIME_ASSET_HEADER, asset.kind);
        headers.set(RUNTIME_VERSION_HEADER, runtimeVersion(options.runtimeVersion));
        const storedBytes = bytes.slice().buffer as ArrayBuffer;
        await cache.put(url, new Response(storedBytes, { status: 200, statusText: "OK", headers }));
        const stored = await cache.match(url);
        if (
            !cachedRuntimeAssetMetadataMatches(stored, asset, options.runtimeVersion) ||
            !(await verifyBody(stored!, bytes.byteLength, digest, options.signal))
        ) {
            await cache.delete(url).catch(() => undefined);
            throw new Error(`${asset.path} was not retained by browser storage.`);
        }
    }
}

/** Check the HTTP cache without permitting network access before starting an image-model worker. */
export async function transformersWebGpuRuntimeAvailableOffline(
    options: Pick<
        TransformersWebGpuPreloadOptions,
        "fetcher" | "baseUrl" | "runtimeVersion" | "cacheStorage"
    > = {},
): Promise<boolean> {
    const useMemo = usesDefaultReadinessDependencies(options);
    if (useMemo && defaultRuntimeOfflineVerification !== undefined) {
        return defaultRuntimeOfflineVerification;
    }
    const verification = (async (): Promise<boolean> => {
        const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
        try {
            const artifactCache = await openArtifactCache(options.cacheStorage);
            for (const asset of TRANSFORMERS_WEBGPU_RUNTIME_ASSETS) {
                const url = transformersWebGpuRuntimeAssetUrl(
                    asset,
                    options.baseUrl,
                    options.runtimeVersion,
                );
                const selected = await artifactCache.match(url);
                if (!cachedRuntimeAssetMetadataMatches(selected, asset, options.runtimeVersion)) {
                    return false;
                }
                const response = await fetcher(url, {
                    cache: "only-if-cached",
                    mode: "same-origin",
                    credentials: "same-origin",
                });
                const verified = await runtimeResponseBytes(response, asset);
                if (
                    verified.bytes.byteLength !== Number(selected!.headers.get("content-length")) ||
                    verified.digest !== selected!.headers.get(CACHE_DIGEST_HEADER)?.toLowerCase()
                ) {
                    return false;
                }
            }
            return true;
        } catch {
            return false;
        }
    })();
    if (useMemo) defaultRuntimeOfflineVerification = verification;
    const verified = await verification;
    if (useMemo && !verified && defaultRuntimeOfflineVerification === verification) {
        defaultRuntimeOfflineVerification = undefined;
    }
    return verified;
}

/** Stream the exact revision into the same Cache API entry the worker reads. Hashing happens while
 * CacheStorage consumes each body, so the 1.1 GB decoder shard is never materialized in memory. */
export async function preloadTransformersWebGpuModel(
    options: TransformersWebGpuPreloadOptions = {},
): Promise<void> {
    if (usesDefaultReadinessDependencies(options)) invalidateTransformersWebGpuReadiness();
    const cache = await openArtifactCache(options.cacheStorage);
    const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    const signal = options.signal;
    const onProgress = options.onProgress ?? (() => undefined);
    const verifyBody = options.cacheBodyVerifier ?? cachedResponseBodyMatches;
    let completed = 0;
    let lastPublishedAt = 0;

    try {
        await globalThis.navigator?.storage?.persist?.();
    } catch {
        // Persistence is best-effort; CacheStorage remains usable when the prompt is denied.
    }

    onProgress(0, TRANSFORMERS_QWEN_ARTIFACT_BYTES);
    for (const artifact of TRANSFORMERS_QWEN_ARTIFACTS) {
        if (signal?.aborted === true) throw abortReason(signal);
        const url = artifactUrl(artifact.path, options.baseUrl);
        const cached = await cache.match(url);
        if (
            cachedArtifactMatches(cached, artifact) &&
            (await verifyBody(cached!, artifact.bytes, artifact.sha256, signal))
        ) {
            completed += artifact.bytes;
            onProgress(completed, TRANSFORMERS_QWEN_ARTIFACT_BYTES);
            continue;
        }
        if (cached !== undefined) await cache.delete(url);

        const response = await fetcher(url, {
            signal,
            cache: "no-store",
            credentials: "same-origin",
        });
        if (!response.ok || response.body === null) {
            throw new Error(`Failed to download ${artifact.path} (HTTP ${response.status}).`);
        }
        const declared = Number(response.headers.get("content-length") ?? "0");
        const encoding = response.headers.get("content-encoding");
        if (
            Number.isFinite(declared) &&
            declared > 0 &&
            (encoding === null || encoding === "identity") &&
            declared !== artifact.bytes
        ) {
            throw new Error(`${artifact.path} changed size upstream; retry later.`);
        }

        let received = 0;
        const digest = sha256.create();
        const counted = response.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                    if (signal?.aborted === true) {
                        controller.error(abortReason(signal));
                        return;
                    }
                    received += chunk.byteLength;
                    if (received > artifact.bytes) {
                        controller.error(new Error(`${artifact.path} exceeded its pinned size.`));
                        return;
                    }
                    digest.update(chunk);
                    const now = Date.now();
                    if (now - lastPublishedAt >= 100) {
                        lastPublishedAt = now;
                        onProgress(completed + received, TRANSFORMERS_QWEN_ARTIFACT_BYTES);
                    }
                    controller.enqueue(chunk);
                },
            }),
        );
        const headers = new Headers(response.headers);
        headers.delete("content-encoding");
        headers.delete("transfer-encoding");
        headers.set("content-length", String(artifact.bytes));
        headers.set(CACHE_DIGEST_HEADER, artifact.sha256);
        headers.set("x-openchat-model-revision", TRANSFORMERS_QWEN_REVISION);

        try {
            await cache.put(url, new Response(counted, { status: 200, statusText: "OK", headers }));
        } catch (error) {
            await cache.delete(url).catch(() => undefined);
            throw error;
        }
        const got = digestHex(digest.digest());
        if (received !== artifact.bytes || got !== artifact.sha256) {
            await cache.delete(url);
            throw new Error(`${artifact.path} failed its pinned SHA-256 check.`);
        }
        const stored = await cache.match(url);
        if (
            !cachedArtifactMatches(stored, artifact) ||
            !(await verifyBody(stored!, artifact.bytes, artifact.sha256, signal))
        ) {
            await cache.delete(url);
            throw new Error(`${artifact.path} was not retained by browser storage.`);
        }
        completed += artifact.bytes;
        onProgress(completed, TRANSFORMERS_QWEN_ARTIFACT_BYTES);
    }
    // Selection is not complete until the worker plus both pinned ORT files are verified and the
    // browser HTTP cache is primed. Inference itself is cache-only and cannot download them.
    await preloadTransformersWebGpuRuntimeAssets(cache, options);
    if (
        !(await transformersWebGpuRuntimeAvailableOffline({
            fetcher: options.fetcher,
            cacheStorage: options.cacheStorage,
            baseUrl: options.baseUrl,
            runtimeVersion: options.runtimeVersion,
        }))
    ) {
        throw new Error(
            "The browser did not retain the all-WebGPU worker and ORT files. Retry download before running an image.",
        );
    }
    if (usesDefaultReadinessDependencies(options)) {
        // Every CacheStorage body and every cache-only runtime response was proved during this
        // selection attempt. Subsequent focused passes and inference jobs reuse that per-page proof.
        defaultCacheVerification = Promise.resolve(true);
    }
}

export function transformersWebGpuSpikeEnabled(): boolean {
    return transformersWebGpuFeatureEnabled({
        OC_BUILD_ENV: import.meta.env.OC_BUILD_ENV,
        OC_DFX_NETWORK: import.meta.env.OC_DFX_NETWORK,
        OC_TRANSFORMERS_WEBGPU_IMAGE_SPIKE: import.meta.env.OC_TRANSFORMERS_WEBGPU_IMAGE_SPIKE,
    });
}

function mobileBrowser(): boolean {
    if (typeof navigator === "undefined") return false;
    const hint = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData
        ?.mobile;
    return hint === true || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

/** Pure admission predicate, injectable in tests and reused by the facade and webInfer seam. */
export function shouldUseTransformersWebGpuSpike(
    _request: InferenceRequest,
    eligibility: SpikeEligibility,
): boolean {
    return (
        eligibility.enabled &&
        eligibility.mobile &&
        eligibility.selectedModelId === PHONE_QWEN3_VL_2B_MODEL_ID
    );
}

function cachedRuntimeAssetMetadataMatches(
    response: Response | undefined,
    asset: (typeof TRANSFORMERS_WEBGPU_RUNTIME_ASSETS)[number],
    explicitRuntimeVersion?: string,
): boolean {
    if (response === undefined || !response.ok) return false;
    if (response.headers.get(RUNTIME_ASSET_HEADER) !== asset.kind) return false;
    const bytes = Number(response.headers.get("content-length"));
    const digest = response.headers.get(CACHE_DIGEST_HEADER)?.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(digest ?? "")) return false;
    if (asset.kind === "pinned") return bytes === asset.bytes && digest === asset.sha256;
    return (
        bytes >= asset.minimumBytes &&
        bytes <= asset.maximumBytes &&
        response.headers.get(RUNTIME_VERSION_HEADER) === runtimeVersion(explicitRuntimeVersion)
    );
}

async function cachedRuntimeAssetMatches(
    response: Response | undefined,
    asset: (typeof TRANSFORMERS_WEBGPU_RUNTIME_ASSETS)[number],
    explicitRuntimeVersion: string | undefined,
    verifier: NonNullable<TransformersWebGpuPreloadOptions["cacheBodyVerifier"]>,
    signal?: AbortSignal,
): Promise<boolean> {
    if (!cachedRuntimeAssetMetadataMatches(response, asset, explicitRuntimeVersion)) return false;
    const bytes = Number(response!.headers.get("content-length"));
    const digest = response!.headers.get(CACHE_DIGEST_HEADER)!;
    return verifier(response!, bytes, digest, signal);
}

async function cachedResponseBodyMatches(
    response: Response,
    expectedBytes: number,
    expectedSha256: string,
    signal?: AbortSignal,
): Promise<boolean> {
    if (response.body === null) return false;
    const digest = sha256.create();
    const reader = response.body.getReader();
    let received = 0;
    try {
        while (true) {
            if (signal?.aborted === true) {
                await reader.cancel(abortReason(signal));
                throw abortReason(signal);
            }
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            if (received > expectedBytes) {
                await reader.cancel();
                return false;
            }
            digest.update(value);
        }
    } catch (error) {
        if (signal?.aborted === true) throw abortReason(signal);
        return false;
    }
    return received === expectedBytes && digestHex(digest.digest()) === expectedSha256;
}

export function transformersWebGpuSelectionCanHandle(selectedModelId: string | undefined): boolean {
    return (
        transformersWebGpuSpikeEnabled() &&
        mobileBrowser() &&
        selectedModelId === PHONE_QWEN3_VL_2B_MODEL_ID
    );
}

export function transformersWebGpuSpikeCanHandle(
    _request: InferenceRequest,
    selectedModelId: string | undefined,
): boolean {
    return transformersWebGpuSelectionCanHandle(selectedModelId);
}

export function transformersWebGpuRuntimeAvailability(): TransformersWebGpuRuntimeAvailability {
    if (globalThis.crossOriginIsolated !== true) {
        return {
            available: false,
            reason: "Accelerated image inference needs a newly opened cross-origin-isolated tab.",
        };
    }
    if (
        typeof Worker === "undefined" ||
        typeof WebAssembly === "undefined" ||
        typeof Blob === "undefined"
    ) {
        return {
            available: false,
            reason: "This browser cannot start the isolated image-model worker.",
        };
    }
    if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") {
        return {
            available: false,
            reason: "This browser cannot decode images inside the isolated model worker.",
        };
    }
    const gpu = (navigator as Navigator & { gpu?: unknown }).gpu;
    if (gpu === undefined) {
        return {
            available: false,
            reason: TRANSFORMERS_WEBGPU_ADAPTER_UNAVAILABLE_REASON,
        };
    }
    return { available: true };
}

function defaultWorkerFactory(): TransformersWebGpuWorker {
    const workerUrl = transformersWebGpuRuntimeAssetUrl(TRANSFORMERS_WEBGPU_RUNTIME_ASSETS[0]);
    return new Worker(new URL(workerUrl, import.meta.url), {
        type: "module",
        name: "openchat-transformers-webgpu",
    });
}

export function createTransformersWebGpuEngine(
    factory: TransformersWebGpuWorkerFactory = defaultWorkerFactory,
    options: {
        available?: () => TransformersWebGpuRuntimeAvailability;
        timeoutMs?: number;
        publishStatus?: (status: TransformersWebGpuStatus) => void;
    } = {},
): TransformersWebGpuEngine {
    const available = options.available ?? transformersWebGpuRuntimeAvailability;
    const timeoutMs = options.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
    const publishStatus = options.publishStatus ?? (() => undefined);

    let worker: TransformersWebGpuWorker | undefined;
    let nextRequestId = 0;
    let disposed = false;
    let queue: Promise<unknown> = Promise.resolve();
    let active:
        | {
              requestId: number;
              stage: "text" | "image";
              timer: ReturnType<typeof setTimeout>;
              settle: (result: InferenceResult) => void;
          }
        | undefined;

    const detachWorker = (candidate = worker): void => {
        if (candidate === undefined) return;
        if (worker === candidate) worker = undefined;
        candidate.onmessage = null;
        candidate.onerror = null;
        candidate.terminate();
        publishStatus({ phase: "idle" });
    };

    const settleActive = (
        candidate: TransformersWebGpuWorker,
        result: InferenceResult,
        resetRuntime: boolean,
    ): void => {
        if (worker !== candidate || active === undefined) return;
        const pending = active;
        active = undefined;
        clearTimeout(pending.timer);
        if (resetRuntime) detachWorker(candidate);
        else publishStatus({ phase: "idle" });
        pending.settle(result);
    };

    const getWorker = (): TransformersWebGpuWorker => {
        if (worker !== undefined) return worker;
        const candidate = factory();
        candidate.onmessage = (event) => {
            if (worker !== candidate) return;
            const message = event.data;
            if (message.kind === "runtime_error") {
                if (active !== undefined) {
                    settleActive(candidate, { kind: "error", error: message.error }, true);
                } else {
                    detachWorker(candidate);
                }
                return;
            }
            if (active === undefined || active.requestId !== message.requestId) return;
            switch (message.kind) {
                case "progress":
                    publishStatus({
                        phase: message.phase,
                        stage: active.stage,
                        progress: message.progress,
                        file: message.file,
                    });
                    return;
                case "result":
                    settleActive(
                        candidate,
                        message.text.length === 0
                            ? { kind: "error", error: "browser model returned no text" }
                            : { kind: "ok", text: message.text },
                        true,
                    );
                    return;
                case "unavailable":
                    settleActive(candidate, { kind: "unavailable", reason: message.reason }, true);
                    return;
                case "error":
                    settleActive(candidate, { kind: "error", error: message.error }, true);
                    return;
            }
        };
        candidate.onerror = (event) => {
            if (worker !== candidate) return;
            const error = event.message || "The isolated image-model worker stopped unexpectedly.";
            if (active !== undefined) {
                settleActive(candidate, { kind: "error", error }, true);
            } else {
                detachWorker(candidate);
            }
        };
        worker = candidate;
        return candidate;
    };

    const inferOne = (request: InferenceRequest): Promise<InferenceResult> => {
        if (disposed) {
            return Promise.resolve({ kind: "error", error: "image-model worker was disposed" });
        }
        const readiness = available();
        if (!readiness.available) {
            return Promise.resolve({ kind: "unavailable", reason: readiness.reason });
        }
        if (
            (request.image !== undefined &&
                (request.image.byteLength === 0 || request.image.byteLength > MAX_IMAGE_BYTES)) ||
            (request.maxTokens !== undefined &&
                (!Number.isInteger(request.maxTokens) ||
                    request.maxTokens < 1 ||
                    request.maxTokens > MAX_OUTPUT_TOKENS))
        ) {
            return Promise.resolve({
                kind: "error",
                error: "all-WebGPU browser request exceeds safety limits",
            });
        }

        const candidate = getWorker();
        const requestId = ++nextRequestId;
        const stage = request.image === undefined ? "text" : "image";
        const image = request.image?.slice().buffer as ArrayBuffer | undefined;
        publishStatus({ phase: "loading", stage });
        return new Promise<InferenceResult>((settle) => {
            const timer = setTimeout(() => {
                settleActive(
                    candidate,
                    {
                        kind: "error",
                        error: "The isolated browser image model did not finish in time.",
                    },
                    true,
                );
            }, timeoutMs);
            active = { requestId, stage, timer, settle };
            try {
                const message: TransformersWebGpuToWorker = {
                    kind: "infer",
                    requestId,
                    prompt: request.prompt,
                    text: request.text,
                    image,
                    maxTokens: request.maxTokens,
                };
                candidate.postMessage(message, image === undefined ? [] : [image]);
            } catch (error) {
                settleActive(
                    candidate,
                    {
                        kind: "error",
                        error: error instanceof Error ? error.message : String(error),
                    },
                    true,
                );
            }
        });
    };

    return {
        infer(request) {
            const run = queue.then(() => inferOne(request));
            queue = run.catch(() => undefined);
            return run;
        },
        async dispose() {
            disposed = true;
            if (active !== undefined && worker !== undefined) {
                settleActive(
                    worker,
                    { kind: "error", error: "image-model worker was disposed" },
                    true,
                );
            } else {
                detachWorker();
            }
            await queue.catch(() => undefined);
        },
    };
}

let defaultEngine: TransformersWebGpuEngine | undefined;
const defaultStatusListeners = new Set<(status: TransformersWebGpuStatus) => void>();

/** Observe the singleton all-WebGPU engine without exposing prompt, image, or generated content. */
export function subscribeTransformersWebGpuStatus(
    listener: (status: TransformersWebGpuStatus) => void,
): () => void {
    defaultStatusListeners.add(listener);
    listener({ phase: "idle" });
    return () => defaultStatusListeners.delete(listener);
}

function publishDefaultStatus(status: TransformersWebGpuStatus): void {
    for (const listener of defaultStatusListeners) listener(status);
}

export async function transformersWebGpuInfer(request: InferenceRequest): Promise<InferenceResult> {
    if (!(await transformersWebGpuModelDownloaded())) {
        return { kind: "error", error: TRANSFORMERS_WEBGPU_MODEL_NOT_DOWNLOADED_MESSAGE };
    }
    if (!(await transformersWebGpuRuntimeAvailableOffline())) {
        return { kind: "error", error: TRANSFORMERS_WEBGPU_MODEL_NOT_DOWNLOADED_MESSAGE };
    }
    defaultEngine ??= createTransformersWebGpuEngine(defaultWorkerFactory, {
        publishStatus: publishDefaultStatus,
    });
    return defaultEngine.infer(request);
}

export async function disposeTransformersWebGpuInference(): Promise<void> {
    const engine = defaultEngine;
    defaultEngine = undefined;
    await engine?.dispose();
}
