import { writable } from "svelte/store";
import type { LocalDraftDelivery } from "./localAppDrafts";
import { localAppDeliveryStatus } from "./localAppRelayDelivery";
import type {
    LocalAppHandoffStart,
    LocalAppHandoffStatus,
} from "tauri-plugin-oc-api/commands/localAppHandoff";

export type NativeAppPairing = Readonly<{
    importId: string;
    handoffId: string;
    url: string;
    pairingCode: string;
    expiresAtMs: number;
    message?: string;
}>;
type DeliveryStatus = {
    importId: string;
    status: "opening" | "received" | "saved" | "rejected" | "uncertain";
};
type Dependencies = {
    begin: (request: { approvedRequestJson: string }) => Promise<LocalAppHandoffStart>;
    poll: (id: string) => Promise<LocalAppHandoffStatus>;
    cancel: (id: string) => Promise<unknown>;
    open: (url: string) => Promise<unknown>;
    copy: (code: string) => Promise<unknown>;
    status: (status: DeliveryStatus | undefined) => void;
    now?: () => number;
};
const PHASES = new Set([
    "awaiting_claim",
    "reviewing",
    "offered",
    "received",
    "saved",
    "rejected",
    "uncertain",
    "expired",
    "cancelled",
]);
const MAX_LIFETIME_MS = 12 * 60 * 1000;

function validStart(value: LocalAppHandoffStart, now: number): boolean {
    if (
        !value ||
        !/^[a-f0-9]{32}$/.test(value.handoffId) ||
        !/^[A-Z2-7]{20}$/.test(value.pairingCode) ||
        !Number.isSafeInteger(value.claimExpiresAtMs) ||
        value.claimExpiresAtMs <= now ||
        value.claimExpiresAtMs > now + 120_000
    )
        return false;
    try {
        const url = new URL(value.url);
        return (
            url.href === value.url &&
            url.protocol === "http:" &&
            url.hostname === "localhost" &&
            Number(url.port) >= 1024 &&
            Number(url.port) <= 65535 &&
            url.pathname === "/handoff" &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash
        );
    } catch {
        return false;
    }
}

/** Only the immutable reviewed request reaches this adapter. No persistence, browser fallback,
 * automatic clipboard access, automatic opening, or automatic delivery retry is available. */
