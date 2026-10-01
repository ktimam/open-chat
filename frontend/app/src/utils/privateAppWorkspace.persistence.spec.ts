// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { MessageContent, OpenChat } from "@client";
import { PrivateAppWorkspace } from "./privateAppWorkspace";
import { parseLocalAppCatalog } from "./localAppCatalog";
import {
    createLocalAppDraftStorage,
    type EncryptedLocalDraftRecord,
    type LocalAppDraftStorage,
    type LocalDraftRecordBackend,
} from "./localAppDraftPersistence";
import type { LocalAppSetupStorage } from "./localAppSetupStore";
import type { LocalDraftDelivery } from "./localAppDrafts";
import type { extractPrivateAppAction } from "./aiActionRunner";

vi.mock("@client", () => ({ currentUserIdStore: { value: "synthetic" } }));
vi.mock("@shared", () => ({ ANON_USER_ID: "anonymous" }));
vi.mock("./aiActionRunner", () => ({ extractPrivateAppAction: vi.fn() }));
vi.mock("./isolatedAppProcessor", () => ({
    runIsolatedAppProcessor: vi.fn(),
    verifyImportedLocalProcessor: vi.fn(),
}));
vi.mock("./localAppRelayDelivery", async () => ({
    deliverLocalAppViaRelay: vi.fn(),
    cancelLocalAppHandoffs: vi.fn(),
    localAppDeliveryStatus: (await import("svelte/store")).writable(undefined),
}));

const scope = { account: "account-a", backend: "backend-a" };
const content = { kind: "text_content", text: "PRIVATE_SOURCE_NOT_STORED" } as MessageContent;
const client = { clientOnlyApps: () => true, isNativeApp: () => false } as OpenChat;
const catalog = parseLocalAppCatalog(
    JSON.stringify({
        version: 1,
        apps: [
            {
                id: "sample",
                revision: "1",
                name: "Sample",
                description: "Test only",
                destination: "https://example.invalid/import",
                deliveryEncryption: {
                    version: 1,
                    scheme: "p256-hkdf-sha256-aes-256-gcm-v1",
                    keyId: "a".repeat(64),
                    publicKeySpki: btoa("\0".repeat(91)).replace(/=+$/, ""),
                    recipientContext: "AQ",
                },
                actions: [
                    {
                        definition: {
                            name: "save",
                            description: "Save",
                            promptTemplate: "App-owned prompt",
                            responseSchema: {},
                            card: {
                                title: "Review",
                                rows: [{ label: "Value", valueKey: "value" }],
                                confirmLabel: "Save",
                                cancelLabel: "Cancel",
                            },
                        },
                        draftSchema: {
                            type: "object",
                            properties: { value: { type: "number" } },
                            required: ["value"],
                            additionalProperties: false,
                        },
                        handoff: { kind: "single" },
                    },
                ],
            },
        ],
    }),
);
function sharedStorage() {
    const records = new Map<string, EncryptedLocalDraftRecord>();
    const backend: LocalDraftRecordBackend = {
        read: async (key) => records.get(key),
        replace: async (key, expected, value) => {
            if (records.get(key)?.revision !== expected) throw new Error("stale");
            records.set(key, value);
        },
        remove: async (key, value) => {
            records.set(key, value);
        },
    };
    const setup = { catalog, appId: "sample", actionId: "save", enabledChats: [] };
    const setupStorage: LocalAppSetupStorage = {
        read: async () => setup,
        write: async () => {},
        remove: async () => {},
    };
    return { records, backend, setupStorage };
}
function fixture(
    shared = sharedStorage(),
    draftStorage: LocalAppDraftStorage = createLocalAppDraftStorage(shared.backend),
) {
    const crossed = vi.fn();
    const deliver = vi.fn<LocalDraftDelivery>(async (request, signal, beforeDelivery) => {
        await beforeDelivery;
        if (signal.aborted) return { kind: "uncertain" };
        crossed(request);
        return { kind: "delivered" };
    });
    const extract = vi.fn<typeof extractPrivateAppAction>(async () => ({
        kind: "extracted",
        candidates: [{ value: 42 }],
    }));
    const workspace = new PrivateAppWorkspace({
        extract,
        runProcessor: vi.fn(),
        verifyProcessor: vi.fn(),
        deliver,
        nativeDeliver: deliver,
        cancelDelivery: vi.fn(),
        deliverySaved: () => false,
        setupStorage: shared.setupStorage,
        draftStorage,
    });
    return { workspace, extract, deliver, crossed, storage: draftStorage, shared };
}
async function start(
    workspace: PrivateAppWorkspace,
    account = scope.account,
    backend = scope.backend,
) {
    workspace.setAccount(account, backend);
    workspace.setClient(client);
    await vi.waitFor(() =>
        expect(workspace.state.setupLoading || workspace.state.draftLoading).toBe(false),
    );
}
const saved = (workspace: PrivateAppWorkspace) =>
    vi.waitFor(() => expect(workspace.state.draftStorageStatus).toContain("Private card saved"));
