// Hidden registered-app private matcher host.
//
// Each attempt gets a fresh credentialless, no-referrer, opaque-origin iframe,
// exact WindowProxy binding, random document nonce, random attempt id and a
// frame-generated transport public key. OpenChat first mints a
// message/app/action/key-bound one-use capability; the exact source text crosses
// only after the app redeems it and proves the chat has the required durable
// private context. The only accepted response is a boolean.

import { currentUserIdStore, type ChatIdentifier, type OpenChat } from "@client";
import type { AiActionCandidate } from "./aiActionRunner";
import { supportsCredentiallessIframe } from "./cardBridge";
export { supportsCredentiallessIframe } from "./cardBridge";
import { privateMatchSurfaceOpening } from "./aiAppSurfaces";

export const MAX_PRIVATE_MATCH_CANDIDATES = 4;
export const MAX_PRIVATE_MATCH_CONCURRENCY = 2;
export const PRIVATE_MATCH_ATTEMPT_TIMEOUT_MS = 30_000;
export const PRIVATE_MATCH_OPERATION_TIMEOUT_MS = 45_000;
export const MAX_PRIVATE_MATCH_ATTEMPTS = 2;
export const MAX_ACTIVE_PRIVATE_MATCH_OPERATIONS = 8;
const PRIVATE_MATCH_RETRY_BACKOFF_MS = 250;
const MAX_PRIVATE_MATCH_TEXT_BYTES = 32 * 1024;
const VERSION = 1;
const RECIPIENT_KEY_SCHEME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MIN_RECIPIENT_PUBLIC_KEY_BYTES = 16;
const MAX_RECIPIENT_PUBLIC_KEY_BYTES = 512;

const MSG = {
    bootstrap: "oc:private-match:bootstrap",
    ready: "oc:private-match:ready",
    authorize: "oc:private-match:authorize",
    sourceReady: "oc:private-match:source-ready",
    source: "oc:private-match:source",
    result: "oc:private-match:result",
} as const;

export class PrivateMatchOperationRegistry {
    readonly #active = new Set<AbortController>();

    constructor(readonly max: number) {}

