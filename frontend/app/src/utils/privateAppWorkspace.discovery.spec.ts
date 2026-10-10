// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { Principal } from "@icp-sdk/core/principal";
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
import { loadLocalAppDirectory } from "./localAppDirectory";
import { parseLocalAppCatalog } from "./localAppCatalog";
import type { extractPrivateAppAction } from "./aiActionRunner";
import { verifyImportedLocalProcessor, type runIsolatedAppProcessor } from "./isolatedAppProcessor";
import type { LocalDraftDelivery } from "./localAppDrafts";

vi.mock("@client", () => ({ currentUserIdStore: { value: "synthetic-account" } }));
vi.mock("@shared", () => ({ ANON_USER_ID: "anonymous" }));
vi.mock("./aiActionRunner", () => ({ extractPrivateAppAction: vi.fn() }));
vi.mock("./nativeAppDelivery", () => ({
    nativeAppDelivery: { deliver: vi.fn(), cancelAll: vi.fn() },
    nativeDeliveryAllowed: vi.fn(() => false),
}));
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
    it.each(["network", "abort", "generation", "duplicate"])(
        "keeps installations, opt-ins and the last full list when registry pagination fails: %s",
        async (failure) => {
            const { workspace, deps, two } = await fixture();
            await workspace.connectApp("one");
            workspace.replaceEnabledChats("synthetic-account", workspace.state.catalog!, [
                { chatKey: "chat", appIds: ["one"] },
            ]);
            const directory = workspace.state.directory;
            const catalog = workspace.state.catalog;
            const owner = {
                principal: Principal.fromUint8Array(new Uint8Array([1, 2, 3, 2])).toText(),
                origin: "https://publisher.test",
            };
            const abort = new AbortController();
            const fetcher = vi.fn<typeof fetch>(async (): Promise<Response> => {
                const page = fetcher.mock.calls.length - 1;
                if (page === 1 && failure === "network") throw new Error("offline");
                if (page === 1 && failure === "abort") abort.abort();
                return new Response(
                    JSON.stringify({
                        version: 2,
                        generation: page === 1 && failure === "generation" ? "43" : "42",
                        page,
                        apps:
                            page === 0 || failure === "duplicate"
                                ? [{ ...two.descriptor, publisher: owner }]
                                : [],
                        next: page === 0 ? "/openchat/pages/42/1.json" : null,
                    }),
                );
            });
            deps.loadDirectory.mockImplementationOnce(() =>
                loadLocalAppDirectory(directorySource, abort.signal, fetcher),
            );
            expect(await workspace.refreshDirectory()).toBe(false);
            expect(fetcher).toHaveBeenCalledTimes(2);
            expect(workspace.state.directory).toBe(directory);
            expect(workspace.state.catalog).toBe(catalog);
            expect(workspace.state.disabledAppIds).toEqual([]);
            expect(workspace.state.enabledChats).toEqual([{ chatKey: "chat", appIds: ["one"] }]);
            workspace.select("one", "add");
            expect(workspace.state.processorReady).toBe(true);
        },
    );

    it("never auto-migrates a legacy connection; later compatible registry updates retain opt-ins", async () => {
        const { workspace, deps, packages, connected, setDirectory, one } = await fixture();
        await workspace.connectApp("one");
        const owner = {
            principal: Principal.fromUint8Array(new Uint8Array([1, 2, 3, 2])).toText(),
            origin: "https://publisher.test",
        };
        setDirectory({
            version: 2,
            generation: "1",
            apps: [{ ...one.descriptor, publisher: owner }],
        });
        deps.loadPublicPackage.mockClear();
        await workspace.refreshDirectory();
        expect(deps.loadPublicPackage).not.toHaveBeenCalled();
        expect(workspace.state.appUpdates.one).toContain("approve");
        expect(await workspace.connectApp("one")).toBe(true);
        workspace.replaceEnabledChats("synthetic-account", workspace.state.catalog!, [
            { chatKey: "chat", appIds: ["one"] },
        ]);
        const update = await directoryFixture("one", "2");
        packages.set("one", update.pkg);
        connected.set("one", update.connectedJson);
        setDirectory({
            version: 2,
            generation: "2",
            apps: [{ ...update.descriptor, publisher: owner }],
        });
        expect(await workspace.refreshDirectory()).toBe(true);
        expect(workspace.state.catalog?.apps[0].revision).toBe("2");
        expect(workspace.state.enabledChats).toEqual([{ chatKey: "chat", appIds: ["one"] }]);
        setDirectory({
            version: 2,
            generation: "3",
            apps: [
                {
                    ...update.descriptor,
                    publisher: {
                        ...owner,
                        principal: Principal.fromUint8Array(new Uint8Array([4, 5, 6, 2])).toText(),
                    },
                },
            ],
        });
        deps.loadPublicPackage.mockClear();
        expect(await workspace.refreshDirectory()).toBe(true);
        expect(deps.loadPublicPackage).not.toHaveBeenCalled();
        expect(workspace.state.appUpdates.one).toContain("approve");
        expect(workspace.state.catalog?.apps[0].revision).toBe("2");
        expect(workspace.state.enabledChats).toEqual([{ chatKey: "chat", appIds: ["one"] }]);
        expect(await workspace.connectApp("one")).toBe(true);
        expect(workspace.state.enabledChats).toEqual([]);
    });

    it("does not disable a connected app while it is still on a later registry page", async () => {
        const { workspace, deps, one, two } = await fixture();
        await workspace.connectApp("one");
        const owner = {
            principal: Principal.fromUint8Array(new Uint8Array([1, 2, 3, 2])).toText(),
            origin: "https://publisher.test",
        };
        const fetcher = vi.fn<typeof fetch>(async (): Promise<Response> => {
            const page = fetcher.mock.calls.length - 1;
            return new Response(
                JSON.stringify({
                    version: 2,
                    generation: "42",
                    page,
                    apps: [{ ...(page === 0 ? two.descriptor : one.descriptor), publisher: owner }],
                    next: page === 0 ? "/openchat/pages/42/1.json" : null,
                }),
            );
        });
        deps.loadDirectory.mockImplementationOnce(() =>
            loadLocalAppDirectory(directorySource, new AbortController().signal, fetcher),
        );
        expect(await workspace.refreshDirectory()).toBe(true);
        expect(workspace.state.directory?.apps.map((app) => app.id)).toEqual(["two", "one"]);
        expect(workspace.state.disabledAppIds).toEqual([]);
    });

    it("disconnects only one app while retaining its card and revoking permission to send", async () => {
        const { workspace, deps } = await fixture();
        await workspace.connectApp("one");
        await workspace.connectApp("two");
        workspace.replaceEnabledChats("synthetic-account", workspace.state.catalog!, [
            { chatKey: "chat", appIds: ["one", "two"] },
        ]);
        workspace.selectForProposal("one", "add");
        await propose(workspace);
        const cardId = workspace.state.draft!.id;
        const fields = workspace.state.editorJson;
        expect(workspace.review()).toBe(true);
        const approvalId = workspace.state.draft!.approval!.approvalId;

        expect(await workspace.disconnectApp("one")).toBe(true);
        expect(workspace.state.catalog?.apps.map((app) => app.id)).toEqual(["two"]);
        expect(workspace.state.enabledChats).toEqual([{ chatKey: "chat", appIds: ["two"] }]);
        expect(workspace.state.cards.map((card) => card.id)).toEqual([cardId]);
        expect(workspace.state.editorJson).toBe(fields);
        expect(workspace.state.activeCardApp?.id).toBe("one");
        expect(workspace.state.draft?.approval).toBeUndefined();
        expect(workspace.review()).toBe(false);
        await workspace.confirm(approvalId);
        expect(deps.deliver).not.toHaveBeenCalled();
    });

    it("connects another app without replacing the active saved card or its fields", async () => {
        const { workspace, deps } = await fixture();
        await workspace.connectApp("one");
        await propose(workspace);
        const card = workspace.state.draft!;
        const fields = workspace.state.editorJson;
        expect(await workspace.connectApp("two")).toBe(true);
        expect(workspace.state.catalog?.apps.map((app) => app.id)).toEqual(["one", "two"]);
        expect(workspace.state.draft?.id).toBe(card.id);
        expect(workspace.state.activeCardApp?.id).toBe("one");
        expect(workspace.state.editorJson).toBe(fields);
        expect(workspace.selection()?.app.id).toBe("one");
        expect(deps.deliver).not.toHaveBeenCalled();
    });

    it("persists disconnecting the last app without deleting setup storage or cards", async () => {
        const storage: LocalAppSetupStorage = {
            read: vi.fn(async () => undefined),
            write: vi.fn(async () => {}),
            remove: vi.fn(async () => {}),
        };
        const { workspace } = await fixture(false, storage);
        await workspace.connectApp("one");
        await propose(workspace);
        const cardId = workspace.state.draft!.id;
        await workspace.disconnectApp("one");
        await vi.waitFor(() => {
            const saved = vi.mocked(storage.write).mock.calls.at(-1)?.[1];
            expect(saved?.catalog.apps).toEqual([]);
            expect(saved?.appId).toBeUndefined();
            expect(saved?.actionId).toBeUndefined();
            expect(saved?.processors).toEqual([]);
            expect(saved?.installations).toEqual([]);
        });
        expect(workspace.state.cards.map((card) => card.id)).toEqual([cardId]);
        expect(storage.remove).not.toHaveBeenCalled();
    });

    it("reconnects an unchanged app without restoring a previous approval", async () => {
        const { workspace, deps } = await fixture();
        await workspace.connectApp("one");
        await propose(workspace);
        expect(workspace.review()).toBe(true);
        const approvalId = workspace.state.draft!.approval!.approvalId;
        await workspace.disconnectApp("one");
        await workspace.connectApp("one");
        expect(workspace.state.draft?.approval).toBeUndefined();
        await workspace.confirm(approvalId);
        expect(deps.deliver).not.toHaveBeenCalled();
        expect(workspace.review()).toBe(true);
    });

    it("lists available apps while keeping retained card configurations pinned", async () => {
        const { workspace, deps } = await fixture();
        await workspace.connectApp("one");
        await propose(workspace);
        const cardId = workspace.state.draft!.id;
        const loads = deps.loadDirectory.mock.calls.length;
        expect(await workspace.refreshDirectory()).toBe(true);
        expect(deps.loadDirectory).toHaveBeenCalledTimes(loads + 1);
        expect(workspace.state.directory?.apps.map((app) => app.id)).toEqual(["one", "two"]);
        expect(workspace.state.draft?.id).toBe(cardId);
        expect(deps.deliver).not.toHaveBeenCalled();
    });

    it.each(["private setup", "publisher", "destination", "inbox", "recipe"] as const)(
        "reports a changed %s with a reviewed card without changing its approval or setup",
        async (change) => {
            const { workspace, deps, packages, setDirectory } = await fixture(
                change === "private setup",
            );
            await workspace.connectApp("one");
            workspace.replaceEnabledChats("synthetic-account", workspace.state.catalog!, [
                { chatKey: "chat", appIds: ["one"] },
            ]);
            await propose(workspace);
            expect(workspace.review()).toBe(true);
            const draft = workspace.state.draft!;
            const catalog = workspace.state.catalog;
            const fields = workspace.state.editorJson;
            const update = await directoryFixture("one", "2");
            let descriptor = update.descriptor;
            let pkg = update.pkg;
            if (change === "publisher") {
                descriptor = { ...descriptor, setupUrl: "https://publisher.test/new-connection" };
            } else if (change === "destination" || change === "inbox") {
                const document = JSON.parse(update.catalogJson);
                if (change === "destination") {
                    document.apps[0].destination = "https://publisher.test/new-import";
                } else {
                    document.apps[0].deliveryInbox = {
                        version: 1,
                        kind: "ic-canister",
                        host: "https://publisher.test",
                        canisterId: Principal.fromUint8Array(new Uint8Array([1, 2, 3, 2])).toText(),
                    };
                }
                const catalogJson = JSON.stringify(document);
                const bytes = new TextEncoder().encode(catalogJson);
                const sha256 = Array.from(
                    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
                    (byte) => byte.toString(16).padStart(2, "0"),
                ).join("");
                descriptor = {
                    ...descriptor,
                    catalog: { ...descriptor.catalog, byteLength: bytes.byteLength, sha256 },
                };
                pkg = { ...pkg, catalogJson, catalog: parseLocalAppCatalog(catalogJson) };
            }
            packages.set("one", pkg);
            setDirectory({ version: 1, apps: [descriptor] });
            deps.loadPublicPackage.mockClear();
            deps.connectAppSetup.mockClear();
            expect(await workspace.refreshDirectory()).toBe(true);
            expect(workspace.state.appUpdates.one).toContain("Connect");
            if (change === "destination" || change === "inbox")
                expect(workspace.state.appUpdates.one).toContain(change);
            expect(workspace.state.catalog).toBe(catalog);
            expect(workspace.state.draft).toEqual(draft);
            expect(workspace.state.draft?.approval).toBe(draft.approval);
            expect(workspace.state.activeCardApp).toBe(catalog!.apps[0]);
            expect(workspace.state.editorJson).toBe(fields);
            expect(workspace.state.enabledChats).toEqual([{ chatKey: "chat", appIds: ["one"] }]);
            expect(deps.connectAppSetup).not.toHaveBeenCalled();
            expect(deps.deliver).not.toHaveBeenCalled();
            if (change === "private setup" || change === "publisher")
                expect(deps.loadPublicPackage).not.toHaveBeenCalled();
        },
    );

    it("inspects every installed app with saved cards instead of stopping at the first deferred update", async () => {
        const { workspace, packages, setDirectory } = await fixture();
        await workspace.connectApp("one");
        await workspace.connectApp("two");
        workspace.selectForProposal("one", "add");
        await propose(workspace);
        const catalog = workspace.state.catalog;
        const one = await directoryFixture("one", "2");
        const two = await directoryFixture("two", "2");
        packages.set("one", one.pkg);
        packages.set("two", two.pkg);
        setDirectory({
            version: 1,
            apps: [
                one.descriptor,
                { ...two.descriptor, setupUrl: "https://publisher.test/changed" },
            ],
        });
        expect(await workspace.refreshDirectory()).toBe(true);
        expect(workspace.state.appUpdates.one).toContain("Connect again");
        expect(workspace.state.appUpdates.two).toContain("changed publisher");
        expect(workspace.state.catalog).toBe(catalog);
        expect(workspace.state.cards).toHaveLength(1);
    });

    it("reports an unlisted app without changing retained card approvals or chat opt-ins", async () => {
        const { workspace, setDirectory, two } = await fixture();
        await workspace.connectApp("one");
        workspace.replaceEnabledChats("synthetic-account", workspace.state.catalog!, [
            { chatKey: "chat", appIds: ["one"] },
        ]);
        await propose(workspace);
        expect(workspace.review()).toBe(true);
        const draft = workspace.state.draft!;
        setDirectory(two.directory);
        expect(await workspace.refreshDirectory()).toBe(true);
        expect(workspace.state.appUpdates.one).toContain("No longer listed");
        expect(workspace.state.appUpdates.one).not.toContain("Disabled");
        expect(workspace.state.disabledAppIds).toEqual([]);
        expect(workspace.state.enabledChats).toEqual([{ chatKey: "chat", appIds: ["one"] }]);
        expect(workspace.state.draft).toEqual(draft);
        expect(workspace.state.draft?.approval).toBe(draft.approval);
    });

    it("retains a card's original fields and blocks sending after reconnecting changed setup", async () => {
        const { workspace, deps, packages, connected, setDirectory } = await fixture();
        await workspace.connectApp("one");
        await propose(workspace);
        const cardId = workspace.state.draft!.id;
        const fields = workspace.state.editorJson;
        expect(workspace.review()).toBe(true);
        const approvalId = workspace.state.draft!.approval!.approvalId;
        const update = await directoryFixture("one", "2");
        packages.set("one", update.pkg);
        connected.set("one", update.connectedJson);
        setDirectory(update.directory);
        await workspace.refreshDirectory();
        expect(await workspace.connectApp("one")).toBe(true);
        expect(workspace.state.catalog?.apps[0].revision).toBe("2");
        expect(workspace.state.activeCardApp?.revision).toBe("1");
        expect(workspace.state.draft?.id).toBe(cardId);
        expect(workspace.state.editorJson).toBe(fields);
        expect(workspace.state.draft?.approval).toBeUndefined();
        expect(workspace.review()).toBe(false);
        await workspace.confirm(approvalId);
        expect(deps.deliver).not.toHaveBeenCalled();
    });

    it.each(["uncertain", "delivered"] as const)(
        "explains blocked %s recovery after changed setup without retargeting the original request",
        async (kind) => {
            const { workspace, deps, one, packages, connected, setDirectory } = await fixture();
            const withRecipient = (json: string) => {
                const catalog = JSON.parse(json);
                catalog.apps[0].deliveryEncryption = {
                    version: 1,
                    scheme: "p256-hkdf-sha256-aes-256-gcm-v1",
                    keyId: "a".repeat(64),
                    publicKeySpki: btoa("\0".repeat(91)).replace(/=+$/, ""),
                    recipientContext: "AQ",
                };
                return JSON.stringify(catalog);
            };
            const originalSetup = withRecipient(one.connectedJson);
            connected.set("one", originalSetup);
            await workspace.connectApp("one");
            await propose(workspace);
            expect(workspace.review()).toBe(true);
            const approval = workspace.state.draft!.approval!;
            deps.deliver.mockResolvedValue({ kind });
            await workspace.confirm(approval.approvalId);
            const originalDraft = workspace.state.draft!;
            const originalFields = workspace.state.editorJson;
            const originalCatalog = workspace.state.catalog;
            const update = await directoryFixture("one", "2");
            packages.set("one", update.pkg);
            connected.set("one", withRecipient(update.connectedJson));
            setDirectory(update.directory);
            expect(await workspace.refreshDirectory()).toBe(true);
            expect(workspace.state.appUpdates.one).toContain("Connect again");
            expect(workspace.state.draft).toEqual(originalDraft);
            expect(workspace.state.draft?.approval).toBe(originalDraft.approval);
            expect(workspace.state.catalog).toBe(originalCatalog);
            expect(deps.deliver).toHaveBeenCalledOnce();
            expect(await workspace.connectApp("one")).toBe(true);
            expect(workspace.state.cardReviewBlockedReason).toContain("inspect-only");
            expect(workspace.review()).toBe(false);
            expect(workspace.state.message).toBe(workspace.state.cardReviewBlockedReason);
            expect(workspace.state.message).toContain("Check the receiving app");
            expect(workspace.state.draft).toMatchObject({
                id: originalDraft.id,
                status: kind,
                target: originalDraft.target,
                payload: originalDraft.payload,
            });
            expect(workspace.state.editorJson).toBe(originalFields);
            expect(workspace.state.draft?.approval).toBeUndefined();
            await workspace.retryUncertain(approval.approvalId);
            await workspace.reopenDelivered(approval.approvalId);
            expect(deps.deliver).toHaveBeenCalledOnce();
            expect(deps.extract).toHaveBeenCalledOnce();

            packages.set("one", one.pkg);
            connected.set("one", originalSetup);
            setDirectory(one.directory);
            await workspace.refreshDirectory();
            expect(await workspace.connectApp("one")).toBe(true);
            expect(workspace.state.cardReviewBlockedReason).toBeUndefined();
            expect(workspace.review()).toBe(true);
            expect(workspace.state.draft!.approval!.request).toEqual(approval.request);
            expect(deps.deliver).toHaveBeenCalledOnce();
            expect(deps.extract).toHaveBeenCalledOnce();
        },
    );

    it("changes chat opt-ins with an attempted card without changing its request or bypassing setup guards", async () => {
        const { workspace, deps, one, connected, setDirectory } = await fixture();
        const setup = JSON.parse(one.connectedJson);
        setup.apps[0].deliveryEncryption = {
            version: 1,
            scheme: "p256-hkdf-sha256-aes-256-gcm-v1",
            keyId: "a".repeat(64),
            publicKeySpki: btoa("\0".repeat(91)).replace(/=+$/, ""),
            recipientContext: "AQ",
        };
        connected.set("one", JSON.stringify(setup));
        await workspace.connectApp("one");
        await workspace.connectApp("two");
        setDirectory(one.directory);
        await workspace.refreshDirectory();
        expect(workspace.state.disabledAppIds).toContain("two");
        workspace.selectForProposal("one", "add");
        await propose(workspace);
        expect(workspace.review()).toBe(true);
        deps.deliver.mockResolvedValue({ kind: "uncertain" });
        await workspace.confirm(workspace.state.draft!.approval!.approvalId);
        const prior = workspace.state.draft!;
        const fields = workspace.state.editorJson;
        const catalog = workspace.state.catalog!;
        const rows = [{ chatKey: "synthetic-chat", appIds: ["one"] }];
        expect(workspace.replaceEnabledChats("synthetic-account", catalog, rows)).toBe(true);
        expect(workspace.state.enabledChats).toEqual(rows);
        expect(workspace.state.draft).toEqual(prior);
        expect(workspace.state.draft!.approval!.request).toBe(prior.approval!.request);
        expect(workspace.replaceEnabledChats("synthetic-account", catalog, [])).toBe(true);
        expect(workspace.state.draft).toEqual(prior);
        expect(workspace.state.draft!.approval!.request).toBe(prior.approval!.request);
        expect(workspace.replaceEnabledChats("other-account", catalog, rows)).toBe(false);
        expect(workspace.replaceEnabledChats("synthetic-account", { ...catalog }, rows)).toBe(
            false,
        );
        expect(
            workspace.replaceEnabledChats("synthetic-account", catalog, [
                { chatKey: "synthetic-chat", appIds: ["two"] },
            ]),
        ).toBe(false);
        workspace.setFieldEditBlocked(true);
        expect(workspace.replaceEnabledChats("synthetic-account", catalog, rows)).toBe(false);
        workspace.setFieldEditBlocked(false);
        deps.connectAppSetup.mockImplementationOnce(() => new Promise(() => {}));
        const pending = workspace.connectApp("one");
        expect(workspace.state.busy).toBe(true);
        expect(workspace.replaceEnabledChats("synthetic-account", catalog, rows)).toBe(false);
        expect(workspace.cancelConnection()).toBe(true);
        expect(await pending).toBe(false);
        expect(workspace.state.draft).toMatchObject({
            id: prior.id,
            status: "uncertain",
            target: prior.target,
            payload: prior.payload,
        });
        expect(workspace.state.editorJson).toBe(fields);
        expect(workspace.state.draft?.approval).toBeUndefined();
        expect(workspace.review()).toBe(true);
        expect(workspace.state.draft!.approval!.request).toEqual(prior.approval!.request);
        expect(deps.deliver).toHaveBeenCalledOnce();
        expect(deps.extract).toHaveBeenCalledOnce();
    });

    it("does not open an empty card host when no connected action is selected", async () => {
        const { workspace, deps } = await fixture();
        expect(await propose(workspace)).toBe("retryable");
        expect(workspace.state.open).toBe(false);
        expect(deps.extract).not.toHaveBeenCalled();
        expect(deps.deliver).not.toHaveBeenCalled();
    });

    it("cancels a stalled connection without discarding cards even if transport ignores abort", async () => {
        const { workspace, deps, two } = await fixture();
        await workspace.connectApp("one");
        await propose(workspace);
        const cardId = workspace.state.draft!.id;
        let finish!: (json: string) => void;
        deps.connectAppSetup.mockImplementationOnce(
            () => new Promise((resolve) => (finish = resolve)),
        );
        const pending = workspace.connectApp("two");
        expect(workspace.state.pendingConnectionAppId).toBe("two");
        expect(workspace.cancelConnection("one")).toBe(false);
        expect(workspace.cancelConnection()).toBe(true);
        expect(await pending).toBe(false);
        expect(workspace.state.busy).toBe(false);
        expect(workspace.state.pendingConnectionAppId).toBeUndefined();
        expect(workspace.state.message).toContain("Connection cancelled");
        finish(two.connectedJson);
        await Promise.resolve();
        expect(workspace.state.catalog?.apps.map((app) => app.id)).toEqual(["one"]);
        expect(workspace.state.cards.map((card) => card.id)).toEqual([cardId]);
        expect(deps.deliver).not.toHaveBeenCalled();
        expect(workspace.cancelConnection()).toBe(false);
    });

    it("does not treat model processing as a cancellable connection", async () => {
        const { workspace, deps } = await fixture();
        await workspace.connectApp("one");
        let finish!: () => void;
        deps.extract.mockImplementationOnce(
            () =>
                new Promise(
                    (resolve) => (finish = () => resolve({ kind: "no_extraction", raw: "" })),
                ),
        );
        const pending = propose(workspace);
        expect(workspace.state.busy).toBe(true);
        expect(workspace.state.pendingConnectionAppId).toBeUndefined();
        expect(workspace.cancelConnection("one")).toBe(false);
        expect(workspace.state.busy).toBe(true);
        finish();
        await pending;
        expect(workspace.state.busy).toBe(false);
    });

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
        expect(await refresh).toBe(true);
        expect(workspace.state.disabledAppIds).toEqual([]);
        expect(workspace.state.draft).toBeDefined();
        expect(workspace.state.appUpdates.one).toContain("No longer listed");
    });
    it("does not change a pending send when a directory response arrives during delivery", async () => {
        const { workspace, deps, one, connected } = await fixture();
        const setup = JSON.parse(one.connectedJson);
        setup.apps[0].deliveryEncryption = {
            version: 1,
            scheme: "p256-hkdf-sha256-aes-256-gcm-v1",
            keyId: "a".repeat(64),
            publicKeySpki: btoa("\0".repeat(91)).replace(/=+$/, ""),
            recipientContext: "AQ",
        };
        connected.set("one", JSON.stringify(setup));
        await workspace.connectApp("one");
        await propose(workspace);
        expect(workspace.review()).toBe(true);
        const approval = workspace.state.draft!.approval!;
        const catalog = workspace.state.catalog;
        let finishDirectory!: (value: LocalAppDirectory) => void;
        deps.loadDirectory.mockImplementationOnce(
            () => new Promise((resolve) => (finishDirectory = resolve)),
        );
        let finishDelivery!: () => void;
        deps.deliver.mockImplementationOnce(
            () => new Promise((resolve) => (finishDelivery = () => resolve({ kind: "uncertain" }))),
        );
        const refresh = workspace.refreshDirectory();
        const send = workspace.confirm(approval.approvalId);
        const sending = workspace.state.draft!;
        expect(sending.status).toBe("sending");
        finishDirectory({ version: 1, apps: [] });
        expect(await refresh).toBe(false);
        expect(workspace.state.catalog).toBe(catalog);
        expect(workspace.state.draft).toEqual(sending);
        expect(workspace.state.draft?.approval).toBe(approval);
        expect(workspace.state.disabledAppIds).toEqual([]);
        expect(deps.deliver).toHaveBeenCalledOnce();
        finishDelivery();
        await send;
        expect(workspace.state.busy).toBe(false);
        expect(workspace.state.draft?.status).toBe("uncertain");
        expect(workspace.state.draft?.approval?.request).toBe(approval.request);
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
            expect(workspace.state.pendingConnectionAppId).toBe("one");
            if (change === "forget") await workspace.forgetSetup();
            else
                workspace.setAccount(
                    change === "account" ? "other-account" : "synthetic-account",
                    change === "backend" ? "other-backend" : "https://backend.test|index",
                );
            expect(workspace.state.pendingConnectionAppId).toBeUndefined();
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
        expect(await workspace.refreshDirectory()).toBe(true);
        expect(deps.loadDirectory).toHaveBeenCalledTimes(1);
        expect(workspace.state.appUpdates.one).toContain("Connect again");
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
