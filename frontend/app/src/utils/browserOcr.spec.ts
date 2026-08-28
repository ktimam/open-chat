import { afterEach, describe, expect, it, vi } from "vitest";
import {
    createBrowserOcrEngine,
    MAX_BROWSER_OCR_IMAGE_BYTES,
    type BrowserOcrStatus,
    type BrowserOcrWorker,
} from "./browserOcr";

type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function fakeWorker(
    recognize = vi.fn().mockResolvedValue({ data: { text: " TOTAL EGP 350 ", confidence: 91 } }),
): BrowserOcrWorker & {
    recognize: typeof recognize;
    setParameters: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
} {
    return {
        setParameters: vi.fn().mockResolvedValue(undefined),
        recognize,
        terminate: vi.fn().mockResolvedValue(undefined),
    };
}

afterEach(() => {
    vi.useRealTimers();
});

describe("browser OCR engine", () => {
    it("loads once, enables automatic page segmentation/deskew, and reuses the worker", async () => {
        let reportProgress: ((status: string, progress: number | undefined) => void) | undefined;
        const worker = fakeWorker(
            vi.fn(async () => {
                reportProgress?.("recognizing text", 0.5);
                return { data: { text: " TOTAL EGP 350 ", confidence: 91 } };
            }),
        );
        const factory = vi.fn(async (progress) => {
            reportProgress = progress;
            return worker;
        });
        const statuses: BrowserOcrStatus[] = [];
        const engine = createBrowserOcrEngine(factory, {
            available: () => true,
            idleTimeoutMs: 60_000,
            publishStatus: (status) => statuses.push(status),
        });

        await expect(engine.recognize(new Uint8Array([1, 2, 3]))).resolves.toEqual({
            kind: "ok",
            text: "TOTAL EGP 350",
            confidence: 91,
        });
        await expect(engine.recognize(new Uint8Array([4]))).resolves.toMatchObject({ kind: "ok" });

        expect(factory).toHaveBeenCalledOnce();
        expect(worker.setParameters).toHaveBeenCalledWith({
            tessedit_pageseg_mode: "3",
            preserve_interword_spaces: "1",
        });
        expect(worker.recognize).toHaveBeenCalledTimes(2);
        expect(worker.recognize).toHaveBeenCalledWith(expect.any(Blob), { rotateAuto: true });
        expect(statuses).toContainEqual({ phase: "recognizing", progress: 0 });
        expect(statuses).toContainEqual({ phase: "recognizing", progress: 0.5 });
        await engine.dispose();
        expect(worker.terminate).toHaveBeenCalledOnce();
    });

    it("serializes concurrent scans so one browser worker is never used concurrently", async () => {
        const first = deferred<{ data: { text: string; confidence: number } }>();
        let active = 0;
        let peak = 0;
        const recognize = vi.fn(async () => {
            active++;
            peak = Math.max(peak, active);
            const result =
                recognize.mock.calls.length === 1
                    ? await first.promise
                    : { data: { text: "second", confidence: 80 } };
            active--;
            return result;
        });
        const worker = fakeWorker(recognize);
        const engine = createBrowserOcrEngine(async () => worker, { available: () => true });

        const one = engine.recognize(new Uint8Array([1]));
        const two = engine.recognize(new Uint8Array([2]));
        await vi.waitFor(() => expect(recognize).toHaveBeenCalledOnce());
        first.resolve({ data: { text: "first", confidence: 80 } });

        await expect(Promise.all([one, two])).resolves.toMatchObject([
            { kind: "ok", text: "first" },
            { kind: "ok", text: "second" },
        ]);
        expect(peak).toBe(1);
        await engine.dispose();
    });

    it("bounds accepted scans to one active job and one queued job", async () => {
        const first = deferred<{ data: { text: string; confidence: number } }>();
        const recognize = vi
            .fn()
            .mockImplementationOnce(() => first.promise)
            .mockResolvedValueOnce({ data: { text: "second", confidence: 80 } });
        const worker = fakeWorker(recognize);
        const engine = createBrowserOcrEngine(async () => worker, { available: () => true });

        const one = engine.recognize(new Uint8Array([1]));
        const two = engine.recognize(new Uint8Array([2]));
        const three = engine.recognize(new Uint8Array([3]));

        await expect(three).resolves.toEqual({
            kind: "error",
            error: "The local image reader is already busy.",
        });
        await vi.waitFor(() => expect(recognize).toHaveBeenCalledOnce());
        first.resolve({ data: { text: "first", confidence: 80 } });
        await expect(Promise.all([one, two])).resolves.toMatchObject([
            { kind: "ok", text: "first" },
            { kind: "ok", text: "second" },
        ]);
        expect(recognize).toHaveBeenCalledTimes(2);
        await engine.dispose();
    });

    it("counts queue wait against each accepted scan's absolute deadline", async () => {
        vi.useFakeTimers();
        const stalled = new Promise<{ data: { text: string; confidence: number } }>(
            () => undefined,
        );
        const worker = fakeWorker(vi.fn(() => stalled));
        const factory = vi.fn().mockResolvedValue(worker);
        const engine = createBrowserOcrEngine(factory, {
            available: () => true,
            initializeTimeoutMs: 1_000,
            recognizeTimeoutMs: 1_000,
            jobTimeoutMs: 100,
        });

        const active = engine.recognize(new Uint8Array([1]));
        const queued = engine.recognize(new Uint8Array([2]));
        await vi.advanceTimersByTimeAsync(100);

        await expect(active).resolves.toEqual({
            kind: "error",
            error: "The local image reader did not finish this image in time.",
        });
        await expect(queued).resolves.toEqual({
            kind: "error",
            error: "The local image reader did not finish this image in time.",
        });
        expect(worker.recognize).toHaveBeenCalledOnce();
        expect(factory).toHaveBeenCalledOnce();
        await engine.dispose();
    });

    it("settles a stalled scan, terminates its worker, and permits a fresh retry", async () => {
        vi.useFakeTimers();
        const stalled = new Promise<{ data: { text: string; confidence: number } }>(
            () => undefined,
        );
        const first = fakeWorker(vi.fn(() => stalled));
        const second = fakeWorker();
        const factory = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
        const engine = createBrowserOcrEngine(factory, {
            available: () => true,
            recognizeTimeoutMs: 100,
        });

        const pending = engine.recognize(new Uint8Array([1]));
        await vi.advanceTimersByTimeAsync(100);
        await expect(pending).resolves.toEqual({
            kind: "error",
            error: "The local image reader did not finish this image in time.",
        });
        expect(first.terminate).toHaveBeenCalledOnce();

        await expect(engine.recognize(new Uint8Array([2]))).resolves.toMatchObject({ kind: "ok" });
        expect(factory).toHaveBeenCalledTimes(2);
        await engine.dispose();
    });

    it("terminates a worker that arrives after initialization has timed out", async () => {
        vi.useFakeTimers();
        const lateWorker = fakeWorker();
        const lateFactory = deferred<BrowserOcrWorker>();
        const engine = createBrowserOcrEngine(() => lateFactory.promise, {
            available: () => true,
            initializeTimeoutMs: 100,
        });

        const pending = engine.recognize(new Uint8Array([1]));
        await vi.advanceTimersByTimeAsync(100);
        await expect(pending).resolves.toEqual({
            kind: "error",
            error: "The local image reader did not finish loading in time.",
        });

        lateFactory.resolve(lateWorker);
        await vi.waitFor(() => expect(lateWorker.terminate).toHaveBeenCalledOnce());
        expect(lateWorker.recognize).not.toHaveBeenCalled();
        await engine.dispose();
        expect(lateWorker.terminate).toHaveBeenCalledOnce();
    });

    it("terminates an initializing worker once when its setup finishes after timeout", async () => {
        vi.useFakeTimers();
        const parameters = deferred<unknown>();
        const lateWorker = fakeWorker();
        lateWorker.setParameters.mockImplementation(() => parameters.promise);
        const engine = createBrowserOcrEngine(async () => lateWorker, {
            available: () => true,
            initializeTimeoutMs: 100,
        });

        const pending = engine.recognize(new Uint8Array([1]));
        await vi.advanceTimersByTimeAsync(100);
        await expect(pending).resolves.toEqual({
            kind: "error",
            error: "The local image reader did not finish loading in time.",
        });
        expect(lateWorker.terminate).toHaveBeenCalledOnce();

        parameters.resolve(undefined);
        await Promise.resolve();
        await Promise.resolve();
        expect(lateWorker.recognize).not.toHaveBeenCalled();
        expect(lateWorker.terminate).toHaveBeenCalledOnce();
        await engine.dispose();
    });

    it("disposes an idle worker and creates a fresh worker for the next scan", async () => {
        vi.useFakeTimers();
        const first = fakeWorker();
        const second = fakeWorker();
        const factory = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
        const engine = createBrowserOcrEngine(factory, {
            available: () => true,
            idleTimeoutMs: 100,
        });

        await expect(engine.recognize(new Uint8Array([1]))).resolves.toMatchObject({ kind: "ok" });
        await vi.advanceTimersByTimeAsync(99);
        expect(first.terminate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(first.terminate).toHaveBeenCalledOnce();

        await expect(engine.recognize(new Uint8Array([2]))).resolves.toMatchObject({ kind: "ok" });
        expect(factory).toHaveBeenCalledTimes(2);
        await engine.dispose();
        expect(first.terminate).toHaveBeenCalledOnce();
        expect(second.terminate).toHaveBeenCalledOnce();
    });

    it("discards a scan result that arrives after disposal without double-terminating", async () => {
        const result = deferred<{ data: { text: string; confidence: number } }>();
        const first = fakeWorker(vi.fn(() => result.promise));
        const second = fakeWorker();
        const factory = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
        const statuses: BrowserOcrStatus[] = [];
        const engine = createBrowserOcrEngine(factory, {
            available: () => true,
            idleTimeoutMs: 10,
            publishStatus: (status) => statuses.push(status),
        });

        const pending = engine.recognize(new Uint8Array([1]));
        await vi.waitFor(() => expect(first.recognize).toHaveBeenCalledOnce());
        await engine.dispose();
        expect(first.terminate).toHaveBeenCalledOnce();

        result.resolve({ data: { text: "private receipt contents", confidence: 99 } });
        await expect(pending).resolves.toEqual({
            kind: "error",
            error: "The local image reader was restarted.",
        });
        expect(first.terminate).toHaveBeenCalledOnce();

        await expect(engine.recognize(new Uint8Array([2]))).resolves.toMatchObject({ kind: "ok" });
        expect(factory).toHaveBeenCalledTimes(2);
        expect(statuses.at(-1)).toEqual({ phase: "idle" });
        await engine.dispose();
    });

    it("cancels already queued scans when disposed but permits a later fresh scan", async () => {
        const result = deferred<{ data: { text: string; confidence: number } }>();
        const first = fakeWorker(vi.fn(() => result.promise));
        const second = fakeWorker();
        const factory = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
        const engine = createBrowserOcrEngine(factory, { available: () => true });

        const active = engine.recognize(new Uint8Array([1]));
        const queued = engine.recognize(new Uint8Array([2]));
        await vi.waitFor(() => expect(first.recognize).toHaveBeenCalledOnce());
        await engine.dispose();
        result.resolve({ data: { text: "discard me", confidence: 99 } });

        await expect(active).resolves.toMatchObject({ kind: "error" });
        await expect(queued).resolves.toEqual({
            kind: "error",
            error: "The local image reader was restarted.",
        });
        expect(first.recognize).toHaveBeenCalledOnce();
        expect(factory).toHaveBeenCalledOnce();

        await expect(engine.recognize(new Uint8Array([3]))).resolves.toMatchObject({ kind: "ok" });
        expect(factory).toHaveBeenCalledTimes(2);
        await engine.dispose();
    });

    it("fails closed for unsupported runtimes and oversized inputs before creating a worker", async () => {
        const factory = vi.fn();
        const unavailable = createBrowserOcrEngine(factory, { available: () => false });
        await expect(unavailable.recognize(new Uint8Array([1]))).resolves.toEqual({
            kind: "unavailable",
            reason: "This browser cannot run the local image reader.",
        });

        const available = createBrowserOcrEngine(factory, { available: () => true });
        await expect(
            available.recognize(new Uint8Array(MAX_BROWSER_OCR_IMAGE_BYTES + 1)),
        ).resolves.toMatchObject({ kind: "error" });
        expect(factory).not.toHaveBeenCalled();
    });
});
