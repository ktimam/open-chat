import type {
    FromWorker,
    Init,
    Logger,
    SyncHead,
    WorkerError,
    WorkerRequest,
    WorkerResponse,
    WorkerResult,
} from "@shared";
import { ONE_MINUTE_MILLIS, Stream, publish, requiresLogout } from "@shared";
import type { OpenChatConfig } from "./config";
import { assertUnofficialApiRequestAllowed } from "@shared/utils/unofficialApiPolicy";
import { snapshot } from "./snapshot.svelte";
import { messagesRead, storageStore } from "./state";
import { userStore } from "./state/users/state";
import { withPausedStores } from "./utils/stores";

export const WORKER_STARTUP_REQUEST_TIMEOUT_MS = 30_000;

const STARTUP_REQUEST_KINDS = new Set<WorkerRequest["kind"]>([
    "init",
    "setAuthIdentity",
    "createOpenChatIdentity",
]);

export class WorkerAgent {
    readonly #worker: Worker | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly #inflightRequests: Map<number, PromiseResolver<any>> = new Map();
    readonly #logger: Logger;
    readonly #clientOnlyApps: boolean;
    readonly #onFatalError: ((error: Error) => void) | undefined;
    #fatalError: Error | undefined;
    #sessionExpired = false;
    nextCorrelationId: number = 0;

