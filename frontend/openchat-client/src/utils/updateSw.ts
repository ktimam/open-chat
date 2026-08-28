/**
 * Periodically check whether there is a new service worker available
 */

import { Poller } from "../utils/poller";
import { OPENCHAT_APP_SHELL_CACHE_NAMES } from "./openChatAppShellCaches";

export { OPENCHAT_APP_SHELL_CACHE_NAMES } from "./openChatAppShellCaches";

type CleanupRegistration = {
    readonly scope: string;
    unregister(): Promise<boolean>;
};

type CleanupServiceWorkerContainer = {
    readonly controller?: unknown | null;
    getRegistrations(): Promise<readonly CleanupRegistration[]>;
};

type CleanupCacheStorage = {
    delete(cacheName: string): Promise<boolean>;
};

export type DevelopmentServiceWorkerCleanupDependencies = {
    serviceWorker: CleanupServiceWorkerContainer | undefined;
    cacheStorage: CleanupCacheStorage | undefined;
    origin: string | undefined;
};

export type ServiceWorkerMaintenanceDependencies = {
    buildEnvironment: string | undefined;
    cleanupDevelopment: () => Promise<void>;
    startProductionPoller: () => void;
};

export type PreMountServiceWorkerDependencies = {
    buildEnvironment: string | undefined;
    cleanupDevelopment: () => Promise<void>;
    cleanupTimeoutMs?: number;
    controllerPresent?: () => boolean;
    requestReload?: () => void;
    reloadMarker?: {
        read(): string | null;
        write(value: string): void;
        clear(): void;
    };
};

export const DEVELOPMENT_SERVICE_WORKER_CLEANUP_TIMEOUT_MS = 2000;
export const DEVELOPMENT_SERVICE_WORKER_RELEASE_MARKER = "openchat.dev-sw-release.v1";

let poller: Poller | undefined = undefined;

function sameOrigin(scope: string, origin: string): boolean {
    try {
        return new URL(scope, origin).origin === new URL(origin).origin;
    } catch {
        return false;
    }
}

// A production worker can keep controlling a development origin long after the server switches
// back to Vite. Remove only registrations for this origin and the two caches owned by OpenChat's
// app shell. Model artifacts (HF/Transformers/OPFS/IndexedDB) are deliberately outside this list.
// Every storage operation is best-effort so one broken registration/cache cannot block the other
// cleanup or application startup.
export async function cleanupDevelopmentServiceWorkerState({
    serviceWorker,
    cacheStorage,
    origin,
}: DevelopmentServiceWorkerCleanupDependencies): Promise<void> {
    const registrationCleanup = async (): Promise<void> => {
        if (serviceWorker === undefined || origin === undefined) return;

        let registrations: readonly CleanupRegistration[];
        try {
            registrations = await serviceWorker.getRegistrations();
        } catch {
            return;
        }

        await Promise.allSettled(
            registrations
                .filter((registration) => sameOrigin(registration.scope, origin))
                .map((registration) => Promise.resolve().then(() => registration.unregister())),
        );
    };

    const cacheCleanup = async (): Promise<void> => {
        if (cacheStorage === undefined) return;
        // unregister() does not stop the worker that controls this document. Keep its navigation
        // fallback until the next (uncontrolled) load, otherwise a brief development-network
        // outage can send that still-active worker into its empty-cache reload fallback loop.
        const cacheNames =
            serviceWorker?.controller == null
                ? OPENCHAT_APP_SHELL_CACHE_NAMES
                : OPENCHAT_APP_SHELL_CACHE_NAMES.filter(
                      (cacheName) => cacheName !== "openchat_network_first",
                  );
        await Promise.allSettled(
            cacheNames.map((cacheName) =>
                Promise.resolve().then(() => cacheStorage.delete(cacheName)),
            ),
        );
    };

    await Promise.allSettled([registrationCleanup(), cacheCleanup()]);
}