export function createNativeAppDelivery(deps: Dependencies) {
    const pairing = writable<NativeAppPairing | undefined>(undefined);
    const now = deps.now ?? Date.now;
    let shown: NativeAppPairing | undefined;
    let active: { cancel: () => void } | undefined;
    const show = (value: NativeAppPairing | undefined) => {
        shown = value;
        pairing.set(value);
    };
    const cancelAll = () => {
        active?.cancel();
        show(undefined);
        deps.status(undefined);
    };
    const deliver: LocalDraftDelivery = (request, signal) => {
        if (signal.aborted) return Promise.resolve({ kind: "uncertain" });
        active?.cancel();
        show(undefined);
        return new Promise((resolve) => {
            let id: string | undefined;
            let closed = false;
            let settled = false;
            let received = false;
            let claimed = false;
            let dispatched = false;
            let pollTimer: ReturnType<typeof setTimeout> | undefined;
            let claimTimer: ReturnType<typeof setTimeout> | undefined;
            const startedAt = now();
            const finish = () => {
                if (!settled) {
                    settled = true;
                    resolve({ kind: received ? "delivered" : "uncertain" });
                }
            };
            const cancelNative = (handoffId: string) => {
                void deps.cancel(handoffId).catch(() => {});
            };
            const status = (value: DeliveryStatus["status"]) => {
                if (active === run)
                    deps.status({ importId: request.idempotencyKey, status: value });
            };
            const close = () => {
                if (closed) return;
                closed = true;
                clearTimeout(pollTimer);
                clearTimeout(claimTimer);
                clearTimeout(lifetimeTimer);
                signal.removeEventListener("abort", cancel);
                if (typeof window !== "undefined") window.removeEventListener("pagehide", cancel);
                if (active === run) {
                    active = undefined;
                    show(undefined);
                }
                if (id) cancelNative(id);
                finish();
            };
            const uncertain = () => {
                if (closed) return;
                status(received ? "received" : "uncertain");
                close();
            };
            const cancel = () => uncertain();
            const run = { cancel };
            active = run;
            const lifetimeTimer = setTimeout(uncertain, MAX_LIFETIME_MS);
            signal.addEventListener("abort", cancel, { once: true });
            if (typeof window !== "undefined")
                window.addEventListener("pagehide", cancel, { once: true });
            status("opening");
            const poll = async () => {
                if (closed || !id) return;
                try {
                    const result = await deps.poll(id);
                    if (closed) return;
                    if (
                        !result ||
                        !PHASES.has(result.phase) ||
                        !Number.isSafeInteger(result.expiresAtMs) ||
                        result.expiresAtMs > startedAt + MAX_LIFETIME_MS ||
                        typeof result.deliveryMayHaveOccurred !== "boolean" ||
                        (dispatched && !result.deliveryMayHaveOccurred) ||
                        (["offered", "received", "saved"].includes(result.phase) &&
                            !result.deliveryMayHaveOccurred) ||
                        (claimed && result.phase === "awaiting_claim")
                    ) {
                        uncertain();
                        return;
                    }
                    dispatched ||= result.deliveryMayHaveOccurred;
                    if (result.phase !== "awaiting_claim") {
                        claimed = true;
                        clearTimeout(claimTimer);
                        if (active === run) show(undefined);
                    }
                    if (result.phase === "received" || result.phase === "saved") {
                        received = true;
                        status(result.phase);
                        finish();
                        if (result.phase === "saved") {
                            close();
                            return;
                        }
                    } else if (result.phase === "rejected") {
                        status("rejected");
                        close();
                        return;
                    } else if (
                        ["uncertain", "expired", "cancelled"].includes(result.phase) ||
                        result.expiresAtMs <= now()
                    ) {
                        uncertain();
                        return;
                    }
                    pollTimer = setTimeout(() => void poll(), 1_000);
                } catch {
                    uncertain();
                }
            };
            // begin receives exactly the frozen draft snapshot; it is never called from polling.
            void (async () => {
                try {
                    const result = await deps.begin({
                        approvedRequestJson: JSON.stringify(request),
                    });
                    if (closed) {
                        if (result && /^[a-f0-9]{32}$/.test(result.handoffId))
                            cancelNative(result.handoffId);
                        return;
                    }
                    if (!validStart(result, now())) {
                        if (result && /^[a-f0-9]{32}$/.test(result.handoffId))
                            id = result.handoffId;
                        uncertain();
                        return;
                    }
                    id = result.handoffId;
                    show(
                        Object.freeze({
                            importId: request.idempotencyKey,
                            handoffId: id,
                            url: result.url,
                            pairingCode: result.pairingCode,
                            expiresAtMs: result.claimExpiresAtMs,
                        }),
                    );
                    // Remove a stale bearer code even if an IPC poll hangs. The native clock owns
                    // the actual deadline; a UI timeout never authorizes an external offer.
                    claimTimer = setTimeout(() => {
                        if (active === run) show(undefined);
                    }, result.claimExpiresAtMs - now());
                    void poll();
                } catch {
                    uncertain();
                }
            })();
        });
    };
    const current = (importId: string) =>
        shown?.importId === importId && shown.expiresAtMs > now() ? shown : undefined;
    async function openBrowser(importId: string): Promise<void> {
        const value = current(importId);
        if (!value) return;
        try {
            await deps.open(value.url);
        } catch {
            if (shown === value)
                show({
                    ...value,
                    message:
                        "The local browser could not be opened. You can try opening it again while this code is valid.",
                });
        }
    }
    async function copyCode(importId: string): Promise<void> {
        const value = current(importId);
        if (!value) return;
        try {
            await deps.copy(value.pairingCode);
            if (shown === value)
                show({
                    ...value,
                    message:
                        "Code copied. Paste it only into the local browser page shown here. The clipboard may retain it after it expires.",
                });
        } catch {
            if (shown === value)
                show({
                    ...value,
                    message:
                        "The code could not be copied. You can enter the displayed code manually.",
                });
        }
    }
    return { deliver, pairing: { subscribe: pairing.subscribe }, cancelAll, openBrowser, copyCode };
}

export const nativeAppDelivery = createNativeAppDelivery({
    begin: async (request) =>
        (await import("tauri-plugin-oc-api/commands/localAppHandoff")).beginLocalAppHandoff(
            request,
        ),
    poll: async (id) =>
        (await import("tauri-plugin-oc-api/commands/localAppHandoff")).pollLocalAppHandoff(id),
    cancel: async (id) =>
        (await import("tauri-plugin-oc-api/commands/localAppHandoff")).cancelLocalAppHandoff(id),
    open: async (url) => (await import("tauri-plugin-oc-api/commands/openUrl")).openUrl({ url }),
    copy: async (code) => navigator.clipboard.writeText(code),
    status: (status) => localAppDeliveryStatus.set(status),
});
export const nativeAppPairing = nativeAppDelivery.pairing;
import.meta.hot?.dispose(nativeAppDelivery.cancelAll);

export function nativeDeliveryAllowed(
    client:
        | {
              isNativeApp?: () => boolean;
              clientOnlyApps?: () => boolean;
          }
        | undefined,
): boolean {
    return client?.isNativeApp?.() === true && client.clientOnlyApps?.() === true;
}
