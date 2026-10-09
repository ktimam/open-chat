// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { MessageContent, OpenChat } from "@client";
import { PrivateAppWorkspace, type ConnectLocalAppSetup } from "./privateAppWorkspace";
import { directoryFixture, directorySource } from "./localAppDirectory.testFixtures";
import { parseLocalAppCatalog } from "./localAppCatalog";
import {
    encodeLocalAppSetup,
    decodeLocalAppSetup,
    type LocalAppSetupStorage,
} from "./localAppSetupStore";
import { verifyImportedLocalProcessor } from "./isolatedAppProcessor";
import type { LocalAppSetupContext } from "./localAppScopedSetup";
import { localAppBase64Url, LOCAL_APP_ENCRYPTION_SCHEME } from "./localAppEncryption";
import { localAppInboxSha256, type LocalAppInboxGrant } from "./localAppInbox";
import type { LocalAppInboxDeposit } from "./localAppInboxDelivery";
import {
    createLocalAppDraftStorage,
    type EncryptedLocalDraftRecord,
} from "./localAppDraftPersistence";

vi.mock("@client", () => ({ currentUserIdStore: { value: "synthetic-account" } }));
vi.mock("@shared", () => ({ ANON_USER_ID: "anonymous" }));
vi.mock("./aiActionRunner", () => ({ extractPrivateAppAction: vi.fn() }));
vi.mock("./nativeAppDelivery", () => ({
    nativeAppDelivery: {},
    nativeDeliveryAllowed: () => false,
}));
vi.mock("./localAppRelayDelivery", async () => ({
    deliverLocalAppViaRelay: vi.fn(),
    cancelLocalAppHandoffs: vi.fn(),
    localAppDeliveryStatus: (await import("svelte/store")).writable(undefined),
}));
const accountId = "A".repeat(43);
const client = { clientOnlyApps: () => true } as OpenChat;
type TestReply = {
    version: number;
    scope: string;
    appId: string;
    accountId: string;
    catalogJson: string;
    routes: { handle: string; catalogJson: string }[];
};

