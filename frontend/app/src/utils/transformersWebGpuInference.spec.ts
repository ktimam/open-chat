import type { InferenceRequest } from "@shared";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
    createTransformersWebGpuEngine,
    invalidateTransformersWebGpuReadiness,
    preloadTransformersWebGpuModel,
    shouldUseTransformersWebGpuSpike,
    transformersWebGpuModelDownloaded,
    transformersWebGpuRuntimeAvailableOffline,
    transformersWebGpuRuntimeAssetUrl,
    type TransformersWebGpuArtifactCache,
    type TransformersWebGpuWorker,
} from "./transformersWebGpuInference";
import {
    PHONE_QWEN3_VL_2B_MODEL_ID,
    TRANSFORMERS_QWEN_ARTIFACT_BYTES,
    TRANSFORMERS_QWEN_ARTIFACTS,
    TRANSFORMERS_QWEN_DEVICE_MAP,
    TRANSFORMERS_QWEN_MODEL_ID,
    TRANSFORMERS_QWEN_REVISION,
    TRANSFORMERS_WEBGPU_ADAPTER_UNAVAILABLE_REASON,
    TRANSFORMERS_WEBGPU_CACHE_KEY,
    TRANSFORMERS_WEBGPU_RUNTIME_ASSETS,
    TRANSFORMERS_WEBGPU_WORKER_PATH,
    type TransformersWebGpuFromWorker,
    type TransformersWebGpuToWorker,
} from "./transformersWebGpuProtocol";

function runtimeBytes(asset: (typeof TRANSFORMERS_WEBGPU_RUNTIME_ASSETS)[number]): Uint8Array {
    return asset.kind === "worker"
        ? new Uint8Array(asset.minimumBytes)
        : new Uint8Array(
              readFileSync(
                  resolve(
                      import.meta.dirname,
                      "../../../node_modules/onnxruntime-web/dist",
                      basename(asset.path),
                  ),
              ),
          );
}

function runtimeResponse(
    asset: (typeof TRANSFORMERS_WEBGPU_RUNTIME_ASSETS)[number],
    bytes = runtimeBytes(asset),
): Response {
    const body = bytes.slice().buffer as ArrayBuffer;
    return new Response(body, {
        status: 200,
        headers: {
            "content-length": String(bytes.byteLength),
            "content-type": asset.path.endsWith(".wasm") ? "application/wasm" : "text/javascript",
        },
    });
}

function runtimeCacheResponse(
    asset: (typeof TRANSFORMERS_WEBGPU_RUNTIME_ASSETS)[number],
    bytes = runtimeBytes(asset),
): Response {
    const url = new URL(transformersWebGpuRuntimeAssetUrl(asset));
    const digest = createHash("sha256").update(bytes).digest("hex");
    return new Response(null, {
        status: 200,
        headers: {
            "content-length": String(bytes.byteLength),
            "x-content-sha256": digest,
            "x-openchat-runtime-asset": asset.kind,
            "x-openchat-runtime-version": url.searchParams.get("v") ?? "development",
        },
    });
}

