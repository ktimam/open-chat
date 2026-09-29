// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { OpenChat, MessageContent } from "@client";
import { PrivateAppWorkspace } from "./privateAppWorkspace";
import { directoryFixture, directorySource } from "./localAppDirectory.testFixtures";
import {
    decodeLocalAppSetup,
    encodeLocalAppSetup,
    type LocalAppSetupSnapshot,
    type LocalAppSetupStorage,
} from "./localAppSetupStore";
import type {
    LocalAppDirectory,
    LocalAppDirectoryDescriptor,
    LocalAppPublicPackage,
} from "./localAppDirectory";
import type { extractPrivateAppAction } from "./aiActionRunner";
import { verifyImportedLocalProcessor, type runIsolatedAppProcessor } from "./isolatedAppProcessor";
import type { LocalDraftDelivery } from "./localAppDrafts";

vi.mock("@client", () => ({ currentUserIdStore: { value: "synthetic-account" } }));
vi.mock("@shared", () => ({ ANON_USER_ID: "anonymous" }));
vi.mock("./aiActionRunner", () => ({ extractPrivateAppAction: vi.fn() }));
vi.mock("./localAppRelayDelivery", async () => {
    const { writable } = await import("svelte/store");
    return {
        deliverLocalAppViaRelay: vi.fn(),
        cancelLocalAppHandoffs: vi.fn(),
        localAppDeliveryStatus: writable(undefined),
    };
});

async function fixture(privateSetup = false, storage?: LocalAppSetupStorage) {
    const one = await directoryFixture("one", "1", privateSetup);
    const two = await directoryFixture("two");
    let directory: LocalAppDirectory = { version: 1, apps: [one.descriptor, two.descriptor] };
    const packages = new Map<string, LocalAppPublicPackage>([
        ["one", one.pkg],
        ["two", two.pkg],
    ]);
    const connected = new Map([
        ["one", one.connectedJson],
        ["two", two.connectedJson],
    ]);
    const deps = {
        extract: vi.fn<typeof extractPrivateAppAction>(async () => ({
            kind: "extracted",
            candidates: [{ value: 42 }],
        })),
        runProcessor: vi.fn<typeof runIsolatedAppProcessor>(),
        verifyProcessor: verifyImportedLocalProcessor,
        deliver: vi.fn<LocalDraftDelivery>(),
        deliverySaved: () => false,
        cancelDelivery: vi.fn(),
        setupStorage: storage,
        loadDirectory: vi.fn(async () => directory),
        loadPublicPackage: vi.fn(
            async (descriptor: LocalAppDirectoryDescriptor, _signal: AbortSignal) =>
                packages.get(descriptor.id)!,
        ),
        connectAppSetup: vi.fn(
            async (descriptor: LocalAppDirectoryDescriptor, _signal: AbortSignal) =>
                connected.get(descriptor.id)!,
        ),
    };
    const workspace = new PrivateAppWorkspace(deps);
    workspace.setAccount("synthetic-account", "https://backend.test|index");
    if (storage) await vi.waitFor(() => expect(workspace.state.setupLoading).toBe(false));
    workspace.configureDirectory(directorySource);
    await workspace.refreshDirectory();
    return {
        one,
        two,
        deps,
        workspace,
        packages,
        connected,
        setDirectory(next: LocalAppDirectory) {
            directory = next;
        },
    };
}
const client = { clientOnlyApps: () => true } as OpenChat;
const propose = (workspace: PrivateAppWorkspace) =>
    workspace.propose(
        client,
        { kind: "text_content", text: "synthetic input not for setup" } as MessageContent,
        { stillCurrent: () => true },
    );

