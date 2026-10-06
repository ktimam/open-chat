import { createLocalAppHandoffSession } from "./utils/localAppHandoff";
import {
    validateEncryptedLocalAppDeliveryRequest,
    type EncryptedLocalAppDeliveryRequest,
} from "./utils/localAppEncryption";
import { openLocalAppFrame } from "./utils/localAppRelayFrame";

/** Top-level first-party transport shell. The normal app UI fills the page; no second approval. */
export function startLocalAppHandoffRelay(): () => void {
    window.opener = null;
    const status = document.querySelector<HTMLElement>("#handoff-status")!;
    const frame = document.querySelector<HTMLIFrameElement>("#app-frame")!;
    const params = new URLSearchParams(location.hash.slice(1));
    const nonce = params.get("sessionNonce");
    if (
        window.top !== window ||
        location.search ||
        params.size !== 1 ||
        !nonce ||
        !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(nonce)
    ) {
        status.textContent = "This request expired. Return to OpenChat and try again.";
        return () => {};
    }
    history.replaceState(null, "", location.pathname);
    const channel = new BroadcastChannel(`openchat-local-handoff-v1:${nonce}`);
    let request: EncryptedLocalAppDeliveryRequest | undefined;
    let session: ReturnType<typeof createLocalAppHandoffSession> | undefined;
    let closed = false;
    let offerTimer: ReturnType<typeof setTimeout> | undefined;
    let helloTimer: ReturnType<typeof setInterval> | undefined;
    const send = (type: string, extra = {}) =>
        channel.postMessage({ type, version: 1, sessionNonce: nonce, ...extra });
    const stop = () => {
        if (closed) return;
        closed = true;
        clearTimeout(offerTimer);
        clearInterval(helloTimer);
        clearTimeout(expiry);
        session?.close();
        request = undefined;
        window.removeEventListener("message", onMessage);
        window.removeEventListener("pagehide", pagehide);
        channel.close();
        // Do not blank the app's successful review/save page. This only ends transport authority.
    };
    const onMessage = (event: MessageEvent) => session?.receive(event);
    const pagehide = () => {
        if (closed) return;
        status.hidden = false;
        try {
            send("relay-expired");
        } catch {
            /* Broken transport still closes locally. */
        } finally {
            stop();
        }
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("pagehide", pagehide, { once: true });
    const expiry = setTimeout(
        () => {
            status.textContent = "This request expired. Check the app before trying again.";
            pagehide();
        },
        10 * 60 * 1000,
    );
    channel.onmessageerror = () => {
        status.textContent = "Connection interrupted. Check the app before trying again.";
        pagehide();
    };
    channel.onmessage = ({ data }) => {
        if (closed || !data || data.version !== 1 || data.sessionNonce !== nonce) return;
        if (
            data.type === "relay-cancel" &&
            Object.keys(data).sort().join(",") === "sessionNonce,type,version"
        ) {
            status.hidden = false;
            status.textContent = "This request was closed. Check the app before trying again.";
            stop();
            return;
        }
        if (
            data.type !== "relay-approved" ||
            request ||
            Object.keys(data).sort().join(",") !== "request,sessionNonce,type,version"
        )
            return;
        try {
            request = validateEncryptedLocalAppDeliveryRequest(data.request);
            const destination = new URL(request.destination);
            destination.hash = new URLSearchParams({ sessionNonce: nonce }).toString();
            // The sender already obtained explicit approval and encrypted the exact reviewed fields.
            // Only the public nonce is in this URL; the offer remains bound to this frame and origin.
            const receiver = openLocalAppFrame(frame, destination.href);
            status.hidden = true;
            const importId = request.idempotencyKey;
            session = createLocalAppHandoffSession({
                request,
                sessionNonce: nonce,
                receiver,
                send: (message, origin) => receiver.postMessage(message, origin),
                onOutcome: (outcome) => {
                    if (outcome === "uncertain" || outcome === "rejected") {
                        status.hidden = false;
                        status.textContent =
                            "The app could not finish this request. Check the app before trying again.";
                    }
                    try {
                        send("relay-outcome", { outcome, importId });
                    } catch {
                        status.hidden = false;
                        status.textContent =
                            "Connection interrupted. Check the app before trying again.";
                        stop();
                        return;
                    }
                    if (outcome === "received") {
                        clearTimeout(offerTimer);
                        clearInterval(helloTimer);
                    } else stop();
                },
            });
            session.start();
            if (closed) return;
            let helloCount = 0;
            helloTimer = setInterval(() => {
                if (closed || ++helloCount >= 60) {
                    clearInterval(helloTimer);
                    return;
                }
                try {
                    receiver.postMessage(
                        { type: "oc:app-import:hello", version: 2, sessionNonce: nonce },
                        destination.origin,
                    );
                } catch {
                    session?.expire();
                }
            }, 500);
            offerTimer = setTimeout(() => {
                clearInterval(helloTimer);
                session?.expire();
            }, 30_000);
        } catch {
            status.hidden = false;
            status.textContent =
                "The app could not be opened for this request. Return to OpenChat and reconnect the app.";
            pagehide();
        }
    };
    try {
        send("relay-ready");
    } catch {
        status.textContent = "Connection interrupted. Return to OpenChat to check the card.";
        stop();
    }
    return stop;
}

if (typeof document !== "undefined" && document.body?.dataset.localAppHandoff === "true")
    startLocalAppHandoffRelay();
