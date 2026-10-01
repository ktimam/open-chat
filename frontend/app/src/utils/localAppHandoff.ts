import {
    validateEncryptedLocalAppDeliveryRequest,
    type EncryptedLocalAppDeliveryRequest,
} from "./localAppEncryption";

export type LocalAppHandoffOutcome = "received" | "saved" | "rejected" | "uncertain";

export function localAppSessionNonce(): string {
    return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
}

/** One explicitly confirmed handoff. start sends no payload; a bound ready permits one offer.
 * This must be constructed only inside LocalAppDraftStore's delivery adapter, after user approval.
 * A received acknowledgement is NOT a saved entry. There are no automatic reconnects/retries.
 */
export function createLocalAppHandoffSession(options: {
    request: EncryptedLocalAppDeliveryRequest;
    sessionNonce: string;
    receiver: object;
    send: (message: unknown, exactOrigin: string) => void;
    onOutcome: (outcome: LocalAppHandoffOutcome) => void;
    // Native transport rechecks the still-live user approval immediately before releasing data.
    // Optional so an already-bound browser relay keeps its synchronous ready/offer behavior.
    authorizeOffer?: () => Promise<boolean>;
}) {
    const { request, sessionNonce, receiver, send, onOutcome } = options;
    validateEncryptedLocalAppDeliveryRequest(request);
    const destination = new URL(request.destination);
    if (
        !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(sessionNonce) ||
        !receiver ||
        destination.username ||
        destination.password ||
        destination.hash ||
        (destination.protocol !== "https:" &&
            !(
                destination.protocol === "http:" &&
                ["localhost", "127.0.0.1", "[::1]"].includes(destination.hostname)
            ))
    ) {
        throw new Error("Invalid private app handoff binding");
    }
    const origin = destination.origin;
    let started = false;
    let authorizing = false;
    let offered = false;
    let received = false;
    let ended = false;
    const common = { version: 2, sessionNonce };
    function exact(value: Record<string, unknown>, keys: string[]): boolean {
        return (
            Object.keys(value).length === keys.length &&
            keys.every((key) => Object.hasOwn(value, key))
        );
    }
    function uncertain(): void {
        if (ended) return;
        ended = true;
        onOutcome("uncertain");
    }
    function offer(): void {
        if (ended || offered) return;
        offered = true;
        try {
            send(
                {
                    ...common,
                    type: "oc:app-import:offer",
                    importId: request.idempotencyKey,
                    appId: request.appId,
                    appRevision: request.appRevision,
                    actionId: request.actionId,
                    destination: request.destination,
                    envelope: request.envelope,
                },
                origin,
            );
        } catch {
            uncertain();
        }
    }
    return {
        start(): void {
            if (started || ended) return;
            started = true;
            try {
                send({ ...common, type: "oc:app-import:hello" }, origin);
            } catch {
                uncertain();
            }
        },
        receive(event: { origin: string; source: unknown; data: unknown }): void {
            if (
                !started ||
                ended ||
                event.origin !== origin ||
                event.source !== receiver ||
                event.data === null ||
                typeof event.data !== "object" ||
                Array.isArray(event.data)
            )
                return;
            const value = event.data as Record<string, unknown>;
            if (value.version !== 2 || value.sessionNonce !== sessionNonce) return;
            if (
                value.type === "oc:app-import:ready" &&
                exact(value, ["type", "version", "sessionNonce"])
            ) {
                if (offered || authorizing) return;
                if (options.authorizeOffer === undefined) offer();
                else {
                    authorizing = true;
                    // Await once, ignore duplicate ready messages, and never send after close/expiry.
                    void (async () => {
                        try {
                            if (await options.authorizeOffer!()) offer();
                            else uncertain();
                        } catch {
                            uncertain();
                        }
                    })();
                }
                return;
            }
            if (!offered) return;
            if (
                value.type === "oc:app-import:rejected" &&
                ["invalid-offer", "id-conflict", "queue-full"].includes(value.reason as string) &&
                exact(value, ["type", "version", "sessionNonce", "reason"])
            ) {
                ended = true;
                onOutcome("rejected");
                return;
            }
            if (value.importId !== request.idempotencyKey) return;
            if (
                value.type === "oc:app-import:received" &&
                value.status === "pending-review" &&
                exact(value, ["type", "version", "sessionNonce", "importId", "status"])
            ) {
                if (!received) {
                    received = true;
                    onOutcome("received");
                }
            } else if (
                received &&
                value.type === "oc:app-import:committed" &&
                value.status === "saved" &&
                typeof value.acceptedCount === "number" &&
                Number.isSafeInteger(value.acceptedCount) &&
                value.acceptedCount >= 1 &&
                value.acceptedCount <= 32 &&
                typeof value.replayed === "boolean" &&
                exact(value, [
                    "type",
                    "version",
                    "sessionNonce",
                    "importId",
                    "status",
                    "acceptedCount",
                    "replayed",
                ])
            ) {
                ended = true;
                onOutcome("saved");
            }
        },
        expire(): void {
            if (ended || received) return;
            uncertain();
        },
        close(): void {
            ended = true;
        },
    };
}
