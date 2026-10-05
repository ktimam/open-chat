// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ChatIdentifier, MessageContent, OpenChat } from "@client";
import { chatIdentifierToString } from "@shared/utils/chat";
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
    it("does not persist failed source-presentation intent or restore it with saved cards", async () => {
        const first = fixture();
        await start(first.workspace);
        const originalSource = { chatKey: "synthetic-chat", messageId: "1" };
        const failedSource = { chatKey: "synthetic-chat", messageId: "2" };
        await first.workspace.propose(client, content, {
            stillCurrent: () => true,
            source: originalSource,
        });
        await saved(first.workspace);
        const cardId = first.workspace.state.draft!.id;
        const persistedBefore = await first.storage.read(scope);
        first.extract.mockResolvedValueOnce({ kind: "no_extraction", raw: "" });

        await expect(
            first.workspace.propose(client, content, {
                stillCurrent: () => true,
                source: failedSource,
            }),
        ).resolves.toBe("retryable");
        expect(first.workspace.state.presentationSource).toEqual(failedSource);
        expect(first.workspace.state.cardSources[cardId]).toEqual(originalSource);
        expect(await first.storage.read(scope)).toEqual(persistedBefore);
        expect(persistedBefore).not.toHaveProperty("presentationSource");
        expect(persistedBefore).not.toHaveProperty("cardPresentation");
        expect(persistedBefore).not.toHaveProperty("presentationDraftId");

        const restored = fixture(first.shared);
        await start(restored.workspace);
        expect(restored.workspace.state.cardPresentation).toBe("saved");
        expect(restored.workspace.state.presentationSource).toBeUndefined();
        expect(restored.workspace.state.presentationDraftId).toBeUndefined();
        expect(restored.workspace.state.open).toBe(false);
        expect(restored.workspace.state.draft?.id).toBe(cardId);
        expect(restored.workspace.state.cardSources[cardId]).toEqual(originalSource);
        expect(restored.extract).not.toHaveBeenCalled();
        expect(restored.deliver).not.toHaveBeenCalled();
    });

    it("uses current connected configuration for new sources without retargeting the retained old card", async () => {
        const first = fixture();
        await start(first.workspace);
        const source = { chatKey: "synthetic-chat", messageId: "1" };
        await first.workspace.propose(client, content, { stillCurrent: () => true, source });
        await saved(first.workspace);
        const oldId = first.workspace.state.draft!.id;
        const modified = JSON.parse(JSON.stringify(catalog));
        modified.apps[0].revision = "2";
        modified.apps[0].destination = "https://new.example.invalid/import";
        first.shared.setupStorage.read = async () => ({
            catalog: parseLocalAppCatalog(JSON.stringify(modified)),
            appId: "sample",
            actionId: "save",
            enabledChats: [],
        });
        const next = fixture(first.shared);
        await start(next.workspace);
        expect(next.workspace.review()).toBe(false);
        expect(
            await next.workspace.propose(client, content, { stillCurrent: () => true, source }),
        ).toBe("drafted");
        expect(next.workspace.state.draft?.id).toBe(oldId);
        expect(next.workspace.review()).toBe(false);
        expect(next.extract).not.toHaveBeenCalled();
        expect(
            await next.workspace.propose(client, content, {
                stillCurrent: () => true,
                source: { ...source, messageId: "2" },
            }),
        ).toBe("drafted");
        expect(next.workspace.state.draft?.target).toMatchObject({
            appRevision: "2",
            destination: "https://new.example.invalid/import",
        });
        expect(next.workspace.state.cards[0]).toMatchObject({
            id: oldId,
            target: { appRevision: "1", destination: "https://example.invalid/import" },
        });
        expect(next.workspace.review()).toBe(true);
        expect(next.extract).toHaveBeenCalledOnce();
        expect(next.deliver).not.toHaveBeenCalled();
    });

    it("restores the last explicitly selected card without a write or inference", async () => {
        const first = fixture();
        await start(first.workspace);
        await propose(first.workspace);
        const firstId = first.workspace.state.draft!.id;
        await propose(first.workspace);
        const secondId = first.workspace.state.draft!.id;
        first.workspace.selectCard(firstId);
        first.workspace.selectCard(secondId);
        await saved(first.workspace);
        const replace = vi.spyOn(first.shared.backend, "replace");
        const next = fixture(first.shared);
        await start(next.workspace);
        expect(next.workspace.state.draft?.id).toBe(secondId);
        expect(next.workspace.state.cards).toHaveLength(2);
        expect(replace).not.toHaveBeenCalled();
        expect(next.extract).not.toHaveBeenCalled();
        expect(next.deliver).not.toHaveBeenCalled();
    });

    it("cancels new inference without discarding an existing card", async () => {
        const first = fixture();
        await start(first.workspace);
        await propose(first.workspace);
        const id = first.workspace.state.draft!.id;
        let resolve!: (value: { kind: "extracted"; candidates: { value: number }[] }) => void;
        first.extract.mockImplementationOnce(
            () =>
                new Promise((done) => {
                    resolve = done;
                }),
        );
        const pending = first.workspace.propose(client, content, { stillCurrent: () => true });
        expect(first.workspace.state.busy).toBe(true);
        expect(await first.workspace.forgetSetup()).toBe(false);
        expect(first.workspace.state.cards.map((card) => card.id)).toEqual([id]);
        first.workspace.discard();
        resolve({ kind: "extracted", candidates: [{ value: 99 }] });
        expect(await pending).toBe("retryable");
        expect(first.workspace.state.cards.map((card) => card.id)).toEqual([id]);
        expect(first.workspace.state.draft?.id).toBe(id);
        expect((await first.storage.read(scope))?.cards.map((card) => card.saved.draft.id)).toEqual(
            [id],
        );
    });

    it("keeps original app presentation when setup changes and refuses changed action semantics", async () => {
        const first = fixture();
        await start(first.workspace);
        await propose(first.workspace);
        const original = first.workspace.selection()!.action;
        const modified = JSON.parse(JSON.stringify(catalog));
        modified.apps[0].actions[0].definition.card.title = "Changed heading";
        first.shared.setupStorage.read = async () => ({
            catalog: parseLocalAppCatalog(JSON.stringify(modified)),
            appId: "sample",
            actionId: "save",
            enabledChats: [],
        });
        const next = fixture(first.shared);
        await start(next.workspace);
        expect(next.workspace.selection()?.action.definition.card).toEqual(
            original.definition.card,
        );
        expect(next.workspace.state.activeCardApp?.actions[0].definition.card.title).toBe("Review");
        expect(next.workspace.review()).toBe(false);
        expect(next.deliver).not.toHaveBeenCalled();
    });

    it("retains an inspect-only legacy card without blocking a compatible sibling's save", async () => {
        const first = fixture();
        await start(first.workspace);
        await propose(first.workspace);
        const original = (await first.storage.read(scope))!.cards[0].saved;
        // A migrated v1 card has no frozen app metadata; do not attach changed setup to it.
        await first.storage.write(scope, { version: 2, cards: [{ saved: original }] });
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
        expect(next.workspace.state.draft?.id).toBe(original.draft.id);
        expect(next.workspace.state.activeCardApp).toBeUndefined();
        expect(next.workspace.review()).toBe(false);
        expect(next.workspace.selectForProposal("sample", "save")).toBe(true);
        await propose(next.workspace);
        const siblingId = next.workspace.state.draft!.id;
        next.workspace.edit('{"value":99}', "Sibling recipient");
        await saved(next.workspace);
        const stored = (await next.storage.read(scope))!;
        expect(stored.cards).toHaveLength(2);
        expect(stored.cards[0]).toEqual({ saved: original });
        expect(stored.cards[1].saved.draft.id).toBe(siblingId);
        expect(stored.cards[1].saved.editorJson).toBe('{"value":99}');
        expect(stored.cards[1].app?.destination).toBe("https://another.invalid/import");
        next.workspace.clear();
        const restored = fixture(first.shared);
        await start(restored.workspace);
        expect(restored.workspace.state.cards.map((card) => card.id)).toEqual([
            original.draft.id,
            siblingId,
        ]);
        expect(restored.workspace.selectCard(original.draft.id)).toBe(true);
        expect(restored.workspace.review()).toBe(false);
        expect(restored.workspace.selectCard(siblingId)).toBe(true);
        expect(restored.workspace.state.editorJson).toBe('{"value":99}');
        expect(restored.workspace.review()).toBe(true);
        await saved(restored.workspace);
        expect(restored.extract).not.toHaveBeenCalled();
        expect(next.deliver).not.toHaveBeenCalled();
        expect(restored.deliver).not.toHaveBeenCalled();
    });

    it("restores a valid frozen action larger than the individual draft JSON cap", async () => {
        const expanded = JSON.parse(JSON.stringify(catalog));
        const action = expanded.apps[0].actions[0];
        action.definition.responseSchema = { description: "s".repeat(40 * 1024) };
        action.processorContext = { memo: "c".repeat(40 * 1024) };
        const largeCatalog = parseLocalAppCatalog(JSON.stringify(expanded));
        const actionBytes = new TextEncoder().encode(
            JSON.stringify(largeCatalog.apps[0].actions[0]),
        ).byteLength;
        expect(actionBytes).toBeGreaterThan(64 * 1024);
        expect(actionBytes).toBeLessThan(256 * 1024);
        const shared = sharedStorage();
        shared.setupStorage.read = async () => ({
            catalog: largeCatalog,
            appId: "sample",
            actionId: "save",
            enabledChats: [],
        });
        const first = fixture(shared);
        await start(first.workspace);
        await propose(first.workspace);
        const original = (await first.storage.read(scope))!.cards[0];
        first.workspace.clear();
        const next = fixture(shared);
        await start(next.workspace);
        expect(next.workspace.state.draft?.id).toBe(original.saved.draft.id);
        expect(next.workspace.state.activeCardApp?.actions[0]).toEqual(
            largeCatalog.apps[0].actions[0],
        );
        expect(next.workspace.state.draftStorageStatus).toContain("restored");
        expect(next.workspace.state.draft?.approval).toBeUndefined();
        expect(next.workspace.review()).toBe(true);
        await saved(next.workspace);
        expect(next.workspace.state.draft?.approval?.request.payload).toEqual({ value: 42 });
        expect(next.workspace.state.draft?.approval?.request.idempotencyKey).toBe(
            original.saved.draft.idempotencyKey,
        );
        expect(next.extract).not.toHaveBeenCalled();
        expect(next.deliver).not.toHaveBeenCalled();
    });

    it("retains two message-linked editors across reload and resumes without inference or sending", async () => {
        const first = fixture();
        await start(first.workspace);
        const directChat = { kind: "direct_chat", userId: "2vxsx-fae" } satisfies ChatIdentifier;
        const sourceA = {
            chatKey: chatIdentifierToString(directChat),
            chatKind: directChat.kind,
            messageId: "10",
            threadRootMessageIndex: 4,
            messageIndex: 10,
        };
        const sourceB = {
            chatKey: chatIdentifierToString(directChat),
            chatKind: directChat.kind,
            messageId: "11",
            threadRootMessageIndex: 4,
            messageIndex: 11,
        };
        await first.workspace.propose(client, content, {
            stillCurrent: () => true,
            source: sourceA,
        });
        first.workspace.edit('{"value":43}', "recipient A");
        const idA = first.workspace.state.draft!.id;
        first.workspace.review();
        const oldApproval = first.workspace.state.draft!.approval!;
        await first.workspace.propose(client, content, {
            stillCurrent: () => true,
            source: sourceB,
        });
        const idB = first.workspace.state.draft!.id;
        first.workspace.edit('{"value":44}', "recipient B");
        await saved(first.workspace);
        expect(first.workspace.state.cards.map((card) => card.id)).toEqual([idA, idB]);
        expect(first.workspace.state.cardSources).toEqual({ [idA]: sourceA, [idB]: sourceB });
        expect(Object.isFrozen(first.workspace.state.cardSources)).toBe(true);
        expect(Object.isFrozen(first.workspace.state.cardSources[idA])).toBe(true);
        expect(first.workspace.selectCard(idA)).toBe(true);
        expect(first.workspace.state.editorJson).toBe('{"value":43}');
        expect(first.workspace.state.recipient).toBe("recipient A");
        expect(first.workspace.state.draft?.approval).toBeUndefined();
        await first.workspace.confirm(oldApproval.approvalId);
        expect(first.crossed).not.toHaveBeenCalled();
        const recorded = await first.storage.read(scope);
        expect(recorded?.cards.map((card) => card.source)).toEqual([sourceA, sourceB]);
        expect(JSON.stringify([...first.shared.records.values()])).not.toContain(sourceA.chatKey);
        first.workspace.clear();
        const next = fixture(first.shared);
        await start(next.workspace);
        expect(next.workspace.state.cards.map((card) => card.id)).toEqual([idA, idB]);
        expect(next.workspace.state.cardSources).toEqual({ [idA]: sourceA, [idB]: sourceB });
        expect(next.workspace.selectCard(idB)).toBe(true);
        expect(next.workspace.state.editorJson).toBe('{"value":44}');
        expect(next.workspace.state.recipient).toBe("recipient B");
        await next.workspace.propose(client, content, {
            stillCurrent: () => true,
            source: sourceA,
        });
        expect(next.workspace.state.draft?.id).toBe(idA);
        expect(next.workspace.state.cards).toHaveLength(2);
        expect(next.extract).not.toHaveBeenCalled();
        expect(next.deliver).not.toHaveBeenCalled();
        next.workspace.review();
        expect(next.workspace.state.draft?.approval?.request.idempotencyKey).toBe(
            oldApproval.request.idempotencyKey,
        );
        expect(next.workspace.state.draft?.approval?.request).not.toHaveProperty("source");
    });

    it("backfills legacy source navigation metadata without inference or consent", async () => {
        const first = fixture();
        await start(first.workspace);
        const directChat = { kind: "direct_chat", userId: "2vxsx-fae" } satisfies ChatIdentifier;
        const legacySource = {
            chatKey: chatIdentifierToString(directChat),
            messageId: "20",
            threadRootMessageIndex: 4,
        };
        await first.workspace.propose(client, content, {
            stillCurrent: () => true,
            source: legacySource,
        });
        const id = first.workspace.state.draft!.id;
        await saved(first.workspace);
        expect(first.workspace.state.cardSources[id]).toEqual(legacySource);

        first.workspace.clear();
        const next = fixture(first.shared);
        await start(next.workspace);
        expect(next.workspace.state.cardSources[id]).toEqual(legacySource);
        expect(next.workspace.review()).toBe(true);
        const priorApproval = next.workspace.state.draft!.approval!;

        const indexedSource = {
            ...legacySource,
            messageIndex: 20,
            chatKind: directChat.kind,
        };
        await expect(
            next.workspace.propose(client, content, {
                stillCurrent: () => true,
                source: indexedSource,
            }),
        ).resolves.toBe("drafted");
        expect(next.workspace.state.draft?.id).toBe(id);
        expect(next.workspace.state.cards).toHaveLength(1);
        expect(next.workspace.state.cardSources[id]).toEqual(indexedSource);
        expect(Object.isFrozen(next.workspace.state.cardSources[id])).toBe(true);
        expect(next.workspace.state.draft?.approval).toBeUndefined();
        await next.workspace.confirm(priorApproval.approvalId);
        expect(next.extract).not.toHaveBeenCalled();
        expect(next.deliver).not.toHaveBeenCalled();

        await saved(next.workspace);
        expect((await next.storage.read(scope))?.cards[0].source).toEqual(indexedSource);
        expect(next.workspace.review()).toBe(true);
        expect(next.workspace.state.draft?.approval?.request).not.toHaveProperty("source");
    });

    it("does not merge known direct and group kinds that share the same stable key", async () => {
        const current = fixture();
        await start(current.workspace);
        const principal = "rrkah-fqaaa-aaaaa-aaaaq-cai";
        const directChat = { kind: "direct_chat", userId: principal } satisfies ChatIdentifier;
        const groupChat = { kind: "group_chat", groupId: principal } satisfies ChatIdentifier;
        expect(chatIdentifierToString(directChat)).toBe(chatIdentifierToString(groupChat));
        const stable = { messageId: "30", messageIndex: 30 };

        await current.workspace.propose(client, content, {
            stillCurrent: () => true,
            source: {
                ...stable,
                chatKey: chatIdentifierToString(directChat),
                chatKind: directChat.kind,
            },
        });
        const directId = current.workspace.state.draft!.id;
        await current.workspace.propose(client, content, {
            stillCurrent: () => true,
            source: {
                ...stable,
                chatKey: chatIdentifierToString(groupChat),
                chatKind: groupChat.kind,
            },
        });
        const groupId = current.workspace.state.draft!.id;

        expect(groupId).not.toBe(directId);
        expect(current.workspace.state.cards).toHaveLength(2);
        expect(current.workspace.state.cardSources[directId]?.chatKind).toBe("direct_chat");
        expect(current.workspace.state.cardSources[groupId]?.chatKind).toBe("group_chat");
        expect(current.extract).toHaveBeenCalledTimes(2);
        expect(current.deliver).not.toHaveBeenCalled();
    });

    it("discards only the selected card without opening or erasing its saved sibling", async () => {
        const first = fixture();
        await start(first.workspace);
        await propose(first.workspace);
        const idA = first.workspace.state.draft!.id;
        await propose(first.workspace);
        const idB = first.workspace.state.draft!.id;
        first.workspace.selectCard(idA);
        first.workspace.discard();
        await vi.waitFor(() => expect(first.workspace.state.draftLoading).toBe(false));
        expect(first.workspace.state.draft).toBeUndefined();
        expect(first.workspace.state.editorJson).toBe("");
        expect(first.workspace.state.cards.map((card) => card.id)).toEqual([idB]);
        expect((await first.storage.read(scope))?.cards.map((card) => card.saved.draft.id)).toEqual(
            [idB],
        );
        expect(first.extract).toHaveBeenCalledTimes(2);
        expect(first.deliver).not.toHaveBeenCalled();
        const next = fixture(first.shared);
        await start(next.workspace);
        expect(next.workspace.state.cards.map((card) => card.id)).toEqual([idB]);
        expect(next.deliver).not.toHaveBeenCalled();
    });

    it("keeps attempted A immutable while editing B and write-ahead retains both cards", async () => {
        const first = fixture();
        await start(first.workspace);
        await propose(first.workspace);
        const idA = first.workspace.state.draft!.id;
        first.workspace.review();
        const original = first.workspace.state.draft!.approval!;
        await first.workspace.confirm(original.approvalId);
        await propose(first.workspace);
        const idB = first.workspace.state.draft!.id;
        first.workspace.edit('{"value":99}', "recipient B");
        await saved(first.workspace);
        const stored = await first.storage.read(scope);
        expect(
            stored?.cards.map((card) => [card.saved.draft.id, card.saved.draft.attempted]),
        ).toEqual([
            [idA, true],
            [idB, false],
        ]);
        first.workspace.selectCard(idA);
        expect(first.workspace.state.draft?.status).toBe("delivered");
        expect(first.workspace.state.draft?.approval).toBeUndefined();
        first.workspace.edit('{"value":100}', "changed");
        expect(first.workspace.state.draft?.payload).toEqual(original.request.payload);
        await first.workspace.reopenDelivered(original.approvalId);
        expect(first.crossed).toHaveBeenCalledTimes(1);
        expect(first.workspace.review()).toBe(true);
        expect(first.workspace.state.draft?.approval?.request).toEqual(original.request);
        await first.workspace.reopenDelivered(first.workspace.state.draft!.approval!.approvalId);
        expect(first.crossed).toHaveBeenCalledTimes(2);
        expect((await first.storage.read(scope))?.cards).toHaveLength(2);
    });

    it("fails at capacity before inference without replacing any saved card", async () => {
        const first = fixture();
        await start(first.workspace);
        for (let index = 0; index < 8; index++) await propose(first.workspace);
        const ids = first.workspace.state.cards.map((card) => card.id);
        expect(await first.workspace.propose(client, content, { stillCurrent: () => true })).toBe(
            "retryable",
        );
        expect(first.extract).toHaveBeenCalledTimes(8);
        expect(first.workspace.state.cards.map((card) => card.id)).toEqual(ids);
        expect((await first.storage.read(scope))?.cards.map((card) => card.saved.draft.id)).toEqual(
            ids,
        );
    });

    it("does not authorize overwrite after a failed restore", async () => {
        const write = vi.fn(async () => {});
        const first = fixture(undefined, {
            read: async () => {
                throw new Error("corrupt");
            },
            write,
            remove: async () => {},
        });
        await start(first.workspace);
        expect(await first.workspace.propose(client, content, { stillCurrent: () => true })).toBe(
            "retryable",
        );
        expect(first.extract).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
        expect(first.workspace.state.draftStorageStatus).toContain("could not be restored");
    });

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
        expect((await first.storage.read(scope))?.cards).toEqual([]);
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
        expect((await first.storage.read(scope))?.cards[0].saved.draft.attempted).toBe(true);
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

    it.each(["uncertain", "delivered"] as const)(
        "revokes %s recovery review without changing or dispatching the retained request",
        async (status) => {
            const first = fixture();
            await start(first.workspace);
            await propose(first.workspace);
            first.workspace.edit('{"value":77}', "reviewed recipient");
            expect(first.workspace.review()).toBe(true);
            const original = first.workspace.state.draft!.approval!;
            const originalView = first.workspace.state.draft!;
            if (status === "uncertain") {
                first.deliver.mockImplementationOnce(async (_request, _signal, beforeDelivery) => {
                    await beforeDelivery;
                    return { kind: "uncertain" };
                });
            }
            await first.workspace.confirm(original.approvalId);
            expect(first.workspace.state.draft?.status).toBe(status);
            expect(first.workspace.state.draft?.approval?.request).toEqual(original.request);
            const deliveryCalls = first.deliver.mock.calls.length;
            const crossedCalls = first.crossed.mock.calls.length;

            first.workspace.invalidateReview();
            expect(first.workspace.state.draft).toMatchObject({
                id: originalView.id,
                revision: originalView.revision,
                status,
                payload: originalView.payload,
            });
            expect(first.workspace.state.draft?.approval).toBeUndefined();
            if (status === "uncertain") await first.workspace.retryUncertain(original.approvalId);
            else await first.workspace.reopenDelivered(original.approvalId);
            expect(first.deliver).toHaveBeenCalledTimes(deliveryCalls);
            expect(first.crossed).toHaveBeenCalledTimes(crossedCalls);

            expect(first.workspace.review()).toBe(true);
            const reviewed = first.workspace.state.draft!.approval!;
            expect(reviewed.approvalId).not.toBe(original.approvalId);
            expect(reviewed.request).toEqual(original.request);
            expect(reviewed.request).not.toHaveProperty("source");
            expect(first.deliver).toHaveBeenCalledTimes(deliveryCalls);
            expect(first.crossed).toHaveBeenCalledTimes(crossedCalls);
        },
    );

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
