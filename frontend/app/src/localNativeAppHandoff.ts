import {
    createLocalAppHandoffSession,
    localAppSessionNonce,
    type LocalAppHandoffOutcome,
} from "./utils/localAppHandoff";
import {
    MAX_ENCRYPTED_REQUEST_BYTES,
    validateEncryptedLocalAppDeliveryRequest,
    type EncryptedLocalAppDeliveryRequest,
} from "./utils/localAppEncryption";

const NONCE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const PHASES = [
    "awaiting_claim",
    "reviewing",
    "offered",
    "received",
    "saved",
    "rejected",
    "uncertain",
    "expired",
    "cancelled",
] as const;
type Phase = (typeof PHASES)[number];
type NativeStatus = { phase: Phase; expiresAtMs: number; deliveryMayHaveOccurred: boolean };
function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
    return (
        Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
    );
}
function deadline(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function nativeStatus(value: unknown): NativeStatus {
    if (
        !record(value) ||
        !exact(value, ["phase", "expiresAtMs", "deliveryMayHaveOccurred"]) ||
        !PHASES.includes(value.phase as Phase) ||
        !deadline(value.expiresAtMs) ||
        typeof value.deliveryMayHaveOccurred !== "boolean"
    )
        throw new Error("Invalid handoff response");
    return value as NativeStatus;
}

/** Native already validated duplicate keys and retained the exact approved JSON. Recheck the
 * bounded envelope before rendering it or exposing it to a popup; never trust model routing. */
export function parseNativeApprovedRequest(json: unknown): EncryptedLocalAppDeliveryRequest {
    if (
        typeof json !== "string" ||
        new TextEncoder().encode(json).length > MAX_ENCRYPTED_REQUEST_BYTES
    )
        throw new Error("Invalid approved request");
    return validateEncryptedLocalAppDeliveryRequest(JSON.parse(json));
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
    if (
        !response.ok ||
        !response.headers.get("content-type")?.startsWith("application/json") ||
        !response.body
    )
        throw new Error("Handoff request failed");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let size = 0;
    let text = "";
    try {
        for (;;) {
            const item = await reader.read();
            if (item.done) break;
            size += item.value.byteLength;
            if (size > limit) throw new Error("Handoff response is too large");
            text += decoder.decode(item.value, { stream: true });
        }
        text += decoder.decode();
        return JSON.parse(text);
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

/** Internal first-party transport after the APK's explicit card approval. The one-use launch
 * fragment is erased before mounting the app's normal review UI. No source-chat access or retry. */
export function startLocalNativeAppHandoff(): () => void {
    const status = document.querySelector<HTMLElement>("#handoff-status")!;
    const frame = document.querySelector<HTMLIFrameElement>("#app-review")!;
    const params = new URLSearchParams(location.hash.slice(1));
    let bootstrap = params.get("bootstrap") ?? "";
    // Scrub even malformed launch material. Neither the app URL nor the HTTP request carries it.
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    const validOrigin = /^http:\/\/localhost:([1-9][0-9]{3,4})$/.exec(location.origin);
    if (
        !validOrigin ||
        Number(validOrigin[1]) > 65535 ||
        Number(validOrigin[1]) < 1024 ||
        location.pathname !== "/handoff" ||
        location.search ||
        params.size !== 1 ||
        !/^[A-Z2-7]{20}$/.test(bootstrap) ||
        window.top !== window
    ) {
        status.textContent = "This is not a valid local handoff page. Return to the APK.";
        bootstrap = "";
        return () => {};
    }
    window.opener = null;
    let closed = false;
    let request: EncryptedLocalAppDeliveryRequest | undefined;
    let browserProofHex = "";
    let handoffId = "";
    let connectionId = "";
    let sessionNonce = "";
    let expiresAtMs = 0;
    let monotonicDeadline = 0;
    let popup: Window | null = null;
    let session: ReturnType<typeof createLocalAppHandoffSession> | undefined;
    let received = false;
    let pollBusy = false;
    let resultQueue = Promise.resolve();
    const controller = new AbortController();
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    let consentTimer: ReturnType<typeof setTimeout> | undefined;
    let helloTimer: ReturnType<typeof setInterval> | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    const live = () => !closed && Date.now() < expiresAtMs && performance.now() < monotonicDeadline;
    function stop(message?: string) {
        if (closed) return;
        closed = true;
        if (message !== undefined) {
            status.textContent = message;
            status.hidden = false;
        }
        controller.abort();
        session?.close();
        session = undefined;
        clearTimeout(expiryTimer);
        clearTimeout(consentTimer);
        clearInterval(helloTimer);
        clearInterval(pollTimer);
        request = undefined;
        browserProofHex = "";
        handoffId = "";
        connectionId = "";
        sessionNonce = "";
        bootstrap = "";
        frame.onload = null;
        window.removeEventListener("message", onMessage);
        window.removeEventListener("pagehide", onPageHide);
    }
    function uncertain() {
        stop(
            received
                ? "The app acknowledged receipt for review, but saving is not confirmed. Check the app. This page will not send the draft again."
                : "Delivery failed or its outcome is unknown. Check the app, then return to the APK if you want to explicitly retry the same draft. Nothing is retried automatically.",
        );
    }
    async function post(
        path: "/claim" | "/status" | "/dispatch" | "/result",
        body: unknown,
        limit = 2048,
    ) {
        if (closed) throw new Error("Handoff closed");
        const response = await fetch(path, {
            method: "POST",
            credentials: "omit",
            cache: "no-store",
            redirect: "error",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        const value = await boundedJson(response, limit);
        if (closed) throw new Error("Handoff closed");
        return value;
    }
    const proof = () => ({ version: 1, handoffId, browserProofHex });
    function report(outcome: LocalAppHandoffOutcome) {
        if (closed) return;
        if (outcome === "received") {
            received = true;
            clearTimeout(consentTimer);
            clearInterval(helloTimer);
            status.textContent =
                "The app acknowledged receipt for review, not saving. Review and save in the app if you want to keep it.";
        }
        // The receiver can acknowledge and commit back-to-back. Preserve native received->saved
        // ordering rather than racing the two POSTs; never retry a failed result submission.
        const importId = request!.idempotencyKey;
        resultQueue = resultQueue
            .then(async () => {
                if (closed) return;
                const result = nativeStatus(
                    await post("/result", { ...proof(), importId, outcome }),
                );
                if (result.phase !== outcome) throw new Error("Unexpected handoff state");
                if (outcome === "saved") stop("The app reports that this import was saved.");
                else if (outcome === "rejected")
                    stop(
                        "The app rejected this import. Nothing is retried automatically. Return to the APK to review it.",
                    );
                else if (outcome === "uncertain") uncertain();
            })
            .catch(() => {
                if (!closed) uncertain();
            });
    }
    function publicHello() {
        if (closed || !popup || !request) return;
        try {
            if (popup.closed) {
                uncertain();
                return;
            }
            const data = sessionNonce
                ? { type: "oc:app-import:hello", version: 2, sessionNonce }
                : { type: "oc:app-import:connect", version: 1, connectionId };
            popup.postMessage(data, new URL(request.destination).origin);
        } catch {
            uncertain();
        }
    }
    function onMessage(event: MessageEvent) {
        if (
            closed ||
            !request ||
            !popup ||
            event.source !== popup ||
            event.origin !== new URL(request.destination).origin
        )
            return;
        if (!session) {
            const data: unknown = event.data;
            if (
                !record(data) ||
                !exact(data, ["type", "version", "connectionId", "sessionNonce"]) ||
                data.type !== "oc:app-import:connected" ||
                data.version !== 1 ||
                data.connectionId !== connectionId ||
                typeof data.sessionNonce !== "string" ||
                !NONCE.test(data.sessionNonce)
            )
                return;
            sessionNonce = data.sessionNonce;
            session = createLocalAppHandoffSession({
                request,
                sessionNonce,
                receiver: popup,
                send: (message, origin) => {
                    if (!live() || !popup || popup.closed)
                        throw new Error("App closed or handoff expired");
                    popup.postMessage(message, origin);
                },
                authorizeOffer: async () => {
                    if (!live() || !request || !popup || popup.closed) return false;
                    // This is a one-shot native check after receiver consent/ready. A lost response
                    // is uncertain; it must never lead to a second dispatch or an unapproved send.
                    const result = nativeStatus(
                        await post("/dispatch", { ...proof(), importId: request.idempotencyKey }),
                    );
                    return (
                        live() &&
                        Date.now() < result.expiresAtMs &&
                        !popup.closed &&
                        result.phase === "offered" &&
                        result.deliveryMayHaveOccurred
                    );
                },
                onOutcome: report,
            });
            session.start();
        } else session.receive(event);
    }
    async function poll() {
        if (closed || pollBusy) return;
        pollBusy = true;
        try {
            const value = nativeStatus(await post("/status", proof()));
            if (["cancelled", "expired", "rejected", "uncertain"].includes(value.phase)) {
                stop(
                    "The APK closed or expired this handoff. Content already received by the app cannot be recalled; check the app before retrying.",
                );
            } else if (value.phase === "saved") stop("The app reports that this import was saved.");
            else if (popup?.closed) uncertain();
        } catch {
            if (!closed) uncertain();
        } finally {
            pollBusy = false;
        }
    }
    function onPageHide() {
        stop();
    }
    window.addEventListener("message", onMessage);
    window.addEventListener("pagehide", onPageHide);
    void (async () => {
        const enteredCode = bootstrap;
        bootstrap = "";
        status.textContent = "Opening the app…";
        try {
            browserProofHex = Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) =>
                n.toString(16).padStart(2, "0"),
            ).join("");
            const value = await post(
                "/claim",
                { version: 1, code: enteredCode, browserProofHex },
                160 * 1024,
            );
            if (
                !record(value) ||
                !exact(value, ["version", "handoffId", "approvedRequestJson", "expiresAtMs"]) ||
                value.version !== 1 ||
                typeof value.handoffId !== "string" ||
                !/^[0-9a-f]{32}$/.test(value.handoffId) ||
                !deadline(value.expiresAtMs) ||
                value.expiresAtMs <= Date.now() ||
                value.expiresAtMs > Date.now() + 10 * 60 * 1000 + 5000
            )
                throw new Error("Invalid claim response");
            request = parseNativeApprovedRequest(value.approvedRequestJson);
            handoffId = value.handoffId;
            expiresAtMs = value.expiresAtMs;
            monotonicDeadline =
                performance.now() + Math.min(10 * 60 * 1000, expiresAtMs - Date.now());
            expiryTimer = setTimeout(
                () =>
                    stop(
                        "This handoff expired. Check the app before explicitly retrying the same draft from the APK.",
                    ),
                Math.min(10 * 60 * 1000, value.expiresAtMs - Date.now()),
            );
            pollTimer = setInterval(() => {
                void poll();
            }, 1000);
            openApp();
        } catch {
            if (!closed)
                stop(
                    "The app could not be opened, or the outcome is unknown. Return to OpenChat to check the card. Nothing is retried automatically.",
                );
        }
    })();
    function openApp() {
        if (closed || !request || popup) return;
        try {
            if (new URL(request.destination).origin === location.origin)
                throw new Error("The app must have a separate origin");
            frame.referrerPolicy = "no-referrer";
            frame.setAttribute(
                "sandbox",
                "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox",
            );
            frame.onload = () => {
                if (!closed) status.hidden = true;
            };
            frame.src = request.destination; // No bearer, proof, draft or origin URL parameter.
            frame.hidden = false;
            popup = frame.contentWindow;
            if (!popup) throw new Error("App review is unavailable");
            connectionId = localAppSessionNonce();
            publicHello();
            if (closed) return;
            helloTimer = setInterval(publicHello, 500);
            consentTimer = setTimeout(
                () => {
                    clearInterval(helloTimer);
                    if (session) session.expire();
                    else report("uncertain");
                },
                2 * 60 * 1000,
            );
        } catch {
            uncertain();
        }
    }
    return () => stop();
}

if (typeof document !== "undefined" && document.body?.dataset.nativeAppHandoff === "true") {
    startLocalNativeAppHandoff();
}
