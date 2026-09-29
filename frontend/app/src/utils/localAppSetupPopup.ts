import { localAppSessionNonce } from "./localAppHandoff";

export const APP_SETUP_TIMEOUT_MS = 10 * 60 * 1000;
export const APP_SETUP_MAX_BYTES = 1024 * 1024;
export const APP_SETUP_NONCE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export function validSetupTarget(appId: unknown, setupUrl: unknown): boolean {
    if (
        typeof appId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(appId) ||
        typeof setupUrl !== "string" ||
        setupUrl.length > 2048
    )
        return false;
    try {
        const url = new URL(setupUrl);
        return (
            url.href === setupUrl &&
            !url.username &&
            !url.password &&
            !url.hash &&
            !url.search &&
            (url.protocol === "https:" ||
                (url.protocol === "http:" &&
                    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
        );
    } catch {
        return false;
    }
}
export function exactSetupPacket(value: unknown, keys: string[]): value is Record<string, unknown> {
    return (
        !!value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length === keys.length &&
        keys.every((key) => Object.hasOwn(value, key))
    );
}
export function boundedSetupCatalog(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= APP_SETUP_MAX_BYTES &&
        new TextEncoder().encode(value).byteLength <= APP_SETUP_MAX_BYTES
    );
}

/** Explicit Connect gesture only. Sends a public app identifier and fresh nonce, never chat data. */
export function openAppSetupPopup(
    appId: string,
    setupUrl: string,
    signal: AbortSignal,
): Promise<string> {
    return new Promise((resolve, reject) => {
        if (signal.aborted || !validSetupTarget(appId, setupUrl)) {
            reject(new Error("App connection is unavailable or cancelled"));
            return;
        }
        const origin = new URL(setupUrl).origin;
        const connectionId = localAppSessionNonce();
        let popup: Window | null = null;
        let done = false;
        // eslint-disable-next-line prefer-const -- Early popup failure cleans up before assignment.
        let helloTimer: ReturnType<typeof setInterval> | undefined;
        // eslint-disable-next-line prefer-const -- Early popup failure cleans up before assignment.
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const finish = (catalog?: string) => {
            if (done) return;
            done = true;
            clearInterval(helloTimer);
            clearTimeout(deadline);
            signal.removeEventListener("abort", cancel);
            window.removeEventListener("pagehide", cancel);
            window.removeEventListener("message", receive);
            if (catalog !== undefined) resolve(catalog);
            else reject(new Error("App connection did not finish. Return to Apps to reconnect."));
        };
        const cancel = () => finish();
        const receive = (event: MessageEvent) => {
            if (done || event.source !== popup || event.origin !== origin) return;
            const value = event.data;
            if (
                !exactSetupPacket(value, [
                    "type",
                    "version",
                    "connectionId",
                    "appId",
                    "catalogJson",
                ]) ||
                value.type !== "oc:app-setup:result" ||
                value.version !== 1 ||
                value.connectionId !== connectionId ||
                value.appId !== appId ||
                !boundedSetupCatalog(value.catalogJson)
            )
                return;
            finish(value.catalogJson);
        };
        const hello = () => {
            if (done) return;
            try {
                if (!popup || popup.closed) {
                    finish();
                    return;
                }
                popup.postMessage(
                    { type: "oc:app-setup:connect", version: 1, connectionId, appId },
                    origin,
                );
            } catch {
                finish();
            }
        };
        signal.addEventListener("abort", cancel, { once: true });
        window.addEventListener("pagehide", cancel, { once: true });
        window.addEventListener("message", receive);
        try {
            popup = window.open(setupUrl, "_blank");
        } catch {
            finish();
            return;
        }
        hello();
        if (done) return;
        helloTimer = setInterval(hello, 500);
        deadline = setTimeout(cancel, APP_SETUP_TIMEOUT_MS);
    });
}
