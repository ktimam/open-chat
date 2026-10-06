import { writable } from "svelte/store";
import type { LocalDraftDelivery } from "./localAppDrafts";
import { sealLocalAppDelivery } from "./localAppEncryption";
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
            url.port === "5192" &&
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

/** Only explicit card confirmation reaches this adapter. Seal before launching the first-party
 * transport once; never copy the launch capability, persist it, or retry an ambiguous delivery. */
export function createNativeAppDelivery(deps: Dependencies) {
    const pairing = writable<NativeAppPairing | undefined>(undefined);
    const now = deps.now ?? Date.now;
    let active: { cancel: () => void } | undefined;
    const show = (value: NativeAppPairing | undefined) => {
        pairing.set(value);
    };
    const cancelAll = () => {
        active?.cancel();
        show(undefined);
        deps.status(undefined);
    };
    const deliver: LocalDraftDelivery = (request, signal, beforeDelivery) => {
        void beforeDelivery?.catch(() => {});
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
                    await beforeDelivery;
                    if (closed || signal.aborted) return;
                    const encrypted = await sealLocalAppDelivery(request, signal);
                    if (closed || signal.aborted) return;
                    const result = await deps.begin({
                        approvedRequestJson: JSON.stringify(encrypted),
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
                    // A fragment is never sent in HTTP or referrers. The bundled transport erases
                    // it before embedding the app. No capability is displayed or copied.
                    await deps.open(`${result.url}#bootstrap=${result.pairingCode}`);
                    if (closed || signal.aborted) return;
                    // The native clock owns the actual deadline, even while IPC is stalled.
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
    return { deliver, pairing: { subscribe: pairing.subscribe }, cancelAll };
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
