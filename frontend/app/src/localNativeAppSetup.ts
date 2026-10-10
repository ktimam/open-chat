import {
    APP_SETUP_TIMEOUT_MS,
    exactSetupPacket,
    openAppSetupFrame,
    validSetupTarget,
} from "./utils/localAppSetupPopup";
import {
    LOCAL_APP_SCOPED_SETUP_MAX_BYTES,
    parseLocalAppSetupContext,
    type LocalAppSetupContext,
} from "./utils/localAppScopedSetup";

type SetupChallenge = {
    version: 1;
    setupId: string;
    appId: string;
    setupUrl: string;
    expiresAtMs: number;
    browserProofHex: string;
    setupContext?: LocalAppSetupContext;
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
            if (length > LOCAL_APP_SCOPED_SETUP_MAX_BYTES + 16 * 1024)
                throw new Error("Oversized setup response");
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
            ...(value && typeof value === "object" && Object.hasOwn(value, "setupContext")
                ? ["setupContext"]
                : []),
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
    const setupContext = Object.hasOwn(value, "setupContext")
        ? parseLocalAppSetupContext(value.setupContext, value.appId as string)
        : undefined;
    if (!setupContext && length > 16 * 1024) throw new Error("Oversized setup response");
    return { ...value, ...(setupContext ? { setupContext } : {}) } as SetupChallenge;
}

/** Bundled first-party page. The native one-use proof stays in memory, never in the app popup. */
export function startLocalNativeAppSetup(): () => void {
    window.opener = null;
    const status = document.querySelector<HTMLElement>("#setup-status")!;
    const frame = document.querySelector<HTMLIFrameElement>("#app-setup")!;
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
    let completed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelNative = (current: SetupChallenge) => {
        // This proof never leaves the first-party origin. Keep teardown cancellation alive
        // independently of the frame's abort signal; native accepts it only while waiting.
        void fetch("/cancel", {
            method: "POST",
            mode: "same-origin",
            credentials: "omit",
            redirect: "error",
            cache: "no-store",
            referrerPolicy: "no-referrer",
            headers: { "Content-Type": "application/json" },
            keepalive: true,
            body: JSON.stringify({
                version: 1,
                setupId: current.setupId,
                browserProofHex: current.browserProofHex,
            }),
        }).catch(() => {});
    };
    const stop = () => {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        if (challenge && !completed) cancelNative(challenge);
        controller.abort();
        challenge = undefined;
        frame.onload = null;
        window.removeEventListener("pagehide", stop);
    };
    const fail = () => {
        if (stopped) return;
        status.textContent =
            "Connection did not finish. Return to OpenChat to check its status before reconnecting.";
        status.hidden = false;
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
        // A stop racing the challenge must still redeem its response and cancel using its
        // proof. Aborting this fetch would strand the native attempt until its deadline.
        keepalive: true,
    })
        .then(readSetupChallenge)
        .then((value) => {
            if (stopped) {
                cancelNative(value);
                return;
            }
            challenge = value;
            clearTimeout(timer);
            timer = setTimeout(fail, Math.max(1, value.expiresAtMs - Date.now()));
            if (new URL(value.setupUrl).origin === location.origin)
                throw new Error("App setup requires a separate origin");
            frame.referrerPolicy = "no-referrer";
            frame.setAttribute(
                "sandbox",
                "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox",
            );
            frame.onload = () => {
                if (!stopped) status.hidden = true;
            };
            connect();
        })
        .catch(fail);
    function connect() {
        if (stopped || !challenge) return;
        const current = challenge;
        status.textContent = "Opening the app…";
        void openAppSetupFrame(
            current.appId,
            current.setupUrl,
            controller.signal,
            frame,
            ...(current.setupContext ? [current.setupContext] : []),
        )
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
                completed = true;
                status.textContent = "Setup returned to OpenChat. Return to the APK to finish.";
                stop();
            })
            .catch(fail);
    }
    return stop;
}
if (typeof document !== "undefined" && document.body?.dataset.localNativeAppSetup === "true")
    startLocalNativeAppSetup();