    // `onSyncHead` is passed in rather than published on the global pubsub because the only
    // listener is the OpenChat instance that owns this agent: routing it globally would keep a
    // discarded instance alive for the lifetime of the page.
    constructor(
        config: OpenChatConfig,
        onFatalError?: (error: Error) => void,
        onSyncHead: (head: SyncHead) => void = () => {},
    ) {
        console.debug("WORKER_CLIENT: loading worker with version: ", config.websiteVersion);
        this.#logger = config.logger;
        this.#clientOnlyApps = config.clientOnlyApps === true;
        this.#onFatalError = onFatalError;

        const workerUrl = `/worker.js?v=${config.websiteVersion}`;
        let worker: Worker;
        try {
            worker = new Worker(new URL(workerUrl, import.meta.url), {
                type: "module",
            });
            this.#worker = worker;
        } catch (error) {
            this.#failWorker(workerFailure(error, "OpenChat worker could not be created"));
            return;
        }

        worker.onmessage = (ev: MessageEvent<FromWorker>) => {
            if (!ev.data) {
                console.debug("WORKER_CLIENT: event message with no data received");
                return;
            }

            const data = ev.data;

            if (data.kind === "worker_event") {
                if (data.event.subkind === "messages_read_from_server") {
                    const { chatId, readByMeUpTo, threadsRead, dateReadPinned } = data.event;
                    withPausedStores(() => {
                        messagesRead.syncWithServer(
                            chatId,
                            readByMeUpTo,
                            threadsRead,
                            dateReadPinned,
                        );
                    });
                }
                if (data.event.subkind === "storage_updated") {
                    storageStore.set(data.event.status);
                }
                if (data.event.subkind === "users_loaded") {
                    userStore.addMany(data.event.users);
                }
                if (data.event.subkind === "sync_head") {
                    onSyncHead({ userId: data.event.userId, version: data.event.version });
                }
            } else if (data.kind === "worker_response") {
                // Responses can contain short-lived app-card grants/capabilities. Log only routing
                // metadata; never serialize the event or response body into developer/remote logs.
                console.debug("WORKER_CLIENT: response", data.requestKind, data.correlationId);
                this.#resolveResponse(data);
            } else if (data.kind === "worker_error") {
                console.debug("WORKER_CLIENT: error", data.requestKind, data.correlationId);
                this.#resolveError(data);
            } else {
                // Never serialize an unexpected worker event: a malformed response could still carry
                // an app-card capability/grant in its data. The category is sufficient diagnostics.
                console.debug("WORKER_CLIENT: unknown message");
            }
        };

        worker.onerror = (event) => {
            const error =
                event.error instanceof Error
                    ? event.error
                    : new Error(event.message || "OpenChat worker failed to start");
            this.#failWorker(error);
        };
        worker.onmessageerror = () => {
            this.#failWorker(new Error("OpenChat worker returned an unreadable startup response"));
        };

        const initArgs: Init = {
            kind: "init",
            icUrl: config.icUrl ?? window.location.origin,
            iiDerivationOrigin: config.iiDerivationOrigin,
            openStorageIndexCanister: config.openStorageIndexCanister,
            groupIndexCanister: config.groupIndexCanister,
            notificationsCanister: config.notificationsCanister,
            identityCanister: config.identityCanister,
            onlineCanister: config.onlineCanister,
            dailyPuzzleCanister: config.dailyPuzzleCanister,
            userIndexCanister: config.userIndexCanister,
            translationsCanister: config.translationsCanister,
            registryCanister: config.registryCanister,
            internetIdentityUrl: config.internetIdentityUrl,
            nfidUrl: config.nfidUrl,
            userGeekApiKey: config.userGeekApiKey,
            enableMultiCrypto: config.enableMultiCrypto,
            blobUrlPattern: config.blobUrlPattern,
            canisterUrlPath: config.canisterUrlPath,
            proposalBotCanister: config.proposalBotCanister,
            marketMakerCanister: config.marketMakerCanister,
            signInWithEmailCanister: config.signInWithEmailCanister,
            signInWithEthereumCanister: config.signInWithEthereumCanister,
            signInWithSolanaCanister: config.signInWithSolanaCanister,
            oneSecForwarderCanister: config.oneSecForwarderCanister,
            oneSecMinterCanister: config.oneSecMinterCanister,
            websiteVersion: config.websiteVersion,
            rollbarApiKey: config.rollbarApiKey,
            env: config.env,
            bitcoinMainnetEnabled: config.bitcoinMainnetEnabled,
            groupInvite: config.groupInvite,
            accountLinkingCodesEnabled: config.accountLinkingCodesEnabled,
            existingAccountOnly: config.existingAccountOnly === true,
            clientOnlyApps: config.clientOnlyApps === true,
        };

        // The init request owns a startup watchdog. Its rejection is consumed here because the
        // first application request receives the same fatal error and surfaces it through boot.
        void this.send(initArgs).catch(() => undefined);

        window.setInterval(() => this.#monitorPendingRequests(), ONE_MINUTE_MILLIS);
    }

    send<Req extends WorkerRequest>(request: Req): Promise<WorkerResult<Req>> {
        //eslint-disable-next-line @typescript-eslint/ban-ts-comment
        //@ts-ignore
        return new Promise<WorkerResult<Req>>(this.#sendRequestInternal(request));
    }

    stream<Req extends WorkerRequest>(request: Req): Stream<WorkerResult<Req>> {
        //eslint-disable-next-line @typescript-eslint/ban-ts-comment
        //@ts-ignore
        return new Stream<WorkerResult<Req>>(this.#sendRequestInternal(request));
    }

    responseHandler<T>(
        correlationId: number,
        requestKind?: WorkerRequest["kind"],
    ): (resolve: (val: T, final: boolean) => void, reject: (reason?: unknown) => void) => void {
        return (resolve, reject) => {
            const timeoutId =
                requestKind !== undefined && STARTUP_REQUEST_KINDS.has(requestKind)
                    ? window.setTimeout(() => {
                          this.#failWorker(
                              new Error(
                                  `OpenChat worker ${requestKind} request did not respond within ${WORKER_STARTUP_REQUEST_TIMEOUT_MS}ms`,
                              ),
                          );
                      }, WORKER_STARTUP_REQUEST_TIMEOUT_MS)
                    : undefined;
            this.#inflightRequests.set(correlationId, {
                resolve,
                reject,
                timeoutId,
            });
        };
    }