describe("automatic app setup atomicity and privacy", () => {
    it("bounds the combined connection when private setup returns but its public download stalls", async () => {
        const { workspace, deps, two } = await fixture();
        await workspace.connectApp("one");
        const previous = workspace.state.catalog;
        let finishDownload!: (value: LocalAppPublicPackage) => void;
        deps.loadPublicPackage.mockImplementationOnce(
            () => new Promise((resolve) => (finishDownload = resolve)),
        );
        vi.useFakeTimers();
        try {
            const pending = workspace.connectApp("two");
            await Promise.resolve();
            expect(deps.connectAppSetup).toHaveBeenCalledTimes(2);
            expect(workspace.state.busy).toBe(true);
            expect(await workspace.connectApp("two")).toBe(false);
            expect(deps.connectAppSetup).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(600_000 - 1);
            expect(workspace.state.busy).toBe(true);
            await vi.advanceTimersByTimeAsync(1);
            expect(workspace.state.busy).toBe(false);
            await expect(pending).resolves.toBe(false);
            expect(deps.connectAppSetup.mock.calls.at(-1)![1].aborted).toBe(true);
            expect(deps.loadPublicPackage.mock.calls.at(-1)![1].aborted).toBe(true);
            expect(workspace.state.catalog).toBe(previous);
            expect(workspace.state.message).toContain("retry Connect explicitly");
            expect(vi.getTimerCount()).toBe(0);
            finishDownload(two.pkg);
            await Promise.resolve();
            await Promise.resolve();
            expect(workspace.state.catalog).toBe(previous);
            expect(workspace.state.busy).toBe(false);
        } finally {
            workspace.clear();
            vi.useRealTimers();
        }
    });
    it("disables an omitted app and its chat opt-ins while retaining setup for explicit recovery", async () => {
        const { workspace, setDirectory, one, deps } = await fixture();
        await workspace.connectApp("one");
        workspace.replaceEnabledChats("synthetic-account", workspace.state.catalog!, [
            { chatKey: "chat", appIds: ["one"] },
        ]);
        setDirectory({ version: 1, apps: [] });
        await workspace.refreshDirectory();
        expect(workspace.state.catalog?.apps[0].id).toBe("one");
        expect(workspace.state.disabledAppIds).toEqual(["one"]);
        expect(workspace.state.enabledChats).toEqual([]);
        expect(
            workspace.replaceEnabledChats("synthetic-account", workspace.state.catalog!, [
                { chatKey: "chat", appIds: ["one"] },
            ]),
        ).toBe(false);
        workspace.select("one", "add");
        expect(await propose(workspace)).toBe("retryable");
        expect(deps.extract).not.toHaveBeenCalled();
        setDirectory(one.directory);
        await workspace.refreshDirectory();
        expect(workspace.state.disabledAppIds).toEqual(["one"]);
        await workspace.connectApp("one");
        expect(workspace.state.disabledAppIds).toEqual([]);
        expect(workspace.state.enabledChats).toEqual([]);
    });
    it("does not disable an app if a draft starts while the directory response is pending", async () => {
        const { workspace, deps } = await fixture();
        await workspace.connectApp("one");
        let resolve!: (value: LocalAppDirectory) => void;
        deps.loadDirectory.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
        const refresh = workspace.refreshDirectory();
        await propose(workspace);
        resolve({ version: 1, apps: [] });
        expect(await refresh).toBe(false);
        expect(workspace.state.disabledAppIds).toEqual([]);
        expect(workspace.state.draft).toBeDefined();
    });
    it("rejects persisted cross-app artifacts, altered provenance and disabled app opt-ins", async () => {
        const one = await directoryFixture("one");
        const two = await directoryFixture("two");
        const scope = { account: "synthetic", backend: "test" };
        const snapshot = {
            catalog: one.pkg.catalog,
            enabledChats: [],
            processors: [{ appId: "one", artifact: one.processor }],
            installations: [
                {
                    appId: "one",
                    sourceUrl: directorySource,
                    descriptor: one.descriptor,
                    publicCatalogJson: one.catalogJson,
                },
            ],
        };
        await expect(
            encodeLocalAppSetup(scope, {
                ...snapshot,
                processors: [{ appId: "one", artifact: two.processor }],
            }),
        ).rejects.toThrow();
        await expect(
            encodeLocalAppSetup(scope, {
                ...snapshot,
                installations: [
                    { ...snapshot.installations[0], publicCatalogJson: `${one.catalogJson} ` },
                ],
            }),
        ).rejects.toThrow();
        await expect(
            encodeLocalAppSetup(scope, {
                ...snapshot,
                disabledAppIds: ["one"],
                enabledChats: [{ chatKey: "chat", appIds: ["one"] }],
            }),
        ).rejects.toThrow();
        const saved = await decodeLocalAppSetup(
            scope,
            await encodeLocalAppSetup(scope, { ...snapshot, disabledAppIds: ["one"] }),
        );
        expect(saved.disabledAppIds).toEqual(["one"]);
        expect(saved.processors?.[0].artifact).toEqual(one.processor);
    });
    it("discovers without a connection or chat opt-in, then atomically installs and retains both processors", async () => {
        const { workspace, deps } = await fixture();
        expect(workspace.state.catalog).toBeUndefined();
        expect(deps.connectAppSetup).not.toHaveBeenCalled();
        expect(workspace.state.enabledChats).toEqual([]);
        expect(deps.extract).not.toHaveBeenCalled();
        expect(await workspace.connectApp("one")).toBe(true);
        expect(await workspace.connectApp("two")).toBe(true);
        expect(workspace.state.catalog?.apps.map((app) => app.id)).toEqual(["one", "two"]);
        expect(workspace.state.enabledChats).toEqual([]);
        workspace.select("one", "add");
        expect(workspace.state.processorReady).toBe(true);
        workspace.select("two", "add");
        expect(workspace.state.processorReady).toBe(true);
        expect(deps.deliver).not.toHaveBeenCalled();
    });
    it("invokes Connect synchronously from the explicit gesture before awaiting package verification", async () => {
        const { workspace, deps } = await fixture();
        let resolve!: (value: LocalAppPublicPackage) => void;
        deps.loadPublicPackage.mockImplementationOnce(
            () => new Promise((done) => (resolve = done)),
        );
        const pending = workspace.connectApp("one");
        expect(deps.connectAppSetup).toHaveBeenCalledTimes(1);
        expect(workspace.state.catalog).toBeUndefined();
        resolve((await directoryFixture("one")).pkg);
        await expect(pending).resolves.toBe(true);
    });
    it("retains last good installation when either download or connected catalog is invalid", async () => {
        const { workspace, deps, connected } = await fixture();
        await workspace.connectApp("one");
        const before = workspace.state.catalog;
        deps.loadPublicPackage.mockRejectedValueOnce(new Error("secret network detail"));
        expect(await workspace.connectApp("one")).toBe(false);
        expect(workspace.state.catalog).toBe(before);
        expect(deps.connectAppSetup.mock.calls.at(-1)?.[1].aborted).toBe(true);
        connected.set("one", "{}");
        expect(await workspace.connectApp("one")).toBe(false);
        expect(workspace.state.catalog).toBe(before);
        expect(workspace.state.message).not.toContain("secret");
    });
    it.each(["account", "backend", "forget"])(
        "rejects a late connection after %s changed",
        async (change) => {
            const { workspace, deps, one } = await fixture();
            let resolve!: (value: string) => void;
            deps.connectAppSetup.mockImplementationOnce(
                () => new Promise((done) => (resolve = done)),
            );
            const pending = workspace.connectApp("one");
            if (change === "forget") await workspace.forgetSetup();
            else
                workspace.setAccount(
                    change === "account" ? "other-account" : "synthetic-account",
                    change === "backend" ? "other-backend" : "https://backend.test|index",
                );
            resolve(one.connectedJson);
            expect(await pending).toBe(false);
            expect(workspace.state.catalog).toBeUndefined();
            expect(deps.connectAppSetup.mock.calls[0][1].aborted).toBe(true);
        },
    );
    it("updates compatible public recipes while preserving opt-ins, never enabling new apps", async () => {
        const { workspace, packages, setDirectory, two } = await fixture();
        await workspace.connectApp("one");
        workspace.replaceEnabledChats("synthetic-account", workspace.state.catalog!, [
            { chatKey: "chat", appIds: ["one"] },
        ]);
        const update = await directoryFixture("one", "2");
        packages.set("one", update.pkg);
        setDirectory({ version: 1, apps: [update.descriptor, two.descriptor] });
        expect(await workspace.refreshDirectory()).toBe(true);
        expect(workspace.state.catalog?.apps[0].revision).toBe("2");
        expect(workspace.state.enabledChats).toEqual([{ chatKey: "chat", appIds: ["one"] }]);
        expect(workspace.state.catalog?.apps).toHaveLength(1);
    });
    it("requires reconnect for opaque private context instead of merging it with a new recipe", async () => {
        const { workspace, packages, setDirectory, deps } = await fixture(true);
        await workspace.connectApp("one");
        const old = workspace.state.catalog;
        const update = await directoryFixture("one", "2");
        packages.set("one", update.pkg);
        setDirectory(update.directory);
        deps.loadPublicPackage.mockClear();
        await workspace.refreshDirectory();
        expect(workspace.state.catalog).toBe(old);
        expect(deps.loadPublicPackage).not.toHaveBeenCalled();
        expect(workspace.state.appUpdates.one).toContain("Connect again");
    });
    it("requires explicit reconnect for changed publisher or destination and revokes old opt-ins", async () => {
        const { workspace, packages, connected, setDirectory } = await fixture();
        await workspace.connectApp("one");
        workspace.replaceEnabledChats("synthetic-account", workspace.state.catalog!, [
            { chatKey: "chat", appIds: ["one"] },
        ]);
        const update = await directoryFixture("one", "2");
        const descriptor = {
            ...update.descriptor,
            setupUrl: "https://publisher.test/new-connection",
        };
        packages.set("one", update.pkg);
        connected.set("one", update.connectedJson);
        setDirectory({ version: 1, apps: [descriptor] });
        await workspace.refreshDirectory();
        expect(workspace.state.catalog?.apps[0].revision).toBe("1");
        expect(workspace.state.appUpdates.one).toContain("approve");
        await workspace.connectApp("one");
        expect(workspace.state.enabledChats).toEqual([]);
    });
    it("defers updates throughout a draft and keeps its exact recipe until explicit discard", async () => {
        const { workspace, packages, setDirectory, deps } = await fixture();
        await workspace.connectApp("one");
        await propose(workspace);
        workspace.review();
        const approval = workspace.state.draft?.approval;
        const update = await directoryFixture("one", "2");
        packages.set("one", update.pkg);
        setDirectory(update.directory);
        deps.loadDirectory.mockClear();
        expect(await workspace.refreshDirectory()).toBe(false);
        expect(deps.loadDirectory).not.toHaveBeenCalled();
        expect(workspace.state.draft?.approval).toBe(approval);
        expect(workspace.state.catalog?.apps[0].revision).toBe("1");
        workspace.discard();
        await vi.waitFor(() => expect(workspace.state.catalog?.apps[0].revision).toBe("2"));
    });
    it("keeps the last good directory and cached apps on fetch failure", async () => {
        const { workspace, deps } = await fixture();
        await workspace.connectApp("one");
        const directory = workspace.state.directory;
        const catalog = workspace.state.catalog;
        deps.loadDirectory.mockRejectedValueOnce(new Error("offline"));
        expect(await workspace.refreshDirectory()).toBe(false);
        expect(workspace.state.directory).toBe(directory);
        expect(workspace.state.catalog).toBe(catalog);
        workspace.select("one", "add");
        expect(workspace.state.processorReady).toBe(true);
    });
    it("round-trips both artifacts and bound private setup, without persisting a proposal", async () => {
        let saved: LocalAppSetupSnapshot | undefined;
        const storage = {
            read: vi.fn(async () => saved),
            write: vi.fn(async (_scope, value) => {
                saved = await decodeLocalAppSetup(_scope, await encodeLocalAppSetup(_scope, value));
            }),
            remove: vi.fn(async () => {
                saved = undefined;
            }),
        } satisfies LocalAppSetupStorage;
        const { workspace } = await fixture(true, storage);
        await workspace.connectApp("one");
        await workspace.connectApp("two");
        await vi.waitFor(() => expect(saved?.processors).toHaveLength(2));
        workspace.clear();
        workspace.setAccount("synthetic-account", "https://backend.test|index");
        await vi.waitFor(() => expect(workspace.state.setupLoading).toBe(false));
        workspace.select("one", "add");
        expect(workspace.state.processorReady).toBe(true);
        expect(workspace.selection()?.action.processorContext).toEqual({
            privateLabels: ["Private choice"],
        });
        await vi.waitFor(() => expect(saved?.appId).toBe("one"));
        const writes = storage.write.mock.calls.length;
        await propose(workspace);
        workspace.review();
        expect(storage.write).toHaveBeenCalledTimes(writes);
        expect(JSON.stringify(saved)).not.toContain("synthetic input not for setup");
        expect(JSON.stringify(saved)).not.toContain("approvalId");
    });
});