    admit(operation: AbortController): boolean {
        if (this.#active.size >= this.max) return false;
        this.#active.add(operation);
        return true;
    }

    release(operation: AbortController): void {
        this.#active.delete(operation);
    }

    abortAll(): void {
        for (const operation of this.#active) operation.abort();
        this.#active.clear();
    }

    get size(): number {
        return this.#active.size;
    }
}

const activeOperations = new PrivateMatchOperationRegistry(MAX_ACTIVE_PRIVATE_MATCH_OPERATIONS);

export function abortPrivateMatchOperations(): void {
    activeOperations.abortAll();
}

import.meta.hot?.dispose(() => abortPrivateMatchOperations());

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function base64Url(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

function decodeCanonicalBase64Url(
    value: unknown,
    minimumBytes: number,
    maximumBytes: number = minimumBytes,
): Uint8Array | undefined {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
    try {
        const padding = "=".repeat((4 - (value.length % 4)) % 4);
        const decoded = Uint8Array.from(
            atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding),
            (character) => character.charCodeAt(0),
        );
        return decoded.length >= minimumBytes &&
            decoded.length <= maximumBytes &&
            base64Url(decoded) === value
            ? decoded
            : undefined;
    } catch {
        return undefined;
    }
}

function randomBinding(bytes: number): string {
    const value = crypto.getRandomValues(new Uint8Array(bytes));
    const encoded = base64Url(value);
    value.fill(0);
    return encoded;
}

export type PrivateMatchFrameBinding = { frameNonce: string; attemptId: string };

export type PrivateMatchReady = PrivateMatchFrameBinding & {
    recipientKeyScheme: string;
    recipientPublicKey: Uint8Array;
};

export function parsePrivateMatchReady(
    value: unknown,
    expected: PrivateMatchFrameBinding,
): PrivateMatchReady | undefined {
    if (
        !isRecord(value) ||
        value.type !== MSG.ready ||
        value.version !== VERSION ||
        value.frameNonce !== expected.frameNonce ||
        value.attemptId !== expected.attemptId ||
        typeof value.recipientKeyScheme !== "string" ||
        !RECIPIENT_KEY_SCHEME.test(value.recipientKeyScheme)
    ) {
        return undefined;
    }
    const recipientPublicKey = decodeCanonicalBase64Url(
        value.recipientPublicKey,
        MIN_RECIPIENT_PUBLIC_KEY_BYTES,
        MAX_RECIPIENT_PUBLIC_KEY_BYTES,
    );
    return recipientPublicKey === undefined
        ? undefined
        : { ...expected, recipientKeyScheme: value.recipientKeyScheme, recipientPublicKey };
}

export function parsePrivateMatchResult(
    value: unknown,
    expected: PrivateMatchFrameBinding,
): boolean | undefined {
    if (
        !isRecord(value) ||
        value.type !== MSG.result ||
        value.version !== VERSION ||
        value.frameNonce !== expected.frameNonce ||
        value.attemptId !== expected.attemptId ||
        typeof value.matched !== "boolean" ||
        // A result is deliberately boolean-only. Reject metadata-bearing variants fail-closed.
        Object.keys(value).some(
            (key) => !["type", "version", "frameNonce", "attemptId", "matched"].includes(key),
        )
    ) {
        return undefined;
    }
    return value.matched;
}

export function parsePrivateMatchSourceReady(
    value: unknown,
    expected: PrivateMatchFrameBinding,
): boolean {
    return (
        isRecord(value) &&
        value.type === MSG.sourceReady &&
        value.version === VERSION &&
        value.frameNonce === expected.frameNonce &&
        value.attemptId === expected.attemptId &&
        Object.keys(value).every((key) =>
            ["type", "version", "frameNonce", "attemptId"].includes(key),
        )
    );
}

export function boundedPrivateMatchCandidates(
    candidates: readonly AiActionCandidate[],
    chatId: ChatIdentifier,
    expectedViewerId: string = currentUserIdStore.value,
    stillCurrent: () => boolean = () => currentUserIdStore.value === expectedViewerId,
): AiActionCandidate[] {
    const seen = new Set<string>();
    const eligible: AiActionCandidate[] = [];
    for (const candidate of candidates) {
        const key = `${candidate.app.id}:${candidate.app.updated.toString()}:${candidate.action.name}`;
        if (
            seen.has(key) ||
            !privateMatchRuntimeCurrent(expectedViewerId, stillCurrent) ||
            privateMatchSurfaceOpening(candidate.app, chatId) === undefined
        ) {
            continue;
        }
        seen.add(key);
        eligible.push(candidate);
        if (eligible.length === MAX_PRIVATE_MATCH_CANDIDATES) break;
    }
    return eligible;
}

function privateMatchRuntimeCurrent(
    expectedViewerId: string,
    stillCurrent: () => boolean,
): boolean {
    return stillCurrent() && currentUserIdStore.value === expectedViewerId;
}

async function matchOne(
    client: OpenChat,
    chatId: ChatIdentifier,
    threadRootMessageIndex: number | undefined,
    messageId: bigint,
    exactMessageText: string,
    candidate: AiActionCandidate,
    signal: AbortSignal,
    expectedViewerId: string,
    stillCurrent: () => boolean,
): Promise<PrivateMatchAttemptOutcome> {
    const opening = privateMatchSurfaceOpening(candidate.app, chatId);
    if (opening === undefined || !supportsCredentiallessIframe()) return "no_match";
    if (signal.aborted) return "transient";
    if (!privateMatchRuntimeCurrent(expectedViewerId, stillCurrent)) {
        return "no_match";
    }

    return new Promise<PrivateMatchAttemptOutcome>((resolve) => {
        const binding: PrivateMatchFrameBinding = {
            frameNonce: randomBinding(32),
            attemptId: randomBinding(16),
        };
        const frame = document.createElement("iframe");
        frame.title = "";
        frame.tabIndex = -1;
        frame.setAttribute("aria-hidden", "true");
        frame.setAttribute("sandbox", "allow-scripts");
        frame.referrerPolicy = "no-referrer";
        (frame as HTMLIFrameElement & { credentialless: boolean }).credentialless = true;
        frame.style.position = "fixed";
        frame.style.width = "1px";
        frame.style.height = "1px";
        frame.style.opacity = "0";
        frame.style.pointerEvents = "none";
        frame.style.inset = "-2px auto auto -2px";

        let settled = false;
        let readyAccepted = false;
        let authorizeSent = false;
        let sourceSent = false;
        let frameWindow: Window | null = null;
        let timer = 0;
        let bootstrapTimer = 0;

        let onAbort = () => {};
        const finish = (outcome: PrivateMatchAttemptOutcome) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            window.clearInterval(bootstrapTimer);
            signal.removeEventListener("abort", onAbort);
            window.removeEventListener("message", onMessage);
            frame.remove();
            resolve(outcome);
        };
        onAbort = () => finish("transient");
        signal.addEventListener("abort", onAbort, { once: true });

        const onMessage = (event: MessageEvent<unknown>) => {
            // `allow-scripts` without `allow-same-origin` makes every child response origin "null".
            // Require that opaque origin AND this attempt's exact WindowProxy/nonces.
            if (settled || event.source !== frameWindow || event.origin !== "null") return;
            if (!readyAccepted) {
                const ready = parsePrivateMatchReady(event.data, binding);
                if (ready === undefined) return;
                readyAccepted = true;
                window.clearInterval(bootstrapTimer);
                // Recheck viewer/global/mute/session state before minting any capability.
                if (!privateMatchRuntimeCurrent(expectedViewerId, stillCurrent)) {
                    ready.recipientPublicKey.fill(0);
                    finish("no_match");
                    return;
                }
                void client
                    .createAiAppPrivateMatchCapability(
                        chatId,
                        threadRootMessageIndex,
                        messageId,
                        candidate.app.id,
                        candidate.app.updated,
                        candidate.action.name,
                        ready.recipientKeyScheme,
                        ready.recipientPublicKey,
                    )
                    .then((capability) => {
                        ready.recipientPublicKey.fill(0);
                        if (settled || capability === undefined || frameWindow === null) {
                            finish("transient");
                            return;
                        }
                        if (
                            decodeCanonicalBase64Url(capability.capability, 32) === undefined ||
                            // Browser clocks are not an authorization source. The canister that
                            // minted/redeems this token enforces its authoritative expiry; here we
                            // only reject a structurally impossible zero timestamp.
                            capability.expiresAt <= 0n ||
                            capability.context.appId !== candidate.app.id ||
                            capability.context.appRevision !== candidate.app.updated ||
                            capability.context.actionId !== candidate.action.name
                        ) {
                            finish("transient");
                            return;
                        }
                        // Minting is asynchronous, so the viewer/runtime may have changed in flight.
                        if (!privateMatchRuntimeCurrent(expectedViewerId, stillCurrent)) {
                            finish("no_match");
                            return;
                        }
                        authorizeSent = true;
                        // Authorization carries no source text. The app frame must redeem it and
                        // prove this exact chat has a durable sheet link before requesting text.
                        frameWindow.postMessage(
                            {
                                type: MSG.authorize,
                                version: VERSION,
                                ...binding,
                                capability: capability.capability,
                            },
                            "*", // opaque sandbox documents have no targetable tuple origin
                        );
                    })
                    .catch(() => {
                        ready.recipientPublicKey.fill(0);
                        finish("transient");
                    });
                return;
            }

            if (!authorizeSent) return;
            if (!sourceSent) {
                const earlyResult = parsePrivateMatchResult(event.data, binding);
                if (earlyResult !== undefined) {
                    // A linked matcher cannot truthfully return true before seeing the exact source.
                    finish(earlyResult ? "transient" : "no_match");
                    return;
                }
                if (!parsePrivateMatchSourceReady(event.data, binding)) return;
                if (!privateMatchRuntimeCurrent(expectedViewerId, stillCurrent)) {
                    finish("no_match");
                    return;
                }
                if (frameWindow === null) {
                    finish("transient");
                    return;
                }
                sourceSent = true;
                // This is the only exact-text egress point, reached only after the app proved the
                // required chat-bound private context is available.
                frameWindow.postMessage(
                    {
                        type: MSG.source,
                        version: VERSION,
                        ...binding,
                        messageText: exactMessageText,
                    },
                    "*", // opaque sandbox documents have no targetable tuple origin
                );
                return;
            }
            const matched = parsePrivateMatchResult(event.data, binding);
            if (matched !== undefined) {
                finish(
                    matched && privateMatchRuntimeCurrent(expectedViewerId, stillCurrent)
                        ? "matched"
                        : "no_match",
                );
            }
        };

        window.addEventListener("message", onMessage);
        frame.addEventListener(
            "load",
            () => {
                if (settled) return;
                frameWindow = frame.contentWindow;
                const bootstrap = () =>
                    frameWindow?.postMessage(
                        { type: MSG.bootstrap, version: VERSION, ...binding },
                        "*", // the fresh sandbox origin is intentionally opaque
                    );
                bootstrap();
                // The parent's iframe load event can precede the child's React effect. Retry only
                // this nonce-only bootstrap until ready; no capability or source text is involved.
                bootstrapTimer = window.setInterval(bootstrap, 100);
            },
            { once: true },
        );
        timer = window.setTimeout(() => finish("transient"), PRIVATE_MATCH_ATTEMPT_TIMEOUT_MS);
        frame.src = opening.url;
        document.body.appendChild(frame);
    });
}

export type PrivateMatchAttemptOutcome = "matched" | "no_match" | "transient";

export async function retryTransientPrivateMatch(
    attempt: () => Promise<PrivateMatchAttemptOutcome>,
    backoff: () => Promise<boolean> = async () => true,
): Promise<PrivateMatchAttemptOutcome> {
    for (let index = 0; index < MAX_PRIVATE_MATCH_ATTEMPTS; index += 1) {
        const outcome = await attempt();
        if (outcome !== "transient") return outcome;
        if (index + 1 < MAX_PRIVATE_MATCH_ATTEMPTS && !(await backoff())) return "transient";
    }
    return "transient";
}

function boundedBackoff(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
        const timer = window.setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve(true);
        }, PRIVATE_MATCH_RETRY_BACKOFF_MS);
        const abort = () => {
            window.clearTimeout(timer);
            resolve(false);
        };
        signal.addEventListener("abort", abort, { once: true });
    });
}