async function fixture(inbox = false) {
    const base = await directoryFixture("sample");
    const endpoint = {
        version: 1 as const,
        kind: "ic-canister" as const,
        host: "https://publisher.test",
        canisterId: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    };
    const key = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
        "deriveBits",
    ]);
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", key.publicKey));
    const encryption = {
        version: 1 as const,
        scheme: LOCAL_APP_ENCRYPTION_SCHEME,
        keyId: await localAppInboxSha256(spki),
        publicKeySpki: localAppBase64Url(spki),
    };
    const expiresAtMs = Date.now() + 86_400_000;
    const grantFor = (label: string): LocalAppInboxGrant => ({
        ...endpoint,
        inboxId: (label === "Destination A" ? "a" : label === "Destination B" ? "b" : "c").repeat(
            64,
        ),
        writeCapability: localAppBase64Url(
            new Uint8Array(32).fill(label === "Destination A" ? 1 : 2),
        ),
        expiresAtMs,
    });
    const catalog = parseLocalAppCatalog(
        JSON.stringify({
            version: 1,
            apps: [
                {
                    ...base.pkg.catalog.apps[0],
                    setupScopes: ["account", "chat"],
                    ...(inbox ? { deliveryInbox: endpoint } : {}),
                },
            ],
        }),
    );
    const catalogJson = JSON.stringify(catalog);
    const bytes = new TextEncoder().encode(catalogJson);
    const sha256 = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (value) => value.toString(16).padStart(2, "0"),
    ).join("");
    const descriptor = {
        ...base.descriptor,
        catalog: { ...base.descriptor.catalog, sha256, byteLength: bytes.length },
    };
    const pkg = { ...base.pkg, catalog, catalogJson };
    const contexts: LocalAppSetupContext[] = [];
    const mappings = new Map<string, string>();
    let nextRecipient = "Destination A";
    let transform = (value: TestReply) => value;
    const routeJson = (label: string) =>
        JSON.stringify({
            version: 1,
            apps: [
                {
                    ...catalog.apps[0],
                    recipientLabel: label,
                    ...(inbox
                        ? {
                              deliveryInbox: grantFor(label),
                              deliveryEncryption: {
                                  ...encryption,
                                  recipientContext: localAppBase64Url(
                                      new TextEncoder().encode(label),
                                  ),
                              },
                          }
                        : {}),
                    actions: catalog.apps[0].actions.map((action) => ({
                        ...action,
                        processorContext: { destination: label },
                    })),
                },
            ],
        });
    let saved: string | undefined;
    let failStorage = false;
    let writes = 0;
    const storage: LocalAppSetupStorage = {
        read: async (scope) => (saved ? decodeLocalAppSetup(scope, saved) : undefined),
        write: async (scope, value) => {
            ++writes;
            if (failStorage) throw new Error("synthetic storage failure");
            saved = await encodeLocalAppSetup(scope, value);
        },
        remove: async () => {
            saved = undefined;
        },
    };
    const connect = vi.fn<ConnectLocalAppSetup>(async (_descriptor, _signal, pending) => {
        const context = await pending;
        if (!context) throw new Error("Expected scoped setup");
        contexts.push(context);
        if (context.scope === "chat") mappings.set(context.handle, nextRecipient);
        const handles =
            context.scope === "chat" ? [context.handle] : context.routes.map((row) => row.handle);
        return JSON.stringify(
            transform({
                version: 2,
                scope: context.scope,
                appId: "sample",
                accountId,
                catalogJson,
                routes: handles.map((handle) => ({
                    handle,
                    catalogJson: routeJson(mappings.get(handle)!),
                })),
            }),
        );
    });
    const records = new Map<string, EncryptedLocalDraftRecord>();
    const draftStorage = createLocalAppDraftStorage({
        read: async (key) => records.get(key),
        replace: async (key, expected, value) => {
            if (records.get(key)?.revision !== expected) throw new Error("stale draft");
            records.set(key, value);
        },
        remove: async (key, value) => {
            records.set(key, value);
        },
    });
    const inboxDeposit = vi.fn<LocalAppInboxDeposit>(async (grant, requestId, body) => ({
        inboxId: grant.inboxId,
        requestId,
        bodySha256: await localAppInboxSha256(body),
        receivedAtMs: Date.now(),
        expiresAtMs,
        status: "Pending",
        replayed: false,
    }));
    const deps = {
        extract: vi.fn(async () => ({ kind: "extracted" as const, candidates: [{ value: 42 }] })),
        runProcessor: vi.fn(),
        verifyProcessor: verifyImportedLocalProcessor,
        deliver: vi.fn(),
        deliverySaved: () => false,
        cancelDelivery: vi.fn(),
        setupStorage: storage,
        ...(inbox ? { draftStorage, inboxDeposit } : {}),
        loadDirectory: vi.fn(async () => ({ version: 1 as const, apps: [descriptor] })),
        loadPublicPackage: vi.fn(async () => pkg),
        connectAppSetup: connect,
    };
    const make = async () => {
        const workspace = new PrivateAppWorkspace(deps);
        workspace.setAccount("viewer", "https://backend.test|index");
        await vi.waitFor(() =>
            expect(workspace.state.setupLoading || workspace.state.draftLoading).toBe(false),
        );
        workspace.configureDirectory(directorySource);
        await workspace.refreshDirectory();
        return workspace;
    };
    const workspace = await make();
    expect(await workspace.connectApp("sample")).toBe(true);
    workspace.replaceEnabledChats("viewer", workspace.state.catalog!, [
        { chatKey: "private-chat-A", appIds: ["sample"] },
        { chatKey: "private-chat-B", appIds: ["sample"] },
    ]);
    return {
        workspace,
        deps,
        contexts,
        mappings,
        make,
        inboxDeposit,
        failStorage(value: boolean) {
            failStorage = value;
        },
        writes: () => writes,
        recipient(value: string) {
            nextRecipient = value;
        },
        transform(value: (result: TestReply) => TestReply) {
            transform = value;
        },
    };
}
async function propose(workspace: PrivateAppWorkspace, chatKey: string, messageId = "1") {
    workspace.selectForProposal("sample", "add");
    return workspace.propose(
        client,
        { kind: "text_content", text: "synthetic message" } as MessageContent,
        { stillCurrent: () => true, source: { chatKey, messageId }, regenerate: true },
    );
}