class FakeWorker implements TransformersWebGpuWorker {
    onmessage: ((event: MessageEvent<TransformersWebGpuFromWorker>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    readonly sent: TransformersWebGpuToWorker[] = [];
    readonly transfers: Transferable[][] = [];
    readonly terminate = vi.fn();

    postMessage(message: TransformersWebGpuToWorker, transfer: Transferable[] = []): void {
        this.sent.push(message);
        this.transfers.push(transfer);
    }

    respond(message: TransformersWebGpuFromWorker): void {
        this.onmessage?.({ data: message } as MessageEvent<TransformersWebGpuFromWorker>);
    }
}

const IMAGE_REQUEST: InferenceRequest = {
    prompt: "Return JSON",
    text: "Receipt note",
    image: new Uint8Array([1, 2, 3]),
    maxTokens: 123,
};

describe("Transformers.js Qwen WebGPU spike", () => {
    it("pins the optimized model revision and audited q4 artifact footprint", () => {
        expect(TRANSFORMERS_QWEN_MODEL_ID).toBe("onnx-community/Qwen3-VL-2B-Instruct-ONNX");
        expect(TRANSFORMERS_QWEN_REVISION).toBe("3e4136ea66ae6e07c110e64fe07da2e029517ab5");
        expect(TRANSFORMERS_QWEN_ARTIFACT_BYTES).toBe(1_534_532_835);
        expect(TRANSFORMERS_QWEN_ARTIFACTS).toHaveLength(13);
        expect(TRANSFORMERS_QWEN_ARTIFACTS).toContainEqual({
            path: "processor_config.json",
            bytes: 1_300,
            sha256: "14932921ca485d458a04dafd8069fbb0a4505622a48208d19ed247115801385b",
        });
        expect(TRANSFORMERS_QWEN_ARTIFACTS.reduce((sum, file) => sum + file.bytes, 0)).toBe(
            TRANSFORMERS_QWEN_ARTIFACT_BYTES,
        );
        expect(TRANSFORMERS_WEBGPU_CACHE_KEY).toContain("adreno-qk-f32-v1");
        expect(TRANSFORMERS_QWEN_DEVICE_MAP).toEqual({
            embed_tokens: "webgpu",
            vision_encoder: "webgpu",
            decoder_model_merged: "webgpu",
        });
        expect(TRANSFORMERS_WEBGPU_WORKER_PATH).toBe("/transformers_webgpu_worker.js");
        expect(TRANSFORMERS_WEBGPU_ADAPTER_UNAVAILABLE_REASON).toBe(
            "This browser could not provide a WebGPU adapter for the Qwen3-VL 2B runtime. The model remains selected; embeddings, vision, and decoder all require WebGPU. Retry on an up-to-date, hardware-accelerated Chrome device.",
        );
    });

    it("uses the current document's rotated development generation for the worker URL", () => {
        const meta = document.createElement("meta");
        meta.name = "openchat-transformers-webgpu-runtime-version";
        meta.content = "1000.0.123.webgpu.9";
        document.head.append(meta);
        try {
            const worker = TRANSFORMERS_WEBGPU_RUNTIME_ASSETS.find(
                (asset) => asset.kind === "worker",
            )!;
            const url = new URL(
                transformersWebGpuRuntimeAssetUrl(worker, "https://phone.tailnet.test/"),
            );
            expect(url.searchParams.get("v")).toBe("1000.0.123.webgpu.9");
        } finally {
            meta.remove();
        }
    });

    it("finishes Model Manager selection only after the worker and both ORT files are cached", async () => {
        const entries = new Map(
            TRANSFORMERS_QWEN_ARTIFACTS.map((artifact) => [
                `https://phone.tailnet.test/hf-model/${TRANSFORMERS_QWEN_MODEL_ID}/resolve/${TRANSFORMERS_QWEN_REVISION}/${artifact.path}`,
                new Response(null, {
                    status: 200,
                    headers: {
                        "content-length": String(artifact.bytes),
                        "x-content-sha256": artifact.sha256,
                    },
                }),
            ]),
        );
        const cache: TransformersWebGpuArtifactCache = {
            match: vi.fn(async (request) => entries.get(String(request))?.clone()),
            put: vi.fn(async (request, response) => {
                const bytes = await response.arrayBuffer();
                entries.set(
                    String(request),
                    new Response(bytes, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: response.headers,
                    }),
                );
            }),
            delete: vi.fn(async (request) => entries.delete(String(request))),
        };
        const storage = { open: vi.fn(async () => cache) };
        const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const asset = TRANSFORMERS_WEBGPU_RUNTIME_ASSETS.find(({ path }) =>
                String(input).includes(path),
            );
            if (asset === undefined) throw new Error(`unexpected fetch: ${String(input)}`);
            expect(init?.cache).toBe("only-if-cached");
            return runtimeResponse(asset);
        });
        const progress: { received: number; total: number }[] = [];
        const trustPrepopulatedModelBodies = vi.fn(async () => true);

        await expect(
            preloadTransformersWebGpuModel({
                cacheStorage: storage,
                baseUrl: "https://phone.tailnet.test/",
                fetcher,
                runtimeVersion: "runtime-test",
                cacheBodyVerifier: trustPrepopulatedModelBodies,
                onProgress: (received, total) => progress.push({ received, total }),
            }),
        ).resolves.toBeUndefined();
        await expect(
            transformersWebGpuModelDownloaded({
                cacheStorage: storage,
                baseUrl: "https://phone.tailnet.test/",
                runtimeVersion: "runtime-test",
                cacheBodyVerifier: trustPrepopulatedModelBodies,
            }),
        ).resolves.toBe(true);
        expect(storage.open).toHaveBeenCalledWith(TRANSFORMERS_WEBGPU_CACHE_KEY);
        expect(fetcher).toHaveBeenCalledTimes(TRANSFORMERS_WEBGPU_RUNTIME_ASSETS.length * 2);
        expect(cache.put).toHaveBeenCalledTimes(TRANSFORMERS_WEBGPU_RUNTIME_ASSETS.length);
        expect(
            fetcher.mock.calls.map(
                ([input]) =>
                    TRANSFORMERS_WEBGPU_RUNTIME_ASSETS.find(({ path }) =>
                        String(input).includes(path),
                    )?.path,
            ),
        ).toEqual([
            ...TRANSFORMERS_WEBGPU_RUNTIME_ASSETS.map(({ path }) => path),
            ...TRANSFORMERS_WEBGPU_RUNTIME_ASSETS.map(({ path }) => path),
        ]);
        expect(progress.at(-1)).toEqual({
            received: TRANSFORMERS_QWEN_ARTIFACT_BYTES,
            total: TRANSFORMERS_QWEN_ARTIFACT_BYTES,
        });

        const firstModelUrl = [...entries.keys()].find((url) =>
            url.endsWith(`/${TRANSFORMERS_QWEN_ARTIFACTS[0].path}`),
        );
        expect(firstModelUrl).toBeDefined();
        entries.delete(firstModelUrl!);
        await expect(
            transformersWebGpuModelDownloaded({
                cacheStorage: storage,
                baseUrl: "https://phone.tailnet.test/",
                runtimeVersion: "runtime-test",
                cacheBodyVerifier: trustPrepopulatedModelBodies,
            }),
        ).resolves.toBe(false);
    });