async function propose(workspace: PrivateAppWorkspace) {
    await expect(workspace.propose(client, content, { stillCurrent: () => true })).resolves.toBe(
        "drafted",
    );
    await saved(workspace);
}

describe("private workspace encrypted-card lifecycle", () => {
    it("restores edited card across restart with no inference, approval, transmission or source message", async () => {
        const first = fixture();
        await start(first.workspace);
        await propose(first.workspace);
        first.workspace.edit('{"value":43}', "Private recipient");
        first.workspace.review();
        const oldApproval = first.workspace.state.draft!.approval!;
        await saved(first.workspace);
        first.workspace.close();
        first.workspace.clear();
        const next = fixture(first.shared);
        await start(next.workspace);
        expect(next.workspace.state.editorJson).toBe('{"value":43}');
        expect(next.workspace.state.recipient).toBe("Private recipient");
        expect(next.workspace.state.draft?.status).toBe("draft");
        expect(next.workspace.state.draft?.approval).toBeUndefined();
        expect(next.workspace.state.draftManualValues).toBe(true);
        expect(next.extract).not.toHaveBeenCalled();
        expect(next.deliver).not.toHaveBeenCalled();
        expect(JSON.stringify(await next.storage.read(scope))).not.toContain(
            "PRIVATE_SOURCE_NOT_STORED",
        );
        await next.workspace.confirm(oldApproval.approvalId);
        expect(next.deliver).not.toHaveBeenCalled();
        expect(next.workspace.review()).toBe(true);
        expect(next.workspace.state.draft?.approval?.request.idempotencyKey).toBe(
            oldApproval.request.idempotencyKey,
        );
    });

    it("survives logout but does not restore the card to a different account or backend", async () => {
        const first = fixture();
        await start(first.workspace);
        await propose(first.workspace);
        const id = first.workspace.state.draft!.id;
        first.workspace.setAccount(undefined);
        expect(first.workspace.state.draft).toBeUndefined();
        await start(first.workspace, "account-b");
        expect(first.workspace.state.draft).toBeUndefined();
        await start(first.workspace, scope.account, "backend-b");
        expect(first.workspace.state.draft).toBeUndefined();
        await start(first.workspace);
        expect(first.workspace.state.draft?.id).toBe(id);
        expect(first.deliver).not.toHaveBeenCalled();
    });

    it("explicit Discard or Forget removes the saved card and never replays it", async () => {
        const first = fixture();
        await start(first.workspace);
        await propose(first.workspace);
        first.workspace.discard();
        await vi.waitFor(() => expect(first.workspace.state.draftLoading).toBe(false));
        expect(await first.storage.read(scope)).toBeUndefined();
        await propose(first.workspace);
        await expect(first.workspace.forgetSetup()).resolves.toBe(true);
        expect(await first.storage.read(scope)).toBeUndefined();
        expect([...first.shared.records.values()].every((row) => !row.key && !row.ciphertext)).toBe(
            true,
        );
        const next = fixture(first.shared);
        await start(next.workspace);
        expect(next.workspace.state.draft).toBeUndefined();
        expect(next.deliver).not.toHaveBeenCalled();
    });

    it("keeps delivery gesture synchronous but gates transport on committed attempted-card storage", async () => {
        const first = fixture();
        await start(first.workspace);
        await propose(first.workspace);
        first.workspace.review();
        await saved(first.workspace);
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const replace = first.shared.backend.replace;
        first.shared.backend.replace = async (...args) => {
            await held;
            await replace(...args);
        };
        const pending = first.workspace.confirm(first.workspace.state.draft!.approval!.approvalId);
        expect(first.deliver).toHaveBeenCalledOnce();
        expect(first.deliver.mock.calls[0][2]).toBeInstanceOf(Promise);
        expect(first.crossed).not.toHaveBeenCalled();
        release();
        await pending;
        await saved(first.workspace);
        expect(first.crossed).toHaveBeenCalledOnce();
        expect((await first.storage.read(scope))?.draft.attempted).toBe(true);
    });

    it("does not deliver when write-ahead storage fails and visibly reports unsaved changes", async () => {
        const first = fixture();
        await start(first.workspace);
        await propose(first.workspace);
        first.workspace.review();
        await saved(first.workspace);
        first.shared.backend.replace = async () => {
            throw new Error("private quota error");
        };
        await first.workspace.confirm(first.workspace.state.draft!.approval!.approvalId);
        await vi.waitFor(() =>
            expect(first.workspace.state.draftStorageStatus).toContain("could not be saved"),
        );
        expect(first.crossed).not.toHaveBeenCalled();
        expect(first.workspace.state.draft?.status).toBe("uncertain");
        expect(first.workspace.state.draftStorageStatus).not.toContain("private quota error");
    });

    it("restores a dispatched card immutable and requires new review before retrying the exact original ID", async () => {
        const first = fixture();
        await start(first.workspace);
        await propose(first.workspace);
        first.workspace.review();
        const prior = first.workspace.state.draft!.approval!;
        await first.workspace.confirm(prior.approvalId);
        await saved(first.workspace);
        first.workspace.clear();
        const next = fixture(first.shared);
        await start(next.workspace);
        expect(next.workspace.state.draft?.status).toBe("uncertain");
        expect(next.workspace.state.draft?.approval).toBeUndefined();
        next.workspace.edit('{"value":123}', "changed");
        expect(next.workspace.state.draft?.payload).toEqual({ value: 42 });
        await next.workspace.retryUncertain(prior.approvalId);
        expect(next.deliver).not.toHaveBeenCalled();
        expect(next.workspace.review()).toBe(true);
        const reviewed = next.workspace.state.draft!.approval!;
        expect(reviewed.request).toEqual(prior.request);
        expect(reviewed.approvalId).not.toBe(prior.approvalId);
        await next.workspace.retryUncertain(reviewed.approvalId);
        expect(next.crossed).toHaveBeenCalledExactlyOnceWith(prior.request);
    });

    it("does not retarget a recovered card when the current app destination or key changes", async () => {
        const first = fixture();
        await start(first.workspace);
        await propose(first.workspace);
        first.workspace.clear();
        const changed = JSON.parse(JSON.stringify(catalog));
        changed.apps[0].destination = "https://another.invalid/import";
        first.shared.setupStorage.read = async () => ({
            catalog: parseLocalAppCatalog(JSON.stringify(changed)),
            appId: "sample",
            actionId: "save",
            enabledChats: [],
        });
        const next = fixture(first.shared);
        await start(next.workspace);
        expect(next.workspace.state.draft?.target.destination).toBe(
            "https://example.invalid/import",
        );
        expect(next.workspace.state.message).toContain("configuration changed");
        expect(next.workspace.review()).toBe(false);
        expect(next.deliver).not.toHaveBeenCalled();
    });

    it("ignores a stale restore after the signed-in account changes", async () => {
        const first = fixture();
        await start(first.workspace);
        await propose(first.workspace);
        const snapshot = await first.storage.read(scope);
        let release!: () => void;
        const wait = new Promise<void>((resolve) => {
            release = resolve;
        });
        const delayed: LocalAppDraftStorage = {
            read: async (owner) => {
                if (owner.account === scope.account) {
                    await wait;
                    return snapshot;
                }
                return undefined;
            },
            write: async () => {},
            remove: async () => {},
        };
        const next = fixture(first.shared, delayed);
        next.workspace.setAccount(scope.account, scope.backend);
        await vi.waitFor(() => expect(next.workspace.state.setupLoading).toBe(false));
        await start(next.workspace, "another-account");
        release();
        await Promise.resolve();
        await Promise.resolve();
        expect(next.workspace.state.account).toBe("another-account");
        expect(next.workspace.state.draft).toBeUndefined();
        expect(next.deliver).not.toHaveBeenCalled();
    });

    it("prompts reconnect instead of attempting an old unencrypted connection", async () => {
        const shared = sharedStorage();
        const old = JSON.parse(JSON.stringify(catalog));
        delete old.apps[0].deliveryEncryption;
        shared.setupStorage.read = async () => ({
            catalog: parseLocalAppCatalog(JSON.stringify(old)),
            appId: "sample",
            actionId: "save",
            enabledChats: [],
        });
        const first = fixture(shared);
        await start(first.workspace);
        await propose(first.workspace);
        first.workspace.review();
        await first.workspace.confirm(first.workspace.state.draft!.approval!.approvalId);
        expect(first.workspace.state.message).toContain("Reconnect this app");
        expect(first.deliver).not.toHaveBeenCalled();
    });
});
