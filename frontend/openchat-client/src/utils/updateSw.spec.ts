import {
    cleanupDevelopmentServiceWorkerState,
    DEVELOPMENT_SERVICE_WORKER_CLEANUP_TIMEOUT_MS,
    OPENCHAT_APP_SHELL_CACHE_NAMES,
    prepareServiceWorkerBeforeApplicationStart,
    runServiceWorkerMaintenance,
} from "./updateSw";

describe("service-worker maintenance", () => {
    it("cleans same-origin registrations and only the OpenChat app-shell caches in development", async () => {
        const sameOriginUnregister = vi.fn(async () => true);
        const foreignOriginUnregister = vi.fn(async () => true);
        const serviceWorker = {
            getRegistrations: vi.fn(async () => [
                { scope: "https://chat.test/", unregister: sameOriginUnregister },
                { scope: "https://elsewhere.test/", unregister: foreignOriginUnregister },
            ]),
        };
        const cacheStorage = { delete: vi.fn(async () => true) };

        await cleanupDevelopmentServiceWorkerState({
            serviceWorker,
            cacheStorage,
            origin: "https://chat.test",
        });

        expect(sameOriginUnregister).toHaveBeenCalledOnce();
        expect(foreignOriginUnregister).not.toHaveBeenCalled();
        expect(cacheStorage.delete.mock.calls.map(([name]) => name)).toEqual([
            ...OPENCHAT_APP_SHELL_CACHE_NAMES,
        ]);
    });

    it("runs development cleanup without starting the production poller", async () => {
        const cleanupDevelopment = vi.fn(async () => undefined);
        const startProductionPoller = vi.fn();

        await runServiceWorkerMaintenance({
            buildEnvironment: "development",
            cleanupDevelopment,
            startProductionPoller,
        });

        expect(cleanupDevelopment).toHaveBeenCalledOnce();
        expect(startProductionPoller).not.toHaveBeenCalled();
    });

    it("preserves the production poller path without running development cleanup", async () => {
        const cleanupDevelopment = vi.fn(async () => undefined);
        const startProductionPoller = vi.fn();

        await runServiceWorkerMaintenance({
            buildEnvironment: "production",
            cleanupDevelopment,
            startProductionPoller,
        });

        expect(cleanupDevelopment).not.toHaveBeenCalled();
        expect(startProductionPoller).toHaveBeenCalledOnce();
    });

    it("continues cleanup when individual registration or cache operations fail", async () => {
        const firstUnregister = vi.fn(async () => {
            throw new Error("registration failed");
        });
        const secondUnregister = vi.fn(async () => true);
        const serviceWorker = {
            getRegistrations: vi.fn(async () => [
                { scope: "https://chat.test/one", unregister: firstUnregister },
                { scope: "https://chat.test/two", unregister: secondUnregister },
            ]),
        };
        const cacheStorage = {
            delete: vi.fn(async (name: string) => {
                if (name === OPENCHAT_APP_SHELL_CACHE_NAMES[0]) {
                    throw new Error("cache failed");
                }
                return true;
            }),
        };

        await expect(
            cleanupDevelopmentServiceWorkerState({
                serviceWorker,
                cacheStorage,
                origin: "https://chat.test",
            }),
        ).resolves.toBeUndefined();

        expect(firstUnregister).toHaveBeenCalledOnce();
        expect(secondUnregister).toHaveBeenCalledOnce();
        expect(cacheStorage.delete).toHaveBeenCalledTimes(2);
    });

    it("still removes app-shell caches when registration enumeration fails", async () => {
        const serviceWorker = {
            getRegistrations: vi.fn(async () => {
                throw new Error("service-worker storage unavailable");
            }),
        };
        const cacheStorage = { delete: vi.fn(async () => true) };

        await expect(
            cleanupDevelopmentServiceWorkerState({
                serviceWorker,
                cacheStorage,
                origin: "https://chat.test",
            }),
        ).resolves.toBeUndefined();

        expect(cacheStorage.delete).toHaveBeenCalledTimes(2);
    });

    it("preserves the navigation fallback cache while a stale worker still controls the page", async () => {
        const serviceWorker = {
            controller: {},
            getRegistrations: vi.fn(async () => []),
        };
        const cacheStorage = { delete: vi.fn(async () => true) };

        await cleanupDevelopmentServiceWorkerState({
            serviceWorker,
            cacheStorage,
            origin: "https://chat.test",
        });

        expect(cacheStorage.delete).toHaveBeenCalledTimes(1);
        expect(cacheStorage.delete).toHaveBeenCalledWith("openchat_stale_while_revalidate");
        expect(cacheStorage.delete).not.toHaveBeenCalledWith("openchat_network_first");
    });

    it("does not boot a controlled development document and requests exactly one release reload", async () => {
        const cleanupDevelopment = vi.fn(async () => undefined);
        const requestReload = vi.fn();
        let marker: string | null = null;
        const reloadMarker = {
            read: vi.fn(() => marker),
            write: vi.fn((value: string) => {
                marker = value;
            }),
            clear: vi.fn(() => {
                marker = null;
            }),
        };

        await expect(
            prepareServiceWorkerBeforeApplicationStart({
                buildEnvironment: "development",
                cleanupDevelopment,
                controllerPresent: () => true,
                requestReload,
                reloadMarker,
            }),
        ).resolves.toBe(false);

        expect(cleanupDevelopment).toHaveBeenCalledOnce();
        expect(reloadMarker.write).toHaveBeenCalledWith("requested");
        expect(requestReload).toHaveBeenCalledOnce();
        expect(reloadMarker.clear).not.toHaveBeenCalled();
    });

    it("fails closed without a reload loop if the replacement document is still controlled", async () => {
        const requestReload = vi.fn();
        const reloadMarker = {
            read: vi.fn(() => "requested"),
            write: vi.fn(),
            clear: vi.fn(),
        };

        await expect(
            prepareServiceWorkerBeforeApplicationStart({
                buildEnvironment: "development",
                cleanupDevelopment: async () => undefined,
                controllerPresent: () => true,
                requestReload,
                reloadMarker,
            }),
        ).rejects.toThrow("still controls this development page after reload");

        expect(requestReload).not.toHaveBeenCalled();
        expect(reloadMarker.write).not.toHaveBeenCalled();
    });

    it("finishes pre-mount development preparation when browser cleanup never settles", async () => {
        vi.useFakeTimers();
        const cleanupDevelopment = vi.fn(() => new Promise<void>(() => undefined));
        let finished = false;

        const preparation = prepareServiceWorkerBeforeApplicationStart({
            buildEnvironment: "development",
            cleanupDevelopment,
        }).then(() => (finished = true));

        await vi.advanceTimersByTimeAsync(DEVELOPMENT_SERVICE_WORKER_CLEANUP_TIMEOUT_MS - 1);
        expect(finished).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await preparation;

        expect(finished).toBe(true);
        expect(cleanupDevelopment).toHaveBeenCalledOnce();
        vi.useRealTimers();
    });

    it("does not run development cleanup during production pre-mount preparation", async () => {
        const cleanupDevelopment = vi.fn(async () => undefined);

        await prepareServiceWorkerBeforeApplicationStart({
            buildEnvironment: "production",
            cleanupDevelopment,
        });

        expect(cleanupDevelopment).not.toHaveBeenCalled();
    });
});
