import { isTauri } from "@tauri-apps/api/core";
import type { LocalAppDirectoryDescriptor } from "./localAppDirectory";
import { localAppSessionNonce } from "./localAppHandoff";
import {
    parseLocalAppSetupContext,
    parseLocalAppScopedSetupResult,
    type LocalAppSetupContext,
} from "./localAppScopedSetup";
import {
    APP_SETUP_TIMEOUT_MS,
    boundedSetupCatalog,
    exactSetupPacket,
    validSetupTarget,
} from "./localAppSetupPopup";
export type LocalAppSetupContextInput =
    | LocalAppSetupContext
    | Promise<LocalAppSetupContext | undefined>;

/** Called directly by the Connect click: browser popup creation must precede any await. */
export function connectLocalAppSetup(
    descriptor: LocalAppDirectoryDescriptor,
    signal: AbortSignal,
    setupContext?: LocalAppSetupContextInput,
): Promise<string> {
    if (isTauri()) return connectNativeAppSetup(descriptor, signal, setupContext);
    return connectBrowserAppSetup(descriptor, signal, setupContext);
}
export function connectBrowserAppSetup(
    descriptor: Pick<LocalAppDirectoryDescriptor, "id" | "setupUrl">,
    signal: AbortSignal,
    setupContext?: LocalAppSetupContextInput,
): Promise<string> {
    return new Promise((resolve, reject) => {
        let context: LocalAppSetupContext | undefined;
        let contextReady = false;
        let relayReady = false;
        if (
            signal.aborted ||
            typeof BroadcastChannel === "undefined" ||
            !validSetupTarget(descriptor.id, descriptor.setupUrl)
        ) {
            reject(new Error("App connection is unavailable"));
            return;
        }
        const nonce = localAppSessionNonce();
        const channel = new BroadcastChannel(`openchat-local-setup-v1:${nonce}`);
        let closed = false;
        let sent = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const finish = (catalog?: string) => {
            if (closed) return;
            closed = true;
            clearTimeout(timeout);
            signal.removeEventListener("abort", cancel);
            window.removeEventListener("pagehide", cancel);
            try {
                channel.postMessage({ type: "setup-cancel", version: 1, sessionNonce: nonce });
            } catch {
                /* Broken channel still settles locally. */
            }
            channel.close();
            if (catalog !== undefined) resolve(catalog);
            else
                reject(
                    new Error(
                        "App connection did not finish. Allow the connection window and try again.",
                    ),
                );
        };
        const cancel = () => finish();
        const sendTarget = () => {
            if (closed || sent || !contextReady || !relayReady) return;
            sent = true;
            try {
                channel.postMessage({
                    type: "setup-target",
                    version: 1,
                    sessionNonce: nonce,
                    appId: descriptor.id,
                    setupUrl: descriptor.setupUrl,
                    ...(context ? { setupContext: context } : {}),
                });
            } catch {
                finish();
            }
        };
        if (setupContext === undefined) contextReady = true;
        else if (!(setupContext instanceof Promise)) {
            try {
                context = parseLocalAppSetupContext(setupContext, descriptor.id);
            } catch {
                finish();
                return;
            }
            contextReady = true;
        } else {
            void setupContext
                .then((value) => {
                    if (closed) return;
                    context =
                        value === undefined
                            ? undefined
                            : parseLocalAppSetupContext(value, descriptor.id);
                    contextReady = true;
                    sendTarget();
                })
                .catch(() => finish());
        }
        signal.addEventListener("abort", cancel, { once: true });
        window.addEventListener("pagehide", cancel, { once: true });
        channel.onmessageerror = cancel;
        channel.onmessage = ({ data }) => {
            if (closed || !data || data.version !== 1 || data.sessionNonce !== nonce) return;
            if (
                data.type === "setup-ready" &&
                !sent &&
                exactSetupPacket(data, ["type", "version", "sessionNonce"])
            ) {
                relayReady = true;
                sendTarget();
            } else if (
                data.type === "setup-result" &&
                sent &&
                exactSetupPacket(data, ["type", "version", "sessionNonce", "catalogJson"]) &&
                boundedSetupCatalog(data.catalogJson)
            ) {
                try {
                    if (context)
                        parseLocalAppScopedSetupResult(data.catalogJson, descriptor.id, context);
                    finish(data.catalogJson);
                } catch {
                    finish();
                }
            } else if (
                data.type === "setup-failed" &&
                exactSetupPacket(data, ["type", "version", "sessionNonce"])
            )
                finish();
        };
        const relay = new URL("/local-app-setup.html", location.origin);
        relay.hash = new URLSearchParams({ sessionNonce: nonce }).toString();
        try {
            if (window.open(relay.href, "_blank") === null) {
                finish();
                return;
            }
        } catch {
            finish();
            return;
        }
        if (!closed) timeout = setTimeout(cancel, APP_SETUP_TIMEOUT_MS);
    });
}