    it("does not complete selection when a downloaded runtime file is absent from the HTTP cache", async () => {
        const entries = new Map(
            TRANSFORMERS_QWEN_ARTIFACTS.map((artifact) => [
                `https://phone.tailnet.test/hf-model/${TRANSFORMERS_QWEN_MODEL_ID}/resolve/${TRANSFORMERS_QWEN_REVISION}/${artifact.path}`,
                new Response(null, {
                    status: 200,
                    headers: {
                        "content-length": String(artifact.bytes),
                        "x-content-sha256": artifact.sha256,
                    },
                }),
            ]),
        );
        const cache: TransformersWebGpuArtifactCache = {
            match: vi.fn(async (request) => entries.get(String(request))?.clone()),
            put: vi.fn(async (request, response) => {
                entries.set(
                    String(request),
                    new Response(await response.arrayBuffer(), { headers: response.headers }),
                );
            }),
            delete: vi.fn(async (request) => entries.delete(String(request))),
        };
        let runtimeFetches = 0;
        const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const asset = TRANSFORMERS_WEBGPU_RUNTIME_ASSETS.find(({ path }) =>
                String(input).includes(path),
            );
            if (asset === undefined) throw new Error("unexpected model fetch");
            runtimeFetches += 1;
            if (
                runtimeFetches > TRANSFORMERS_WEBGPU_RUNTIME_ASSETS.length &&
                init?.cache === "only-if-cached"
            ) {
                throw new TypeError("HTTP cache miss");
            }
            return runtimeResponse(asset);
        });

