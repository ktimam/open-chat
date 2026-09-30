import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenChatConfig } from "./config";
import { WorkerAgent, WORKER_STARTUP_REQUEST_TIMEOUT_MS } from "./workerAgent";

class FakeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: ((event: MessageEvent) => void) | null = null;
    postMessage = vi.fn();
    terminate = vi.fn();

    respond(requestKind: string, correlationId: number, response: unknown = undefined): void {
        this.onmessage?.({
            data: {
                kind: "worker_response",
                requestKind,
                correlationId,
                response,
                final: true,
            },
        } as MessageEvent);
    }
}

function config(): OpenChatConfig {
    return {
        websiteVersion: "test-version",
        logger: {
            debug: vi.fn(),
            error: vi.fn(),
            log: vi.fn(),
            warn: vi.fn(),
        },
    } as unknown as OpenChatConfig;
}

function prestartWorker(): FakeWorker {
    const worker = new FakeWorker();
    window.OC_PRESTARTED_WORKER = worker as unknown as Worker;
    return worker;
}

describe.each(["constructed", "prestarted"] as const)("WorkerAgent (%s worker)", (startup) => {
    let worker: FakeWorker;
    let constructions: number;

    beforeEach(() => {
        vi.useFakeTimers();
        window.OC_PRESTARTED_WORKER = undefined;
        worker = startup === "prestarted" ? prestartWorker() : new FakeWorker();
        constructions = 0;
        class WorkerConstructor {
            constructor() {
                constructions += 1;
                return worker;
            }
        }
        vi.stubGlobal("Worker", WorkerConstructor);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        vi.clearAllTimers();
        vi.useRealTimers();
        window.OC_PRESTARTED_WORKER = undefined;
    });

    it("forwards explicit unofficial policies while defaulting both off", () => {
        new WorkerAgent({ ...config(), existingAccountOnly: true, clientOnlyApps: true });
        expect(worker.postMessage.mock.calls[0][0]).toMatchObject({
            kind: "init",
            existingAccountOnly: true,
            clientOnlyApps: true,
        });
        worker.respond("init", 0);
        worker.postMessage.mockClear();
        new WorkerAgent(config());
        expect(worker.postMessage.mock.calls[0][0]).toMatchObject({
            kind: "init",
            existingAccountOnly: false,
            clientOnlyApps: false,
        });
        worker.respond("init", 0);
    });

    it("rejects unsupported app calls before posting them without breaking the worker", async () => {
        const onFatalError = vi.fn();
        const agent = new WorkerAgent({ ...config(), clientOnlyApps: true }, onFatalError);
        worker.respond("init", 0);
        worker.postMessage.mockClear();
        const message = { content: { kind: "action_card_content", payload: "private-marker" } };
        for (const request of [
            { kind: "modelCatalog" },
            { kind: "sendMessage", event: { event: message } },
            { kind: "editMessage", msg: message },
        ]) {
            await expect(agent.send(request as never)).rejects.toMatchObject({
                code: "client_only_app_request",
            });
        }
        expect(worker.postMessage).not.toHaveBeenCalled();
        expect(worker.terminate).not.toHaveBeenCalled();
        expect(onFatalError).not.toHaveBeenCalled();
        const later = agent.send({ kind: "setMinLogLevel", minLogLevel: "warn" });
        const request = worker.postMessage.mock.calls.at(-1)?.[0] as { correlationId: number };
        worker.respond("setMinLogLevel", request.correlationId);
        await expect(later).resolves.toBeUndefined();
    });

    it("rejects an in-flight worker_error without treating it as a fatal worker crash", async () => {
        const agent = new WorkerAgent(config());
        worker.respond("init", 0);
        const request = agent.send({ kind: "getUser" } as never);
        const sent = worker.postMessage.mock.calls.at(-1)?.[0] as { correlationId: number };
        const error = new Error("Worker has no agent to handle request: getUser");
        worker.onmessage?.({
            data: {
                kind: "worker_error",
                requestKind: "getUser",
                correlationId: sent.correlationId,
                error: JSON.stringify(error, Object.getOwnPropertyNames(error)),
            },
        } as MessageEvent);
        await expect(request).rejects.toMatchObject({ message: error.message });
        expect(worker.terminate).not.toHaveBeenCalled();

        const later = agent.send({ kind: "setMinLogLevel", minLogLevel: "warn" });
        const laterSent = worker.postMessage.mock.calls.at(-1)?.[0] as { correlationId: number };
        worker.respond("setMinLogLevel", laterSent.correlationId);
        await expect(later).resolves.toBeUndefined();
    });

    it("rejects pending and future requests when the worker script errors", async () => {
        const agent = new WorkerAgent(config());
        const pending = agent.send({ kind: "setMinLogLevel", minLogLevel: "warn" });

        expect(worker.onerror).toBeTypeOf("function");
        worker.onerror?.({ error: new Error("worker script failed") } as ErrorEvent);

        await expect(pending).rejects.toThrow("worker script failed");
        await expect(agent.send({ kind: "setMinLogLevel", minLogLevel: "warn" })).rejects.toThrow(
            "worker script failed",
        );
        expect(worker.terminate).toHaveBeenCalledOnce();
    });

    it("surfaces a synchronous worker-constructor failure without throwing from application mount", async () => {
        window.OC_PRESTARTED_WORKER = undefined;
        const failure = new DOMException("worker blocked by policy", "SecurityError");
        class FailingWorkerConstructor {
            constructor() {
                throw failure;
            }
        }
        vi.stubGlobal("Worker", FailingWorkerConstructor);
        const onFatalError = vi.fn();

        let agent: WorkerAgent | undefined;
        expect(() => {
            agent = new WorkerAgent(config(), onFatalError);
        }).not.toThrow();

        expect(onFatalError).toHaveBeenCalledOnce();
        const surfaced = onFatalError.mock.calls[0][0];
        expect(surfaced).toBeInstanceOf(Error);
        expect(surfaced.message).toContain("worker blocked by policy");
        await expect(agent!.send({ kind: "setMinLogLevel", minLogLevel: "warn" })).rejects.toBe(
            surfaced,
        );
    });

    it("routes a synchronous postMessage failure through fatal startup recovery", async () => {
        const onFatalError = vi.fn();
        const agent = new WorkerAgent(config(), onFatalError);
        worker.respond("init", 0);
        const failure = new DOMException("request could not be cloned", "DataCloneError");
        worker.postMessage.mockImplementationOnce(() => {
            throw failure;
        });

        const request = agent.send({ kind: "setMinLogLevel", minLogLevel: "warn" });

        const surfaced = onFatalError.mock.calls[0][0];
        await expect(request).rejects.toBe(surfaced);
        expect(onFatalError).toHaveBeenCalledOnce();
        expect(surfaced).toBeInstanceOf(Error);
        expect(surfaced.message).toContain("request could not be cloned");
        expect(worker.terminate).toHaveBeenCalledOnce();
        await expect(agent.send({ kind: "setMinLogLevel", minLogLevel: "warn" })).rejects.toBe(
            surfaced,
        );
    });

    it("surfaces a fatal worker crash after startup has completed", async () => {
        const onFatalError = vi.fn();
        const agent = new WorkerAgent(config(), onFatalError);
        worker.respond("init", 0);

        const auth = agent.send({
            kind: "setAuthIdentity",
            identity: undefined,
            isIIPrincipal: false,
        });
        worker.respond("setAuthIdentity", 1, { kind: "success" });
        await auth;

        const pending = agent.send({ kind: "setMinLogLevel", minLogLevel: "warn" });
        const crash = new Error("worker crashed after startup");
        worker.onerror?.({ error: crash } as ErrorEvent);

        await expect(pending).rejects.toBe(crash);
        expect(onFatalError).toHaveBeenCalledOnce();
        expect(onFatalError).toHaveBeenCalledWith(crash);
        await expect(agent.send({ kind: "setMinLogLevel", minLogLevel: "warn" })).rejects.toBe(
            crash,
        );
        expect(worker.terminate).toHaveBeenCalledOnce();
    });

    it("makes an unreadable worker response fatal for pending and future requests", async () => {
        const agent = new WorkerAgent(config());
        const pending = agent.send({ kind: "setMinLogLevel", minLogLevel: "warn" });

        expect(worker.onmessageerror).toBeTypeOf("function");
        worker.onmessageerror?.({} as MessageEvent);

        await expect(pending).rejects.toThrow("unreadable startup response");
        await expect(agent.send({ kind: "setMinLogLevel", minLogLevel: "warn" })).rejects.toThrow(
            "unreadable startup response",
        );
        expect(worker.terminate).toHaveBeenCalledOnce();
    });

    it("times out startup auth when the worker stops responding after init", async () => {
        const agent = new WorkerAgent(config());
        worker.respond("init", 0);

        const auth = agent.send({
            kind: "setAuthIdentity",
            identity: undefined,
            isIIPrincipal: false,
        });
        let failure: unknown;
        void auth.catch((error) => (failure = error));

        await vi.advanceTimersByTimeAsync(WORKER_STARTUP_REQUEST_TIMEOUT_MS - 1);
        expect(failure).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);

        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain("setAuthIdentity");
    });

    it("times out worker init when the module never responds", async () => {
        const agent = new WorkerAgent(config());

        await vi.advanceTimersByTimeAsync(WORKER_STARTUP_REQUEST_TIMEOUT_MS);

        expect(worker.terminate).toHaveBeenCalledOnce();
        await expect(agent.send({ kind: "setMinLogLevel", minLogLevel: "warn" })).rejects.toThrow(
            "init",
        );
    });

    it("the worker index.html prestarted is used instead of starting another", () => {
        const prestarted = prestartWorker();

        new WorkerAgent(config());

        expect(constructions).toBe(0);
        expect(prestarted.postMessage.mock.calls).toEqual([
            [expect.objectContaining({ kind: "init" })],
        ]);
        expect(prestarted.onmessage).toBeTypeOf("function");
        expect(prestarted.onerror).toBeTypeOf("function");
        expect(prestarted.onmessageerror).toBeTypeOf("function");
        expect(window.OC_PRESTARTED_WORKER).toBeUndefined();
        prestarted.respond("init", 0);
    });

    it("a prestarted worker is only used once", () => {
        const prestarted = prestartWorker();

        new WorkerAgent(config());
        new WorkerAgent(config());

        expect(constructions).toBe(1);
        expect(prestarted.postMessage.mock.calls).toEqual([
            [expect.objectContaining({ kind: "init" })],
        ]);
        expect(worker.postMessage.mock.calls).toEqual([
            [expect.objectContaining({ kind: "init" })],
        ]);
        prestarted.respond("init", 0);
        worker.respond("init", 0);
    });

    it("does not serialize private worker payloads to debug logs", async () => {
        const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
        const agent = new WorkerAgent(config());
        worker.respond("init", 0);
        const request = agent.send({ kind: "setMinLogLevel", minLogLevel: "warn" });
        const sent = worker.postMessage.mock.calls.at(-1)?.[0] as { correlationId: number };
        worker.respond("setMinLogLevel", sent.correlationId, { grant: "private-response-marker" });
        await request;
        worker.onmessage?.({
            data: { kind: "unknown", grant: "private-unknown-marker" },
        } as MessageEvent);

        expect(JSON.stringify(debug.mock.calls)).not.toContain("private-response-marker");
        expect(JSON.stringify(debug.mock.calls)).not.toContain("private-unknown-marker");
    });
});