export async function connectNativeAppSetup(
    descriptor: LocalAppDirectoryDescriptor,
    signal: AbortSignal,
    setupContext?: LocalAppSetupContextInput,
): Promise<string> {
    signal.throwIfAborted();
    const deadline = performance.now() + APP_SETUP_TIMEOUT_MS;
    const context = await new Promise<LocalAppSetupContext | undefined>((resolve, reject) => {
        let settled = false;
        const finish = (value?: LocalAppSetupContext, failed = false) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", cancel);
            if (failed) reject(new Error("App connection cancelled or invalid"));
            else resolve(value);
        };
        const cancel = () => finish(undefined, true);
        const timer = setTimeout(cancel, APP_SETUP_TIMEOUT_MS);
        signal.addEventListener("abort", cancel, { once: true });
        void Promise.resolve(setupContext)
            .then((value) => {
                if (settled) return;
                signal.throwIfAborted();
                finish(
                    value === undefined
                        ? undefined
                        : parseLocalAppSetupContext(value, descriptor.id),
                );
            })
            .catch(cancel);
    });
    signal.throwIfAborted();
    if (!validSetupTarget(descriptor.id, descriptor.setupUrl))
        throw new Error("Invalid app connection");
    const transport = await import("tauri-plugin-oc-api/commands/localAppSetup");
    signal.throwIfAborted();
    const started = await transport.beginLocalAppSetup({
        appId: descriptor.id,
        setupUrl: descriptor.setupUrl,
        ...(context ? { setupContext: context } : {}),
    });
    const cancel = () => {
        void transport.cancelLocalAppSetup(started.setupId).catch(() => undefined);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
        signal.throwIfAborted();
        const url = new URL(started.url);
        const fragment = new URLSearchParams(url.hash.slice(1));
        if (
            url.protocol !== "http:" ||
            url.hostname !== "localhost" ||
            url.port !== "5193" ||
            url.pathname !== "/setup" ||
            url.search ||
            fragment.size !== 1 ||
            !/^[a-f0-9]{64}$/.test(fragment.get("bootstrap") ?? "") ||
            url.username ||
            url.password
        )
            throw new Error("Invalid native setup route");
        await (await import("tauri-plugin-oc-api/commands/openUrl")).openUrl({ url: url.href });
        while (!signal.aborted && performance.now() < deadline) {
            const state = await transport.pollLocalAppSetup(started.setupId);
            signal.throwIfAborted();
            if (state.phase === "received" && boundedSetupCatalog(state.catalogJson)) {
                if (context)
                    parseLocalAppScopedSetupResult(state.catalogJson, descriptor.id, context);
                return state.catalogJson;
            }
            if (state.phase !== "waiting")
                throw new Error("App connection expired or was cancelled");
            await new Promise<void>((resolve) => {
                if (signal.aborted) {
                    resolve();
                    return;
                }
                const finish = () => {
                    clearTimeout(timer);
                    signal.removeEventListener("abort", finish);
                    resolve();
                };
                const timer = setTimeout(finish, 500);
                signal.addEventListener("abort", finish, { once: true });
            });
        }
        throw new Error("App connection expired or was cancelled");
    } finally {
        signal.removeEventListener("abort", cancel);
        await transport.cancelLocalAppSetup(started.setupId).catch(() => undefined);
    }
}
