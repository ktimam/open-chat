import { createLocalAppHandoffSession } from "./utils/localAppHandoff";
import {
    validateEncryptedLocalAppDeliveryRequest,
    type EncryptedLocalAppDeliveryRequest,
} from "./utils/localAppEncryption";

/** Preserve every UTF-16 code unit when exposing hidden controls in the exact JSON review. */
export function formatLocalHandoffReview(request: EncryptedLocalAppDeliveryRequest): string {
    return JSON.stringify(
        {
            appId: request.appId,
            destination: request.destination,
            importId: request.idempotencyKey,
            recipientKey: request.envelope.keyId,
            protection: "Encrypted in OpenChat. Only the linked recipient can decrypt the fields.",
        },
        null,
        2,
    ).replace(/[\u007F-\u009F\p{Cf}\u2028\u2029]/gu, (character) =>
        Array.from(
            { length: character.length },
            (_, index) => `\\u${character.charCodeAt(index).toString(16).padStart(4, "0")}`,
        ).join(""),
    );
}

// A fixed first-party relay, not an app processor. It receives ONLY a user-approved draft.
// Kept separate from the cross-origin-isolated model page so the app's sign-in popup can work.
export function startLocalAppHandoffRelay(): () => void {
    // Also cut the parent link on browsers which do not enforce COOP.
    window.opener = null;
    const status = document.querySelector<HTMLElement>("#handoff-status")!;
    const summary = document.querySelector<HTMLElement>("#handoff-summary")!;
    const openButton = document.querySelector<HTMLButtonElement>("#open-app")!;
    const params = new URLSearchParams(location.hash.slice(1));
    const nonce = params.get("sessionNonce");
    if (
        params.size !== 1 ||
        nonce === null ||
        !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(nonce)
    ) {
        status.textContent =
            "This handoff link is invalid or expired. Return to the client to review a draft.";
        return () => {};
    }
    history.replaceState(null, "", location.pathname);
    const channel = new BroadcastChannel(`openchat-local-handoff-v1:${nonce}`);
    let request: EncryptedLocalAppDeliveryRequest | undefined;
    let session: ReturnType<typeof createLocalAppHandoffSession> | undefined;
    let popup: Window | null = null;
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
        summary.textContent = "";
        openButton.disabled = true;
        window.removeEventListener("message", onMessage);
        channel.close();
    };
    const onMessage = (event: MessageEvent) => session?.receive(event);
    window.addEventListener("message", onMessage);
    const expiry = setTimeout(
        () => {
            status.textContent =
                "This handoff expired. Check the app before retrying a draft whose delivery is uncertain.";
            send("relay-expired");
            stop();
        },
        10 * 60 * 1000,
    );
    channel.onmessage = (event) => {
        if (closed) return;
        const message = event.data;
        if (!message || message.version !== 1 || message.sessionNonce !== nonce) return;
        if (message.type === "relay-cancel") {
            status.textContent =
                "The client closed this handoff. Content already sent to the app cannot be recalled.";
            stop();
            return;
        }
        if (
            message.type !== "relay-approved" ||
            request !== undefined ||
            Object.keys(message).sort().join(",") !== "request,sessionNonce,type,version"
        )
            return;
        try {
            request = validateEncryptedLocalAppDeliveryRequest(message.request);
            // textContent never interprets app names, URLs, or values as HTML.
            summary.textContent = formatLocalHandoffReview(request);
            status.textContent =
                "The approved fields were encrypted in OpenChat. This page cannot read them. Open the linked app to decrypt and review them; nothing has been saved yet.";
            openButton.disabled = false;
        } catch {
            status.textContent = "The approved draft is invalid. No app was opened.";
            send("relay-expired");
            stop();
        }
    };
    openButton.onclick = () => {
        if (closed || request === undefined || popup !== null) return;
        const destination = new URL(request.destination);
        destination.hash = new URLSearchParams({ sessionNonce: nonce }).toString();
        popup = window.open(destination.href, "_blank");
        if (popup === null) {
            status.textContent =
                "The app popup was blocked. Allow popups, then press Open app again.";
            return;
        }
        openButton.disabled = true;
        session = createLocalAppHandoffSession({
            request,
            sessionNonce: nonce,
            receiver: popup,
            send: (message, origin) => popup?.postMessage(message, origin),
            onOutcome: (outcome) => {
                send("relay-outcome", { outcome, importId: request!.idempotencyKey });
                if (outcome === "received") {
                    clearTimeout(offerTimer);
                    clearInterval(helloTimer);
                    status.textContent =
                        "Received by the app for review. Choose the account/sheet and save there if you want to keep it. This is not yet a saved entry.";
                } else if (outcome === "saved") {
                    status.textContent = "The app reports that this import was saved.";
                    stop();
                } else {
                    status.textContent =
                        "Delivery was not confirmed. Check the app before explicitly retrying the same draft.";
                    stop();
                }
            },
        });
        // A newly opened page may not have registered its listener yet. Only public hello is
        // repeated; the bound protocol sends its private offer at most once, after ready.
        session.start();
        if (closed) return;
        const hello = { type: "oc:app-import:hello", version: 2, sessionNonce: nonce };
        let helloCount = 0;
        helloTimer = setInterval(() => {
            if (closed || ++helloCount >= 60) {
                clearInterval(helloTimer);
                return;
            }
            popup?.postMessage(hello, destination.origin);
        }, 500);
        offerTimer = setTimeout(() => {
            clearInterval(helloTimer);
            session?.expire();
        }, 30_000);
        status.textContent = "Waiting for the app to acknowledge the reviewed payload…";
    };
    window.addEventListener(
        "pagehide",
        () => {
            if (!closed) send("relay-expired");
            stop();
        },
        { once: true },
    );
    send("relay-ready");
    return stop;
}

if (typeof document !== "undefined" && document.body?.dataset.localAppHandoff === "true") {
    startLocalAppHandoffRelay();
}
