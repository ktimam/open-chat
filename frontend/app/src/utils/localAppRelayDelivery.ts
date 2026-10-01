import { writable } from "svelte/store";
import type { LocalDraftDeliveryRequest } from "./localAppDrafts";
import { localAppSessionNonce } from "./localAppHandoff";
import { sealLocalAppDelivery } from "./localAppEncryption";

export const localAppDeliveryStatus = writable<
    | {
          importId: string;
          status: "opening" | "received" | "saved" | "rejected" | "uncertain";
      }
    | undefined
>(undefined);

const active = new Map<string, () => void>();
export function cancelLocalAppHandoffs(): void {
    for (const cancel of [...active.values()]) cancel();
    active.clear();
    localAppDeliveryStatus.set(undefined);
}
import.meta.hot?.dispose(cancelLocalAppHandoffs);

/** Invoked synchronously from explicit draft confirmation, preserving the browser user gesture.
 * No source message, chat/account identifiers, processor context, or raw model output is sent.
 * The relay receives exactly the immutable review request; only its payload goes to the app.
 */
export function deliverLocalAppViaRelay(
    request: LocalDraftDeliveryRequest,
    signal: AbortSignal,
    beforeDelivery?: Promise<void>,
): Promise<{ kind: "delivered" | "uncertain" }> {
    // Observe failure even if the caller was cancelled before this adapter could open.
    void beforeDelivery?.catch(() => {});
    if (signal.aborted || typeof BroadcastChannel === "undefined") {
        return Promise.resolve({ kind: "uncertain" });
    }
    active.get(request.idempotencyKey)?.();
    const nonce = localAppSessionNonce();
    const relay = new URL("/local-app-handoff.html", location.origin);
    relay.hash = new URLSearchParams({ sessionNonce: nonce }).toString();
    return new Promise((resolve) => {
        const channel = new BroadcastChannel(`openchat-local-handoff-v1:${nonce}`);
        let approvedSent = false;
        let preparing = false;
        let received = false;
        let settled = false;
        let closed = false;
        // eslint-disable-next-line prefer-const -- Initialized after popup opens; early-failure cleanup can run before assignment.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (kind: "delivered" | "uncertain") => {
            if (!settled) {
                settled = true;
                resolve({ kind });
            }
        };
        const close = () => {
            if (closed) return;
            // Stop the relay on every host teardown, including message decoding errors and
            // navigation. This cannot recall an offered payload, but prevents a stale relay
            // from initiating a new offer after the host has already reported uncertainty.
            try {
                channel.postMessage({ type: "relay-cancel", version: 1, sessionNonce: nonce });
            } catch {
                // Cleanup and local settlement must survive an already broken channel.
            }
            closed = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", cancel);
            window.removeEventListener("pagehide", cancel);
            channel.close();
            if (active.get(request.idempotencyKey) === cancel)
                active.delete(request.idempotencyKey);
        };
        const uncertain = () => {
            if (closed) return;
            localAppDeliveryStatus.set({
                importId: request.idempotencyKey,
                status: received ? "received" : "uncertain",
            });
            finish(received ? "delivered" : "uncertain");
            close();
        };
        const cancel = () => {
            if (closed) return;
            uncertain();
        };
        active.set(request.idempotencyKey, cancel);
        signal.addEventListener("abort", cancel, { once: true });
        window.addEventListener("pagehide", cancel, { once: true });
        // Attach immediately: a failed durable write must not become an unhandled rejection
        // while waiting for the relay, and must close an otherwise empty popup session.
        void beforeDelivery?.catch(() => uncertain());
        channel.onmessage = (event) => {
            if (closed) return;
            const message = event.data;
            if (!message || message.version !== 1 || message.sessionNonce !== nonce) return;
            if (
                message.type === "relay-ready" &&
                !approvedSent &&
                !preparing &&
                Object.keys(message).sort().join(",") === "sessionNonce,type,version"
            ) {
                preparing = true;
                void (async () => {
                    try {
                        await beforeDelivery;
                        if (closed || signal.aborted) return;
                        const encrypted = await sealLocalAppDelivery(request, signal);
                        if (closed || signal.aborted) return;
                        approvedSent = true;
                        channel.postMessage({
                            type: "relay-approved",
                            version: 1,
                            sessionNonce: nonce,
                            request: encrypted,
                        });
                    } catch {
                        uncertain();
                    }
                })();
            } else if (
                message.type === "relay-outcome" &&
                approvedSent &&
                message.importId === request.idempotencyKey &&
                Object.keys(message).sort().join(",") ===
                    "importId,outcome,sessionNonce,type,version"
            ) {
                if (message.outcome === "received") {
                    received = true;
                    localAppDeliveryStatus.set({
                        importId: request.idempotencyKey,
                        status: "received",
                    });
                    finish("delivered");
                } else if (message.outcome === "saved" && received) {
                    localAppDeliveryStatus.set({
                        importId: request.idempotencyKey,
                        status: "saved",
                    });
                    finish("delivered");
                    close();
                } else if (message.outcome === "rejected" || message.outcome === "uncertain") {
                    localAppDeliveryStatus.set({
                        importId: request.idempotencyKey,
                        status: message.outcome,
                    });
                    finish(received ? "delivered" : "uncertain");
                    close();
                }
            } else if (
                message.type === "relay-expired" &&
                Object.keys(message).sort().join(",") === "sessionNonce,type,version"
            ) {
                if (received) {
                    finish("delivered");
                    close();
                } else uncertain();
            }
        };
        channel.onmessageerror = uncertain;
        // No payload in URL or window.name. The relay drops its opener defensively; communication
        // survives COOP separation through a fresh same-origin BroadcastChannel nonce only.
        try {
            const opened = window.open(relay.href, "_blank");
            if (opened === null) {
                uncertain();
                return;
            }
        } catch {
            uncertain();
            return;
        }
        localAppDeliveryStatus.set({ importId: request.idempotencyKey, status: "opening" });
        timer = setTimeout(
            () => {
                if (received) {
                    finish("delivered");
                    close();
                } else {
                    cancel();
                    localAppDeliveryStatus.set({
                        importId: request.idempotencyKey,
                        status: "uncertain",
                    });
                }
            },
            10 * 60 * 1000,
        );
    });
}
