import {
    APP_SETUP_TIMEOUT_MS,
    exactSetupPacket,
    openAppSetupPopup,
    validSetupTarget,
} from "./utils/localAppSetupPopup";

type SetupChallenge = {
    version: 1;
    setupId: string;
    appId: string;
    setupUrl: string;
    expiresAtMs: number;
    browserProofHex: string;
};
export async function readSetupChallenge(response: Response): Promise<SetupChallenge> {
    if (!response.ok || response.redirected || !response.body)
        throw new Error("Invalid setup response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > 16 * 1024) throw new Error("Oversized setup response");
            chunks.push(value);
        }
    } finally {
        await reader.cancel();
        reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (
        !exactSetupPacket(value, [
            "version",
            "setupId",
            "appId",
            "setupUrl",
            "expiresAtMs",
            "browserProofHex",
        ]) ||
        value.version !== 1 ||
        typeof value.setupId !== "string" ||
        !/^[a-f0-9]{32}$/.test(value.setupId) ||
        typeof value.browserProofHex !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.browserProofHex) ||
        !validSetupTarget(value.appId, value.setupUrl) ||
        typeof value.expiresAtMs !== "number" ||
        !Number.isSafeInteger(value.expiresAtMs) ||
        value.expiresAtMs <= Date.now() ||
        value.expiresAtMs > Date.now() + APP_SETUP_TIMEOUT_MS + 5000
    )
        throw new Error("Invalid setup challenge");
    return value as SetupChallenge;
}

/** Bundled first-party page. The native one-use proof stays in memory, never in the app popup. */
export function startLocalNativeAppSetup(): () => void {
    window.opener = null;
    const status = document.querySelector<HTMLElement>("#setup-status")!;
    const button = document.querySelector<HTMLButtonElement>("#connect-app")!;
    const params = new URLSearchParams(location.hash.slice(1));
    const bootstrap = params.get("bootstrap");
    if (
        window.top !== window ||
        location.protocol !== "http:" ||
        location.hostname !== "localhost" ||
        !location.port ||
        Number(location.port) < 1024 ||
        location.pathname !== "/setup" ||
        location.search ||
        params.size !== 1 ||
        !bootstrap ||
        !/^[a-f0-9]{64}$/.test(bootstrap)
    ) {
        status.textContent = "Invalid app connection. Return to OpenChat.";
        return () => {};
    }
    // A separate native launch secret authenticates the first request against other local apps.
    // Fragments never reach the HTTP server/referrer; remove it before opening the publisher.
    history.replaceState(null, "", location.pathname);
    const controller = new AbortController();
    let challenge: SetupChallenge | undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        controller.abort();
        challenge = undefined;
        button.disabled = true;
        button.onclick = null;
        window.removeEventListener("pagehide", stop);
    };
    const fail = () => {
        if (stopped) return;
        status.textContent =
            "Connection did not finish. Return to OpenChat to check its status before reconnecting.";
        stop();
    };
    timer = setTimeout(fail, APP_SETUP_TIMEOUT_MS);
    window.addEventListener("pagehide", stop, { once: true });
    void fetch("/challenge", {
        headers: { "X-OpenChat-Setup-Bootstrap": bootstrap },
        credentials: "omit",
        mode: "same-origin",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
    })
        .then(readSetupChallenge)
        .then((value) => {
            if (stopped) return;
            challenge = value;
            clearTimeout(timer);
            timer = setTimeout(fail, Math.max(1, value.expiresAtMs - Date.now()));
            status.textContent = `Connect ${value.appId} at ${new URL(value.setupUrl).origin}. Choose the account and setup to share in the app.`;
            button.disabled = false;
        })
        .catch(fail);
    button.onclick = () => {
        if (stopped || !challenge || button.disabled) return;
        const current = challenge;
        button.disabled = true;
        status.textContent = "Complete Connect in the app window. No chat messages have been sent.";
        void openAppSetupPopup(current.appId, current.setupUrl, controller.signal)
            .then(async (catalogJson) => {
                if (stopped) return;
                const response = await fetch("/result", {
                    method: "POST",
                    mode: "same-origin",
                    credentials: "omit",
                    redirect: "error",
                    cache: "no-store",
                    referrerPolicy: "no-referrer",
                    headers: { "Content-Type": "application/json" },
                    signal: controller.signal,
                    body: JSON.stringify({
                        version: 1,
                        setupId: current.setupId,
                        browserProofHex: current.browserProofHex,
                        catalogJson,
                    }),
                });
                if (stopped) return;
                if (!response.ok || response.redirected)
                    throw new Error("Setup result not accepted");
                status.textContent = "Setup returned to OpenChat. Return to the APK to finish.";
                stop();
            })
            .catch(fail);
    };
    return stop;
}
if (typeof document !== "undefined" && document.body?.dataset.localNativeAppSetup === "true")
    startLocalNativeAppSetup();
