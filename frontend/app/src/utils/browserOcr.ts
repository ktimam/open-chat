import { writable } from "svelte/store";

const ASSET_BASE = "/assets/local-extractor/v7.0.0";
export const BROWSER_OCR_LANGUAGES = "eng";
export const BROWSER_OCR_SEMANTIC_LANGUAGES = "ara+eng";
export const MAX_BROWSER_OCR_IMAGE_BYTES = 5 * 1024 * 1024;
export const BROWSER_OCR_INITIALIZE_TIMEOUT_MS = 120_000;
export const BROWSER_OCR_RECOGNIZE_TIMEOUT_MS = 30_000;
export const BROWSER_OCR_JOB_TIMEOUT_MS = 45_000;
export const BROWSER_OCR_IDLE_TIMEOUT_MS = 60_000;
const MAX_OCR_TEXT_CHARS = 64 * 1024;
const MAX_PENDING_OCR_JOBS = 2;

export type BrowserOcrStatus = {
    phase: "idle" | "loading" | "recognizing";
    progress?: number;
};

export type BrowserOcrResult =
    | { kind: "ok"; text: string; confidence: number }
    | { kind: "unavailable"; reason: string }
    | { kind: "error"; error: string };

export interface BrowserOcrWorker {
    setParameters(parameters: Record<string, string>): Promise<unknown>;
    recognize(
        image: Blob,
        options: { rotateAuto: boolean },
    ): Promise<{ data: { text: string; confidence: number } }>;
    terminate(): Promise<unknown>;
}

export type BrowserOcrWorkerFactory = (
    progress: (status: string, progress: number | undefined) => void,
) => Promise<BrowserOcrWorker>;

export type BrowserOcrEngine = {
    recognize(image: Uint8Array): Promise<BrowserOcrResult>;
    dispose(): Promise<void>;
};

export const browserOcrStatus = writable<BrowserOcrStatus>({ phase: "idle" });

const OCR_PARAMETERS = {
    tessedit_pageseg_mode: "3",
    preserve_interword_spaces: "1",
} as const;
export function browserOcrAvailable(): boolean {
    return (
        typeof window !== "undefined" &&
        typeof Worker !== "undefined" &&
        typeof WebAssembly !== "undefined" &&
        typeof Blob !== "undefined"
    );
}

function workerFactoryForLanguages(languages: string): BrowserOcrWorkerFactory {
    return async (progress) => {
        const loaded = (await import("tesseract.js")) as unknown as {
            createWorker?: (...args: unknown[]) => Promise<BrowserOcrWorker>;
            default?: { createWorker?: (...args: unknown[]) => Promise<BrowserOcrWorker> };
        };
        const createWorker = loaded.createWorker ?? loaded.default?.createWorker;
        if (createWorker === undefined) throw new Error("OCR runtime is unavailable");
        // Keep Latin money and multilingual semantics in separate recognitions. A combined RTL/LTR
        // pass once reordered `13,500 EGP` into a grounded-but-wrong `500`, so only the English
        // primary pass may provide money/date/note. The Arabic+English worker is loaded solely when
        // required transaction semantics are missing, and its transcript is never concatenated.
        return createWorker(languages, 1, {
            workerPath: `${ASSET_BASE}/worker.min.js`,
            corePath: `${ASSET_BASE}/core`,
            langPath: `${ASSET_BASE}/lang`,
            cachePath: "local-extractor-v7.0.0",
            cacheMethod: "write",
            gzip: true,
            logger: (update: { status?: unknown; progress?: unknown }) =>
                progress(
                    typeof update.status === "string" ? update.status : "loading OCR",
                    typeof update.progress === "number" && Number.isFinite(update.progress)
                        ? Math.max(0, Math.min(1, update.progress))
                        : undefined,
                ),
        });
    };
}

const defaultWorkerFactory = workerFactoryForLanguages(BROWSER_OCR_LANGUAGES);
const semanticWorkerFactory = workerFactoryForLanguages(BROWSER_OCR_SEMANTIC_LANGUAGES);

function stageTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createBrowserOcrEngine(
    factory: BrowserOcrWorkerFactory = defaultWorkerFactory,
    options: {
        initializeTimeoutMs?: number;
        recognizeTimeoutMs?: number;
        jobTimeoutMs?: number;
        idleTimeoutMs?: number;
        available?: () => boolean;
        publishStatus?: (status: BrowserOcrStatus) => void;
    } = {},
): BrowserOcrEngine {
    const initializeTimeoutMs = options.initializeTimeoutMs ?? BROWSER_OCR_INITIALIZE_TIMEOUT_MS;
    const recognizeTimeoutMs = options.recognizeTimeoutMs ?? BROWSER_OCR_RECOGNIZE_TIMEOUT_MS;
    const jobTimeoutMs = options.jobTimeoutMs ?? BROWSER_OCR_JOB_TIMEOUT_MS;
    const idleTimeoutMs = options.idleTimeoutMs ?? BROWSER_OCR_IDLE_TIMEOUT_MS;
    const available = options.available ?? browserOcrAvailable;
    const publishStatus = options.publishStatus ?? ((status) => browserOcrStatus.set(status));

    let worker: BrowserOcrWorker | undefined;
    let workerPromise: Promise<BrowserOcrWorker> | undefined;
    let generation = 0;
    let disposalEpoch = 0;
    let queue: Promise<unknown> = Promise.resolve();
    let pendingJobs = 0;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimerGeneration = 0;
    const terminations = new WeakMap<BrowserOcrWorker, Promise<void>>();

    const terminateWorker = (candidate: BrowserOcrWorker | undefined): Promise<void> => {
        if (candidate === undefined) return Promise.resolve();
        const pending = terminations.get(candidate);
        if (pending !== undefined) return pending;
        const termination = candidate
            .terminate()
            .then(() => undefined)
            .catch(() => undefined);
        terminations.set(candidate, termination);
        return termination;
    };

    const safeTerminate = (candidate: BrowserOcrWorker | undefined): void => {
        void terminateWorker(candidate);
    };

    const cancelIdleDisposal = (): void => {
        idleTimerGeneration++;
        clearTimeout(idleTimer);
        idleTimer = undefined;
    };

    const detachWorker = (): BrowserOcrWorker | undefined => {
        generation++;
        cancelIdleDisposal();
        const detached = worker;
        worker = undefined;
        workerPromise = undefined;
        publishStatus({ phase: "idle" });
        return detached;
    };

    const scheduleIdleDisposal = (candidate: BrowserOcrWorker, owner: number): void => {
        cancelIdleDisposal();
        const timerOwner = idleTimerGeneration;
        idleTimer = setTimeout(() => {
            idleTimer = undefined;
            if (
                timerOwner === idleTimerGeneration &&
                worker === candidate &&
                generation === owner
            ) {
                safeTerminate(detachWorker());
            }
        }, idleTimeoutMs);
    };

    const remainingBudget = (
        deadline: number,
        stageLimitMs: number,
        stageMessage: string,
    ): { timeoutMs: number; message: string } => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            throw new Error("The local image reader did not finish this image in time.");
        }
        return remaining < stageLimitMs
            ? {
                  timeoutMs: remaining,
                  message: "The local image reader did not finish this image in time.",
              }
            : { timeoutMs: stageLimitMs, message: stageMessage };
    };

    const getWorker = async (deadline: number): Promise<BrowserOcrWorker> => {
        if (worker !== undefined) return worker;
        if (workerPromise !== undefined) return workerPromise;

        const initializationBudget = remainingBudget(
            deadline,
            initializeTimeoutMs,
            "The local image reader did not finish loading in time.",
        );

        const owner = ++generation;
        publishStatus({ phase: "loading" });
        let candidate: BrowserOcrWorker | undefined;
        const setup = factory((status, progress) => {
            if (owner !== generation) return;
            publishStatus({
                phase: status.startsWith("recognizing") ? "recognizing" : "loading",
                progress,
            });
        }).then(async (created) => {
            candidate = created;
            await created.setParameters(OCR_PARAMETERS);
            return created;
        });

        const pending = stageTimeout(
            setup,
            initializationBudget.timeoutMs,
            initializationBudget.message,
        )
            .then((created) => {
                if (owner !== generation) {
                    safeTerminate(created);
                    throw new Error("The local image reader was restarted.");
                }
                worker = created;
                publishStatus({ phase: "idle" });
                return created;
            })
            .catch((error) => {
                if (owner === generation) {
                    generation++;
                    workerPromise = undefined;
                    publishStatus({ phase: "idle" });
                }
                if (candidate !== undefined) safeTerminate(candidate);
                else void setup.then(safeTerminate).catch(() => undefined);
                throw error;
            });
        workerPromise = pending;
        return pending;
    };

    const recognizeOne = async (image: Uint8Array, deadline: number): Promise<BrowserOcrResult> => {
        let active: BrowserOcrWorker | undefined;
        let owner: number | undefined;
        try {
            cancelIdleDisposal();
            active = await getWorker(deadline);
            if (worker !== active) throw new Error("The local image reader was restarted.");
            owner = generation;
            publishStatus({ phase: "recognizing", progress: 0 });
            const bytes = image.slice().buffer as ArrayBuffer;
            const recognitionBudget = remainingBudget(
                deadline,
                recognizeTimeoutMs,
                "The local image reader did not finish this image in time.",
            );
            const result = await stageTimeout(
                active.recognize(new Blob([bytes]), { rotateAuto: true }),
                recognitionBudget.timeoutMs,
                recognitionBudget.message,
            );
            if (worker !== active || generation !== owner) {
                throw new Error("The local image reader was restarted.");
            }
            publishStatus({ phase: "idle" });
            scheduleIdleDisposal(active, owner);
            return {
                kind: "ok",
                text: result.data.text.trim().slice(0, MAX_OCR_TEXT_CHARS),
                confidence: Number.isFinite(result.data.confidence) ? result.data.confidence : 0,
            };
        } catch (error) {
            const stale = active !== undefined && (worker !== active || generation !== owner);
            if (active !== undefined && worker === active && generation === owner) {
                safeTerminate(detachWorker());
            } else {
                safeTerminate(active);
            }
            return {
                kind: "error",
                error: stale
                    ? "The local image reader was restarted."
                    : error instanceof Error
                      ? error.message
                      : String(error),
            };
        }
    };

    return {
        recognize(image) {
            if (!available()) {
                return Promise.resolve({
                    kind: "unavailable" as const,
                    reason: "This browser cannot run the local image reader.",
                });
            }
            if (image.byteLength === 0 || image.byteLength > MAX_BROWSER_OCR_IMAGE_BYTES) {
                return Promise.resolve({
                    kind: "error" as const,
                    error: `The image must be between 1 byte and ${MAX_BROWSER_OCR_IMAGE_BYTES} bytes.`,
                });
            }
            if (pendingJobs >= MAX_PENDING_OCR_JOBS) {
                return Promise.resolve({
                    kind: "error" as const,
                    error: "The local image reader is already busy.",
                });
            }

            const acceptedEpoch = disposalEpoch;
            const acceptedImage = image.slice();
            const deadline = Date.now() + jobTimeoutMs;
            pendingJobs++;
            const run = queue
                .then(() =>
                    acceptedEpoch === disposalEpoch
                        ? recognizeOne(acceptedImage, deadline)
                        : {
                              kind: "error" as const,
                              error: "The local image reader was restarted.",
                          },
                )
                .finally(() => pendingJobs--);
            queue = run.catch(() => undefined);
            return run;
        },
        async dispose() {
            disposalEpoch++;
            const detached = detachWorker();
            await terminateWorker(detached);
        },
    };
}

const browserOcrEngine = createBrowserOcrEngine();
const browserSemanticOcrEngine = createBrowserOcrEngine(semanticWorkerFactory);

export function recognizeBrowserImage(image: Uint8Array): Promise<BrowserOcrResult> {
    return browserOcrEngine.recognize(image);
}

/** Arabic+English fallback used solely as bounded semantic evidence after English parsing fails. */
export function recognizeBrowserSemanticImage(image: Uint8Array): Promise<BrowserOcrResult> {
    return browserSemanticOcrEngine.recognize(image);
}

export async function disposeBrowserOcr(): Promise<void> {
    await Promise.all([browserOcrEngine.dispose(), browserSemanticOcrEngine.dispose()]);
}
