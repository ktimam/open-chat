import {
    APP_SETUP_NONCE,
    APP_SETUP_TIMEOUT_MS,
    exactSetupPacket,
    openAppSetupFrame,
    validSetupTarget,
} from "./utils/localAppSetupPopup";
import { validateLocalAppFrameDestination } from "./utils/localAppRelayFrame";
import { parseLocalAppSetupContext, type LocalAppSetupContext } from "./utils/localAppScopedSetup";

/** The normal app connection UI is the only visible surface; sharing still needs its consent. */
export function startLocalAppSetupRelay(): () => void {
    window.opener = null;
    const status = document.querySelector<HTMLElement>("#setup-status")!;
    const frame = document.querySelector<HTMLIFrameElement>("#app-frame")!;
    const params = new URLSearchParams(location.hash.slice(1));
    const nonce = params.get("sessionNonce");
    if (
        window.top !== window ||
        location.search ||
        params.size !== 1 ||
        !nonce ||
        !APP_SETUP_NONCE.test(nonce)
    ) {
        status.textContent = "This connection expired. Return to Apps to reconnect.";
        return () => {};
    }
    history.replaceState(null, "", location.pathname);
    const controller = new AbortController();
    const channel = new BroadcastChannel(`openchat-local-setup-v1:${nonce}`);
    let closed = false;
    let target:
        | { appId: string; setupUrl: string; setupContext?: LocalAppSetupContext }
        | undefined;
    const send = (type: string, extra = {}) =>
        channel.postMessage({ type, version: 1, sessionNonce: nonce, ...extra });
    const stop = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        controller.abort();
        window.removeEventListener("pagehide", cancel);
        channel.close();
        target = undefined;
    };
    const cancel = () => {
        if (closed) return;
        status.hidden = false;
        status.textContent = "Connection did not finish. Return to Apps to reconnect.";
        try {
            send("setup-failed");
        } catch {
            /* Broken transport still closes locally. */
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
            status.hidden = false;
            status.textContent = "This connection was closed. Return to Apps to reconnect.";
            stop();
            return;
        }
        if (
            target ||
            data.type !== "setup-target" ||
            !exactSetupPacket(data, [
                "type",
                "version",
                "sessionNonce",
                "appId",
                "setupUrl",
                ...(Object.hasOwn(data, "setupContext") ? ["setupContext"] : []),
            ]) ||
            !validSetupTarget(data.appId, data.setupUrl)
        )
            return;
        target = { appId: data.appId as string, setupUrl: data.setupUrl as string };
        try {
            if (Object.hasOwn(data, "setupContext"))
                target.setupContext = parseLocalAppSetupContext(data.setupContext, target.appId);
            validateLocalAppFrameDestination(target.setupUrl);
            status.hidden = true;
            void openAppSetupFrame(
                target.appId,
                target.setupUrl,
                controller.signal,
                frame,
                ...(target.setupContext ? [target.setupContext] : []),
            )
                .then((catalogJson) => {
                    if (closed) return;
                    try {
                        send("setup-result", { catalogJson });
                    } finally {
                        stop();
                    }
                })
                .catch(() => {
                    if (!closed) {
                        status.hidden = false;
                        cancel();
                    }
                });
        } catch {
            status.hidden = false;
            cancel();
        }
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