export type PrivateMatchRunResult =
    | { kind: "matched"; candidates: AiActionCandidate[] }
    | { kind: "no_match" }
    | { kind: "transient" };

export type CollectedPrivateMatches = {
    matches: AiActionCandidate[];
    sawTransient: boolean;
};

/**
 * Evaluate every admitted candidate with a strict worker bound while preserving source order.
 * The attempt callback owns each candidate's isolated capability/frame lifecycle. A transient app
 * cannot hide successful matches from other independently-authorized apps.
 */
export async function collectPrivateMatchCandidates(
    queue: readonly AiActionCandidate[],
    attempt: (candidate: AiActionCandidate) => Promise<PrivateMatchAttemptOutcome>,
    shouldContinue: () => boolean = () => true,
): Promise<CollectedPrivateMatches> {
    let next = 0;
    let sawTransient = false;
    const matched = new Array<boolean>(queue.length).fill(false);
    const worker = async () => {
        while (shouldContinue()) {
            const index = next;
            next += 1;
            if (index >= queue.length) return;
            let outcome: PrivateMatchAttemptOutcome;
            try {
                outcome = await attempt(queue[index]);
            } catch {
                // One app-controlled surface/runtime failure is a transient result for only that
                // exact candidate; it must not suppress independently authorized sibling apps.
                outcome = "transient";
            }
            if (outcome === "matched") matched[index] = true;
            if (outcome === "transient") sawTransient = true;
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(MAX_PRIVATE_MATCH_CONCURRENCY, queue.length) }, () =>
            worker(),
        ),
    );
    return {
        matches: queue.filter((_candidate, index) => matched[index]),
        sawTransient,
    };
}