    #sendRequestInternal<Req extends WorkerRequest, T>(
        req: Req,
    ): (resolve: (val: T, final: boolean) => void, reject: (reason?: unknown) => void) => void {
        const correlationId = this.nextCorrelationId++;
        return (resolve, reject) => {
            try {
                assertUnofficialApiRequestAllowed(req, this.#clientOnlyApps);
            } catch (error) {
                reject(error);
                return;
            }
            if (this.#fatalError !== undefined) {
                reject(this.#fatalError);
                return;
            }
            const worker = this.#worker;
            if (worker === undefined) {
                const error = new Error("OpenChat worker is unavailable");
                this.#failWorker(error);
                reject(error);
                return;
            }

            // Register before postMessage so a synchronous cloning/send failure rejects this request
            // through the same fatal path as an asynchronous worker startup error.
            this.responseHandler<T>(correlationId, req.kind)(resolve, reject);
            try {
                worker.postMessage({
                    ...snapshot(req),
                    correlationId,
                });
            } catch (error) {
                const failure = workerFailure(error, "OpenChat worker request could not be sent");
                console.error("Error sending postMessage to worker", failure);
                this.#failWorker(failure);
            }
        };
    }

    #failWorker(error: Error): void {
        if (this.#fatalError !== undefined) return;
        this.#fatalError = error;
        for (const pending of this.#inflightRequests.values()) {
            if (pending.timeoutId !== undefined) window.clearTimeout(pending.timeoutId);
            pending.reject(error);
        }
        this.#inflightRequests.clear();
        this.#worker?.terminate();
        try {
            this.#onFatalError?.(error);
        } catch (callbackError) {
            this.#logger.error("Failed to surface a fatal OpenChat worker error", callbackError);
        }
    }

    // Reported once per crossing of the limit: a wedged worker sits above it for as long as the
    // tab stays open, and a report every poll would be one item per minute saying the same thing
    #pendingLimitReported = false;

    #monitorPendingRequests() {
        const pendingRequests = this.#inflightRequests.size;
        if (pendingRequests >= 100) {
            if (!this.#pendingLimitReported) {
                this.#pendingLimitReported = true;
                this.#logger.error("Pending request count exceeded limit", {
                    count: pendingRequests,
                });
            }
        } else {
            this.#pendingLimitReported = false;
        }
    }

    #resolveResponse(data: WorkerResponse): void {
        const promise = this.#inflightRequests.get(data.correlationId);
        if (promise !== undefined) {
            promise.resolve(data.response, data.final);
            if (data.final) {
                if (promise.timeoutId !== undefined) window.clearTimeout(promise.timeoutId);
                this.#inflightRequests.delete(data.correlationId);
            }
        } else {
            this.#logUnexpected(data.requestKind, data.correlationId);
        }
    }

    #resolveError(data: WorkerError): void {
        const error = JSON.parse(data.error);

        // A request rejected because the session is gone only logged the user out if nobody
        // caught it and it reached the window's unhandledrejection handler. Background pollers
        // catch their own failures, so an expired delegation left the client polling on a timer
        // for as long as the tab stayed open - thousands of identical failures from one client.
        // Only once: a burst of pollers all fail together when a delegation expires, and logout
        // ends in a page navigation.
        if (!this.#sessionExpired && requiresLogout(error)) {
            this.#sessionExpired = true;
            publish("sessionExpired");
        }

        const promise = this.#inflightRequests.get(data.correlationId);
        if (promise !== undefined) {
            if (promise.timeoutId !== undefined) window.clearTimeout(promise.timeoutId);
            promise.reject(error);
            this.#inflightRequests.delete(data.correlationId);
        } else {
            this.#logUnexpected(data.requestKind, data.correlationId);
        }
    }

    #logUnexpected(kind: string, correlationId: number): void {
        console.error(`WORKER_CLIENT: unexpected correlationId received (${correlationId})`, kind);
    }
}

type PromiseResolver<T> = {
    resolve: (val: T | PromiseLike<T>, final: boolean) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reject: (reason?: any) => void;
    timeoutId?: number;
};

function workerFailure(error: unknown, fallback: string): Error {
    return error instanceof Error ? error : new Error(`${fallback}: ${String(error)}`);
}