describe("account reconnection preserves independent chat routes", () => {
    it("reviews and encrypts each chat's card to its own inbox, never the public account endpoint", async () => {
        const f = await fixture(true);
        await f.workspace.configureChat("sample", "private-chat-A");
        f.recipient("Destination B");
        await f.workspace.configureChat("sample", "private-chat-B");
        expect(f.workspace.state.catalog?.apps[0].deliveryInbox).not.toHaveProperty(
            "writeCapability",
        );
        for (const [chatKey, inboxId] of [
            ["private-chat-A", "a".repeat(64)],
            ["private-chat-B", "b".repeat(64)],
        ]) {
            expect(await propose(f.workspace, chatKey)).toBe("drafted");
            expect(f.workspace.review()).toBe(true);
            await f.workspace.confirm(f.workspace.state.draft!.approval!.approvalId);
            expect(f.workspace.state.draft?.status).toBe("delivered");
            const [grant, , body] = f.inboxDeposit.mock.calls.at(-1)!;
            expect(grant.inboxId).toBe(inboxId);
            const envelope = JSON.parse(new TextDecoder().decode(body));
            expect(envelope.envelope.ciphertext).toBeTruthy();
            expect(envelope.payload).toBeUndefined();
            expect(new TextDecoder().decode(body)).not.toContain('"value":42');
        }
        expect(f.inboxDeposit).toHaveBeenCalledTimes(2);
        expect(f.deps.deliver).not.toHaveBeenCalled();
    });

    it("reconnects an uncertain card without sending, then explicit retry uses identical ciphertext and request ID", async () => {
        const f = await fixture(true);
        await f.workspace.configureChat("sample", "private-chat-A");
        await propose(f.workspace, "private-chat-A");
        expect(f.workspace.review()).toBe(true);
        f.inboxDeposit.mockRejectedValueOnce(new Error("unknown receipt"));
        await f.workspace.confirm(f.workspace.state.draft!.approval!.approvalId);
        expect(f.workspace.state.draft?.status).toBe("uncertain");
        const first = f.inboxDeposit.mock.calls[0];
        expect(await f.workspace.connectApp("sample")).toBe(true);
        expect(f.inboxDeposit).toHaveBeenCalledTimes(1);
        expect(f.workspace.state.draft?.status).toBe("uncertain");
        expect(f.workspace.state.cardReviewBlockedReason).toBeUndefined();
        f.workspace.invalidateReview();
        expect(f.workspace.review()).toBe(true);
        await f.workspace.retryUncertain(f.workspace.state.draft!.approval!.approvalId);
        expect(f.workspace.state.draft?.status).toBe("delivered");
        const second = f.inboxDeposit.mock.calls[1];
        expect(second[0]).toEqual(first[0]);
        expect(second[1]).toBe(first[1]);
        expect(second[2]).toEqual(first[2]);
    });
    it("does not share an unsaved pending handle and retries its failed write before opening setup", async () => {
        const f = await fixture();
        await vi.waitFor(() => expect(f.workspace.state.setupStatus).toContain("App setup saved"));
        f.failStorage(true);
        await f.workspace.configureChat("sample", "private-chat-A");
        const pending = f.workspace.state.chatSetups[0];
        expect(pending.catalogJson).toBeUndefined();
        expect(f.mappings.size).toBe(0);
        const writes = f.writes();
        await f.workspace.configureChat("sample", "private-chat-A");
        expect(f.writes()).toBeGreaterThan(writes);
        expect(f.mappings.size).toBe(0);
        f.failStorage(false);
        await f.workspace.configureChat("sample", "private-chat-A");
        expect(f.workspace.state.chatSetups[0].handle).toBe(pending.handle);
        expect(f.mappings.size).toBe(1);
    });
    it("reconnects once without reassigning either chat, and restores both routes after restart", async () => {
        const f = await fixture();
        expect(await propose(f.workspace, "private-chat-A")).toBe("retryable");
        expect(f.deps.extract).not.toHaveBeenCalled();
        await f.workspace.configureChat("sample", "private-chat-A");
        f.recipient("Destination B");
        await f.workspace.configureChat("sample", "private-chat-B");
        const before = f.workspace.state.chatSetups;
        expect(before).toHaveLength(2);
        expect(new Set(before.map((row) => row.handle)).size).toBe(2);
        expect(await f.workspace.connectApp("sample")).toBe(true);
        expect(f.workspace.state.chatSetups).toEqual(before);
        expect(f.mappings.size).toBe(2);
        expect(f.contexts.filter((context) => context.scope === "chat")).toHaveLength(2);
        expect(JSON.stringify(f.contexts)).not.toContain("private-chat-");
        await vi.waitFor(() => expect(f.workspace.state.setupStatus).toContain("App setup saved"));
        const restored = await f.make();
        expect(restored.state.chatSetups).toEqual(before);
        expect(await propose(restored, "private-chat-A")).toBe("drafted");
        expect(restored.state.activeCardApp?.recipientLabel).toBe("Destination A");
        expect(await propose(restored, "private-chat-B")).toBe("drafted");
        expect(restored.state.activeCardApp?.recipientLabel).toBe("Destination B");
    });

    it("changes only explicit chat setup, preserving old card destination and blocking retargeted review", async () => {
        const f = await fixture();
        await f.workspace.configureChat("sample", "private-chat-A");
        f.recipient("Destination B");
        await f.workspace.configureChat("sample", "private-chat-B");
        await propose(f.workspace, "private-chat-A");
        const card = f.workspace.state.draft!;
        const other = f.workspace.state.chatSetups.find((row) => row.chatKey === "private-chat-B");
        f.recipient("Destination C");
        await f.workspace.configureChat("sample", "private-chat-A");
        expect(
            f.workspace.state.chatSetups.find((row) => row.chatKey === "private-chat-B"),
        ).toEqual(other);
        expect(f.workspace.state.activeCardApp?.recipientLabel).toBe("Destination A");
        expect(f.workspace.state.draft?.target).toEqual(card.target);
        expect(f.workspace.state.cardReviewBlockedReason).toBeTruthy();
        expect(f.deps.deliver).not.toHaveBeenCalled();
        expect(await propose(f.workspace, "private-chat-A", "2")).toBe("drafted");
        expect(f.workspace.state.activeCardApp?.recipientLabel).toBe("Destination C");
    });

    it.each(["account", "omitted", "extra", "forged"])(
        "rejects %s reconnect atomically",
        async (failure) => {
            const f = await fixture();
            await f.workspace.configureChat("sample", "private-chat-A");
            const before = f.workspace.state;
            f.transform((result) => {
                if (failure === "account") result.accountId = "B".repeat(42) + "A";
                if (failure === "omitted") result.routes = [];
                if (failure === "extra")
                    result.routes.push({ ...result.routes[0], handle: "C".repeat(42) + "A" });
                if (failure === "forged") {
                    const catalog = JSON.parse(result.routes[0].catalogJson);
                    catalog.apps[0].destination = "https://other.test/import";
                    result.routes[0].catalogJson = JSON.stringify(catalog);
                }
                return result;
            });
            expect(await f.workspace.connectApp("sample")).toBe(false);
            expect(f.workspace.state.catalog).toEqual(before.catalog);
            expect(f.workspace.state.chatSetups).toEqual(before.chatSetups);
            expect(f.workspace.state.connections).toEqual(before.connections);
            expect(f.workspace.state.enabledChats).toEqual(before.enabledChats);
            expect(f.deps.deliver).not.toHaveBeenCalled();
        },
    );

    it("retries a lost chat callback with the persisted handle, not a new mapping", async () => {
        const f = await fixture();
        f.transform(() => {
            throw new Error("callback lost");
        });
        await f.workspace.configureChat("sample", "private-chat-A");
        const pending = f.workspace.state.chatSetups[0];
        expect(pending.catalogJson).toBeUndefined();
        const restored = await f.make();
        f.transform((value) => value);
        await restored.configureChat("sample", "private-chat-A");
        expect(restored.state.chatSetups[0].handle).toBe(pending.handle);
        expect(f.mappings.size).toBe(1);
        expect(restored.state.chatSetups[0].catalogJson).toBeTruthy();
    });
});