        await expect(
            preloadTransformersWebGpuModel({
                cacheStorage: { open: async () => cache },
                baseUrl: "https://phone.tailnet.test/",
                runtimeVersion: "runtime-test",
                fetcher,
                cacheBodyVerifier: async () => true,
            }),
        ).rejects.toThrow("did not retain the all-WebGPU worker and ORT files");
        expect(runtimeFetches).toBe(TRANSFORMERS_WEBGPU_RUNTIME_ASSETS.length + 1);
    });

    it("replaces same-size corrupt cached model bytes within one selection attempt", async () => {
        const target = TRANSFORMERS_QWEN_ARTIFACTS.find(
            ({ path }) => path === "onnx/vision_encoder_q4.onnx",
        )!;
        const replacement = new Uint8Array(
            readFileSync(
                resolve(
                    import.meta.dirname,
                    "../../model-overrides/qwen3vl2b/onnx/vision_encoder_q4.onnx",
                ),
            ),
        );
        expect(replacement.byteLength).toBe(target.bytes);
        expect(createHash("sha256").update(replacement).digest("hex")).toBe(target.sha256);

        const entries = new Map<string, Response>();
        for (const artifact of TRANSFORMERS_QWEN_ARTIFACTS) {
            const url = `https://phone.tailnet.test/hf-model/${TRANSFORMERS_QWEN_MODEL_ID}/resolve/${TRANSFORMERS_QWEN_REVISION}/${artifact.path}`;
            entries.set(
                url,
                new Response(
                    artifact.path === target.path ? new Uint8Array(artifact.bytes) : null,
                    {
                        status: 200,
                        headers: {
                            "content-length": String(artifact.bytes),
                            "x-content-sha256": artifact.sha256,
                        },
                    },
                ),
            );
        }
        const deleteCached = vi.fn(async (request: RequestInfo | URL) =>
            entries.delete(String(request)),
        );
        const cache: TransformersWebGpuArtifactCache = {
            match: vi.fn(async (request) => entries.get(String(request))?.clone()),
            put: vi.fn(async (request, response) => {
                entries.set(
                    String(request),
                    new Response(await response.arrayBuffer(), { headers: response.headers }),
                );
            }),
            delete: deleteCached,
        };
        let modelFetches = 0;
        const fetcher = vi.fn(async (input: RequestInfo | URL) => {
            if (String(input).endsWith(`/${target.path}`)) {
                modelFetches += 1;
                return new Response(replacement.slice().buffer as ArrayBuffer, {
                    status: 200,
                    headers: { "content-length": String(replacement.byteLength) },
                });
            }
            const runtime = TRANSFORMERS_WEBGPU_RUNTIME_ASSETS.find(({ path }) =>
                String(input).includes(path),
            );
            if (runtime === undefined) throw new Error(`unexpected fetch: ${String(input)}`);
            return runtimeResponse(runtime);
        });
        const verifyCachedBody = async (
            response: Response,
            bytes: number,
            sha256: string,
        ): Promise<boolean> => {
            if (bytes !== target.bytes || sha256 !== target.sha256) return true;
            const body = new Uint8Array(await response.arrayBuffer());
            return (
                body.byteLength === bytes &&
                createHash("sha256").update(body).digest("hex") === sha256
            );
        };

        await expect(
            preloadTransformersWebGpuModel({
                cacheStorage: { open: async () => cache },
                baseUrl: "https://phone.tailnet.test/",
                runtimeVersion: "runtime-test",
                fetcher,
                cacheBodyVerifier: verifyCachedBody,
            }),
        ).resolves.toBeUndefined();
        await expect(
            transformersWebGpuModelDownloaded({
                cacheStorage: { open: async () => cache },
                baseUrl: "https://phone.tailnet.test/",
                runtimeVersion: "runtime-test",
                cacheBodyVerifier: verifyCachedBody,
            }),
        ).resolves.toBe(true);
        expect(modelFetches).toBe(1);
        expect(
            deleteCached.mock.calls.some(([request]) =>
                String(request).endsWith(`/${target.path}`),
            ),
        ).toBe(true);
    });

    it("rejects and evicts same-size cached model corruption even when metadata claims the pinned digest", async () => {
        const artifact = TRANSFORMERS_QWEN_ARTIFACTS[0];
        const corrupt = new Response(new Uint8Array(artifact.bytes), {
            status: 200,
            headers: {
                "content-length": String(artifact.bytes),
                "x-content-sha256": artifact.sha256,
            },
        });
        const deleteCached = vi.fn(async (_request: RequestInfo | URL) => true);
        const cache: TransformersWebGpuArtifactCache = {
            match: vi.fn(async () => corrupt.clone()),
            put: vi.fn(async () => undefined),
            delete: deleteCached,
        };

        await expect(
            transformersWebGpuModelDownloaded({
                cacheStorage: { open: async () => cache },
                baseUrl: "https://phone.tailnet.test/",
            }),
        ).resolves.toBe(false);

        expect(deleteCached).toHaveBeenCalledOnce();
        expect(String(deleteCached.mock.calls[0][0])).toContain(artifact.path);
    });

    it("stops a large cached-body verification as soon as its owned download is backgrounded", async () => {
        const artifact = TRANSFORMERS_QWEN_ARTIFACTS[0];
        const controller = new AbortController();
        const backgrounded = new Error("backgrounded");
        const cancelled = vi.fn();
        const body = new ReadableStream<Uint8Array>({
            pull(stream) {
                stream.enqueue(new Uint8Array([1]));
                controller.abort(backgrounded);
            },
            cancel: cancelled,
        });
        const cached = new Response(body, {
            status: 200,
            headers: {
                "content-length": String(artifact.bytes),
                "x-content-sha256": artifact.sha256,
            },
        });
        const cache: TransformersWebGpuArtifactCache = {
            match: vi.fn(async () => cached),
            put: vi.fn(async () => undefined),
            delete: vi.fn(async () => true),
        };

        await expect(
            transformersWebGpuModelDownloaded({
                cacheStorage: { open: async () => cache },
                baseUrl: "https://phone.tailnet.test/",
                signal: controller.signal,
            }),
        ).rejects.toBe(backgrounded);
        expect(cancelled).toHaveBeenCalledOnce();
    });

    it("memoizes the per-page offline runtime proof and never permits a network fetch", async () => {
        invalidateTransformersWebGpuReadiness();
        const runtimeCache: TransformersWebGpuArtifactCache = {
            match: vi.fn(async (request) => {
                const asset = TRANSFORMERS_WEBGPU_RUNTIME_ASSETS.find(({ path }) =>
                    String(request).includes(path),
                );
                return asset === undefined ? undefined : runtimeCacheResponse(asset);
            }),
            put: vi.fn(async () => undefined),
            delete: vi.fn(async () => true),
        };
        const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            expect(init).toMatchObject({
                cache: "only-if-cached",
                mode: "same-origin",
                credentials: "same-origin",
            });
            return runtimeResponse(
                TRANSFORMERS_WEBGPU_RUNTIME_ASSETS[fetcher.mock.calls.length - 1],
            );
        });
        vi.stubGlobal("fetch", fetcher);
        vi.stubGlobal("caches", { open: vi.fn(async () => runtimeCache) });

        try {
            await expect(transformersWebGpuRuntimeAvailableOffline()).resolves.toBe(true);
            await expect(transformersWebGpuRuntimeAvailableOffline()).resolves.toBe(true);
            expect(fetcher).toHaveBeenCalledTimes(TRANSFORMERS_WEBGPU_RUNTIME_ASSETS.length);
            expect(fetcher.mock.calls.every(([, init]) => init?.cache !== "reload")).toBe(true);
        } finally {
            invalidateTransformersWebGpuReadiness();
            vi.unstubAllGlobals();
        }
    });

    it("rejects a same-size worker HTTP-cache body that differs from the selection-time digest", async () => {
        const worker = TRANSFORMERS_WEBGPU_RUNTIME_ASSETS[0];
        const selectedWorker = runtimeBytes(worker);
        const staleWorker = selectedWorker.slice();
        staleWorker[staleWorker.byteLength - 1] = 1;
        const runtimeCache: TransformersWebGpuArtifactCache = {
            match: vi.fn(async (request) => {
                const asset = TRANSFORMERS_WEBGPU_RUNTIME_ASSETS.find(({ path }) =>
                    String(request).includes(path),
                );
                return asset === undefined
                    ? undefined
                    : runtimeCacheResponse(
                          asset,
                          asset.kind === "worker" ? selectedWorker : runtimeBytes(asset),
                      );
            }),
            put: vi.fn(async () => undefined),
            delete: vi.fn(async () => true),
        };
        const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            expect(init?.cache).toBe("only-if-cached");
            const asset = TRANSFORMERS_WEBGPU_RUNTIME_ASSETS.find(({ path }) =>
                String(input).includes(path),
            );
            if (asset === undefined) throw new Error("unexpected runtime URL");
            return runtimeResponse(
                asset,
                asset.kind === "worker" ? staleWorker : runtimeBytes(asset),
            );
        });

        await expect(
            transformersWebGpuRuntimeAvailableOffline({
                cacheStorage: { open: async () => runtimeCache },
                baseUrl: "https://phone.tailnet.test/",
                fetcher,
            }),
        ).resolves.toBe(false);
        expect(fetcher).toHaveBeenCalledOnce();
    });

    it("admits image and text only for the explicit mobile all-WebGPU selection", () => {
        const eligible = {
            enabled: true,
            mobile: true,
            selectedModelId: PHONE_QWEN3_VL_2B_MODEL_ID,
        };
        expect(shouldUseTransformersWebGpuSpike(IMAGE_REQUEST, eligible)).toBe(true);
        expect(shouldUseTransformersWebGpuSpike({ prompt: "text only" }, eligible)).toBe(true);
        expect(
            shouldUseTransformersWebGpuSpike(IMAGE_REQUEST, { ...eligible, enabled: false }),
        ).toBe(false);
        expect(
            shouldUseTransformersWebGpuSpike(IMAGE_REQUEST, { ...eligible, mobile: false }),
        ).toBe(false);
        expect(
            shouldUseTransformersWebGpuSpike(IMAGE_REQUEST, {
                ...eligible,
                selectedModelId: "some-other-model",
            }),
        ).toBe(false);
    });

    it("creates a one-shot worker lazily, transfers an exact image copy, and releases it on success", async () => {
        const worker = new FakeWorker();
        const factory = vi.fn(() => worker);
        const engine = createTransformersWebGpuEngine(factory, {
            available: () => ({ available: true }),
            timeoutMs: 10_000,
        });

        const pending = engine.infer(IMAGE_REQUEST);
        await vi.waitFor(() => expect(worker.sent).toHaveLength(1));
        const sent = worker.sent[0];
        expect(sent).toMatchObject({
            kind: "infer",
            prompt: "Return JSON",
            text: "Receipt note",
            maxTokens: 123,
        });
        expect(sent.kind === "infer" && [...new Uint8Array(sent.image!)]).toEqual([1, 2, 3]);
        expect(worker.transfers[0]).toEqual([sent.kind === "infer" ? sent.image : undefined]);
        worker.respond({ kind: "result", requestId: sent.requestId, text: '{"amount":3}' });

        await expect(pending).resolves.toEqual({ kind: "ok", text: '{"amount":3}' });
        expect(factory).toHaveBeenCalledOnce();
        expect(worker.terminate).toHaveBeenCalledOnce();
        await engine.dispose();
        expect(worker.terminate).toHaveBeenCalledOnce();
    });

    it("sends text without caller pixels so the worker can author its neutral vision frame", async () => {
        const worker = new FakeWorker();
        const statuses: unknown[] = [];
        const engine = createTransformersWebGpuEngine(() => worker, {
            available: () => ({ available: true }),
            timeoutMs: 10_000,
            publishStatus: (status) => statuses.push(status),
        });

        const pending = engine.infer({ prompt: "verify text only", maxTokens: 32 });
        await vi.waitFor(() => expect(worker.sent).toHaveLength(1));
        const sent = worker.sent[0];
        expect(sent).toMatchObject({
            kind: "infer",
            prompt: "verify text only",
            image: undefined,
        });
        expect(worker.transfers[0]).toEqual([]);
        expect(statuses).toContainEqual({ phase: "loading", stage: "text" });
        worker.respond({ kind: "progress", requestId: sent.requestId, phase: "inference" });
        expect(statuses).toContainEqual({
            phase: "inference",
            stage: "text",
            progress: undefined,
            file: undefined,
        });
        worker.respond({ kind: "result", requestId: sent.requestId, text: "verified" });
        await expect(pending).resolves.toEqual({ kind: "ok", text: "verified" });
    });

    it("uses a fresh worker after every successful image job", async () => {
        const first = new FakeWorker();
        const second = new FakeWorker();
        const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
        const engine = createTransformersWebGpuEngine(factory, {
            available: () => ({ available: true }),
            timeoutMs: 10_000,
        });

        const one = engine.infer(IMAGE_REQUEST);
        await vi.waitFor(() => expect(first.sent).toHaveLength(1));
        first.respond({
            kind: "result",
            requestId: first.sent[0].requestId,
            text: "first result",
        });
        await expect(one).resolves.toEqual({ kind: "ok", text: "first result" });
        expect(first.terminate).toHaveBeenCalledOnce();

        const two = engine.infer({ ...IMAGE_REQUEST, prompt: "second" });
        await vi.waitFor(() => expect(second.sent).toHaveLength(1));
        second.respond({
            kind: "result",
            requestId: second.sent[0].requestId,
            text: "second result",
        });
        await expect(two).resolves.toEqual({ kind: "ok", text: "second result" });
        expect(factory).toHaveBeenCalledTimes(2);
        expect(second.terminate).toHaveBeenCalledOnce();
        await engine.dispose();
    });

    it("serializes jobs and recovers with a new worker after a runtime error", async () => {
        const first = new FakeWorker();
        const second = new FakeWorker();
        const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
        const engine = createTransformersWebGpuEngine(factory, {
            available: () => ({ available: true }),
            timeoutMs: 10_000,
        });

        const one = engine.infer(IMAGE_REQUEST);
        const two = engine.infer({ ...IMAGE_REQUEST, prompt: "second" });
        await vi.waitFor(() => expect(first.sent).toHaveLength(1));
        expect(first.sent).toHaveLength(1);
        const firstId = first.sent[0].requestId;
        first.respond({ kind: "error", requestId: firstId, error: "GPU device was lost" });
        await expect(one).resolves.toEqual({ kind: "error", error: "GPU device was lost" });
        expect(first.terminate).toHaveBeenCalledOnce();

        await vi.waitFor(() => expect(second.sent).toHaveLength(1));
        const secondId = second.sent[0].requestId;
        second.respond({ kind: "result", requestId: secondId, text: "second result" });
        await expect(two).resolves.toEqual({ kind: "ok", text: "second result" });
        expect(factory).toHaveBeenCalledTimes(2);
        expect(second.terminate).toHaveBeenCalledOnce();
        await engine.dispose();
    });

    it("fails before worker creation when the browser cannot supply the required APIs", async () => {
        const factory = vi.fn();
        const engine = createTransformersWebGpuEngine(factory, {
            available: () => ({
                available: false,
                reason: "This browser could not provide a WebGPU adapter.",
            }),
        });

        await expect(engine.infer(IMAGE_REQUEST)).resolves.toEqual({
            kind: "unavailable",
            reason: "This browser could not provide a WebGPU adapter.",
        });
        expect(factory).not.toHaveBeenCalled();
        await engine.dispose();
    });
});
