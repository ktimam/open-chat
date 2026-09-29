import {
    APP_SETUP_NONCE,
    APP_SETUP_TIMEOUT_MS,
    exactSetupPacket,
    openAppSetupPopup,
    validSetupTarget,
} from "./utils/localAppSetupPopup";

/** First-party non-isolated relay. Neither this page nor the app receives chat content. */
export function startLocalAppSetupRelay(): () => void {
    window.opener = null;
    const status = document.querySelector<HTMLElement>("#setup-status")!;
    const button = document.querySelector<HTMLButtonElement>("#connect-app")!;
    const params = new URLSearchParams(location.hash.slice(1));
    const nonce = params.get("sessionNonce");
    if (window.top !== window || params.size !== 1 || !nonce || !APP_SETUP_NONCE.test(nonce)) {
        status.textContent = "Invalid app connection. Return to Apps to connect.";
        return () => {};
    }
    history.replaceState(null, "", location.pathname);
    const controller = new AbortController();
    const channel = new BroadcastChannel(`openchat-local-setup-v1:${nonce}`);
    let closed = false;
    let target: { appId: string; setupUrl: string } | undefined;
    const send = (type: string, extra = {}) =>
        channel.postMessage({ type, version: 1, sessionNonce: nonce, ...extra });
    const stop = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        controller.abort();
        button.disabled = true;
        button.onclick = null;
        window.removeEventListener("pagehide", cancel);
        channel.close();
        target = undefined;
    };
    const cancel = () => {
        if (closed) return;
        status.textContent = "Connection ended. Return to Apps to reconnect.";
        try {
            send("setup-failed");
        } catch {
            /* Cleanup must survive a broken channel. */
        } finally {
            stop();
        }
    };
    const timer = setTimeout(cancel, APP_SETUP_TIMEOUT_MS);
    window.addEventListener("pagehide", cancel, { once: true });
    channel.onmessageerror = cancel;
    channel.onmessage = ({ data }) => {
        if (closed || !data || data.version !== 1 || data.sessionNonce !== nonce) return;
        if (
            data.type === "setup-cancel" &&
            exactSetupPacket(data, ["type", "version", "sessionNonce"])
        ) {
            stop();
            return;
        }
        if (
            target ||
            data.type !== "setup-target" ||
            !exactSetupPacket(data, ["type", "version", "sessionNonce", "appId", "setupUrl"]) ||
            !validSetupTarget(data.appId, data.setupUrl)
        )
            return;
        target = { appId: data.appId as string, setupUrl: data.setupUrl as string };
        status.textContent = `Connect ${target.appId} at ${new URL(target.setupUrl).origin}. You will choose what app setup to share there.`;
        button.disabled = false;
    };
    button.onclick = () => {
        if (closed || !target || button.disabled) return;
        button.disabled = true;
        status.textContent = "Complete Connect in the app window. No chat messages have been sent.";
        void openAppSetupPopup(target.appId, target.setupUrl, controller.signal)
            .then((catalogJson) => {
                if (closed) return;
                send("setup-result", { catalogJson });
                status.textContent = "App setup returned to OpenChat. You can close this tab.";
                stop();
            })
            .catch(() => {
                if (closed) return;
                status.textContent = "Connection did not finish. Return to Apps to try again.";
                cancel();
            });
    };
    try {
        send("setup-ready");
    } catch {
        cancel();
    }
    return stop;
}
if (typeof document !== "undefined" && document.body?.dataset.localAppSetup === "true")
    startLocalAppSetupRelay();