/**
 * Run a bounded queue for one exact NEW text message. At most two isolated frames are live, all
 * admitted apps are evaluated, and every frame is removed on success/failure/TTL.
 */
export async function runPrivateMatchCandidates(
    client: OpenChat,
    chatId: ChatIdentifier,
    threadRootMessageIndex: number | undefined,
    messageId: bigint,
    exactMessageText: string,
    candidates: readonly AiActionCandidate[],
    expectedViewerId: string = currentUserIdStore.value,
    stillCurrent: () => boolean = () => currentUserIdStore.value === expectedViewerId,
): Promise<PrivateMatchRunResult> {
    const byteLength = new TextEncoder().encode(exactMessageText).length;
    if (byteLength === 0 || byteLength > MAX_PRIVATE_MATCH_TEXT_BYTES) return { kind: "no_match" };
    const queue = boundedPrivateMatchCandidates(candidates, chatId, expectedViewerId, stillCurrent);
    if (queue.length === 0) return { kind: "no_match" };

    let operationTimedOut = false;
    const operation = new AbortController();
    if (!activeOperations.admit(operation)) return { kind: "transient" };
    const operationTimer = window.setTimeout(() => {
        operationTimedOut = true;
        operation.abort();
    }, PRIVATE_MATCH_OPERATION_TIMEOUT_MS);
    let collected: CollectedPrivateMatches = { matches: [], sawTransient: false };
    try {
        collected = await collectPrivateMatchCandidates(
            queue,
            async (candidate) => {
                if (!privateMatchRuntimeCurrent(expectedViewerId, stillCurrent)) {
                    return "no_match";
                }
                const outcome = await retryTransientPrivateMatch(
                    () =>
                        matchOne(
                            client,
                            chatId,
                            threadRootMessageIndex,
                            messageId,
                            exactMessageText,
                            candidate,
                            operation.signal,
                            expectedViewerId,
                            stillCurrent,
                        ),
                    () => boundedBackoff(operation.signal),
                );
                return outcome === "matched" &&
                    !privateMatchRuntimeCurrent(expectedViewerId, stillCurrent)
                    ? "no_match"
                    : outcome;
            },
            () => !operation.signal.aborted,
        );
    } finally {
        window.clearTimeout(operationTimer);
        operation.abort();
        activeOperations.release(operation);
    }
    if (collected.matches.length > 0) {
        return { kind: "matched", candidates: collected.matches };
    }
    return collected.sawTransient || operationTimedOut
        ? { kind: "transient" }
        : { kind: "no_match" };
}