// A stale production worker can intercept /worker.js before OpenChat's auth client responds. Run
// this bounded cleanup before mounting the Svelte tree (and therefore before WorkerAgent exists).
// The cleanup deadline is fail-open only for an uncontrolled document. A controlled document must
// navigate once before the authentication worker can be created.
export async function prepareServiceWorkerBeforeApplicationStart(
    {
        buildEnvironment,
        cleanupDevelopment,
        cleanupTimeoutMs = DEVELOPMENT_SERVICE_WORKER_CLEANUP_TIMEOUT_MS,
        controllerPresent = () => false,
        requestReload,
        reloadMarker,
    }: PreMountServiceWorkerDependencies = {
        buildEnvironment: import.meta.env.OC_BUILD_ENV,
        cleanupDevelopment: () =>
            cleanupDevelopmentServiceWorkerState({
                serviceWorker:
                    typeof navigator !== "undefined" && "serviceWorker" in navigator
                        ? navigator.serviceWorker
                        : undefined,
                cacheStorage: typeof caches === "undefined" ? undefined : caches,
                origin: typeof location === "undefined" ? undefined : location.origin,
            }),
        controllerPresent: () =>
            typeof navigator !== "undefined" &&
            "serviceWorker" in navigator &&
            navigator.serviceWorker.controller != null,
        requestReload: () => location.reload(),
        reloadMarker: {
            read: () => sessionStorage.getItem(DEVELOPMENT_SERVICE_WORKER_RELEASE_MARKER),
            write: (value) =>
                sessionStorage.setItem(DEVELOPMENT_SERVICE_WORKER_RELEASE_MARKER, value),
            clear: () => sessionStorage.removeItem(DEVELOPMENT_SERVICE_WORKER_RELEASE_MARKER),
        },
    },
): Promise<boolean> {
    if (buildEnvironment !== "development") return true;
    const startedControlled = controllerPresent();

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = Promise.resolve()
        .then(cleanupDevelopment)
        .catch(() => undefined);
    const deadline = new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, cleanupTimeoutMs);
    });
    await Promise.race([cleanup, deadline]);
    if (timeout !== undefined) clearTimeout(timeout);

    if (!startedControlled || !controllerPresent()) {
        try {
            reloadMarker?.clear();
        } catch {
            // Storage can be disabled. It is not required when this document is uncontrolled.
        }
        return true;
    }

    // unregister() does not detach the active controller from the current Document. Never create
    // OpenChat's authentication worker under that stale controller: request one navigation after
    // cleanup and leave this document unmounted. A session marker prevents a reload loop; if the
    // next Document is still controlled we fail closed instead of booting against stale /worker.js.
    let alreadyReloaded = false;
    try {
        alreadyReloaded = reloadMarker?.read() === "requested";
    } catch {
        // Without session storage a controlled page still gets one reload for this invocation.
    }
    if (alreadyReloaded) {
        throw new Error(
            "A stale service worker still controls this development page after reload. Close this tab and open OpenChat again.",
        );
    }
    try {
        reloadMarker?.write("requested");
        requestReload?.();
    } catch (error) {
        try {
            reloadMarker?.clear();
        } catch {
            // Keep the original navigation failure.
        }
        throw error;
    }
    return false;
}

export async function runServiceWorkerMaintenance({
    buildEnvironment,
    cleanupDevelopment,
    startProductionPoller,
}: ServiceWorkerMaintenanceDependencies): Promise<void> {
    if (buildEnvironment === "development") {
        await cleanupDevelopment();
        return;
    }

    startProductionPoller();
}

function startProductionSwCheckPoller(): void {
    if ("serviceWorker" in navigator) {
        if (poller === undefined) {
            poller = new Poller(checkServiceWorker, 60000);
        }
    }
}

export async function startSwCheckPoller(): Promise<void> {
    // Development cleanup already ran before application mount. Repeating it here is too late to
    // protect worker authentication and can race an active controller's fetches.
    if (import.meta.env.OC_BUILD_ENV !== "development") startProductionSwCheckPoller();
}

async function checkServiceWorker() {
    const reg = await navigator.serviceWorker.getRegistration(
        import.meta.env.OC_SERVICE_WORKER_PATH,
    );
    if (reg) {
        console.log("SW: checking for a new root service worker");
        await reg.update(); // this should get the new service worker and install it if it's available
    }
}
