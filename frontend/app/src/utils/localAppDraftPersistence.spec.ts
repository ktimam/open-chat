// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { LocalAppDraftStore, type LocalDraftDelivery } from "./localAppDrafts";
import { parseLocalAppCatalog } from "./localAppCatalog";
import {
    createBrowserLocalAppDraftStorage,
    createLocalAppDraftStorage,
    snapshotSavedLocalAppDraft,
    snapshotSavedLocalAppDraftCollection,
    snapshotLocalAppDraftSourceReference,
    MAX_SAVED_LOCAL_APP_DRAFTS,
    type EncryptedLocalDraftRecord,
    type LocalDraftRecordBackend,
    type SavedLocalAppDraft,
    type SavedLocalAppDraftCollection,
} from "./localAppDraftPersistence";

const scope = { account: "synthetic-user", backend: "synthetic-backend" };
const scopeKey = (owner = scope) => JSON.stringify([owner.backend, owner.account]);
function backend() {
    const records = new Map<string, EncryptedLocalDraftRecord>();
    const store: LocalDraftRecordBackend = {
        read: vi.fn(async (key) => records.get(key)),
        replace: vi.fn(async (key, expected, value) => {
            if (records.get(key)?.revision !== expected) throw new Error("stale");
            records.set(key, structuredClone(value));
        }),
        remove: vi.fn(async (key, value) => {
            records.set(key, structuredClone(value));
        }),
    };
    return { store, records };
}
function fixture(): SavedLocalAppDraft {
    const drafts = new LocalAppDraftStore(async () => ({ kind: "delivered" }));
    drafts.setAccount(scope.account);
    const draft = drafts.create({
        target: {
            appId: "sample",
            actionId: "save",
            appRevision: "1",
            destination: "https://example.invalid/import",
            recipient: "PRIVATE_RECIPIENT",
        },
        schema: {
            type: "object",
            properties: { note: { type: "string" } },
            required: ["note"],
            additionalProperties: false,
        },
        payload: { note: "PRIVATE_CARD_SENTINEL" },
    });
    return {
        version: 1,
        draft: drafts.snapshot(draft.id),
        editorJson: '{"note":"PRIVATE_CARD_SENTINEL"}',
        recipient: "PRIVATE_RECIPIENT",
    };
}
const collection = (...saved: SavedLocalAppDraft[]): SavedLocalAppDraftCollection => ({
    version: 2,
    cards: saved.map((value) => ({ saved: value })),
});
const sourceReference = {
    chatKey: "PRIVATE_CHAT_REFERENCE",
    messageId: "18446744073709551615",
    threadRootMessageIndex: 0,
};
function appFixture(saved: SavedLocalAppDraft) {
    const target = saved.draft.target;
    return parseLocalAppCatalog(
        JSON.stringify({
            version: 1,
            apps: [
                {
                    id: target.appId,
                    revision: target.appRevision,
                    name: "Frozen app",
                    description: "Private card's original app definition",
                    destination: target.destination,
                    ...(target.deliveryEncryption
                        ? { deliveryEncryption: target.deliveryEncryption }
                        : {}),
                    actions: [
                        {
                            definition: {
                                name: target.actionId,
                                description: "Save a note",
                                promptTemplate: "Frozen app-owned prompt",
                                responseSchema: {},
                                card: {
                                    title: "Original review",
                                    rows: [{ label: "Original note", valueKey: "note" }],
                                    confirmLabel: "Save",
                                    cancelLabel: "Cancel",
                                },
                            },
                            draftSchema: saved.draft.schema,
                            draftPresentation: {
                                version: 1,
                                enumLabels: [],
                                controls: [{ field: "note", kind: "text" }],
                            },
                            handoff: { kind: "single" },
                        },
                    ],
                },
            ],
        }),
    ).apps[0];
}
async function legacyRow(
    saved: SavedLocalAppDraft,
    revision = "b".repeat(64),
): Promise<EncryptedLocalDraftRecord> {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
    ]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const generation = "a".repeat(64);
    // Exact v1 plaintext and authenticated data from the pre-collection adapter.
    const ciphertext = await crypto.subtle.encrypt(
        {
            name: "AES-GCM",
            iv,
            additionalData: new TextEncoder().encode(
                JSON.stringify(["oc-private-card", 1, scopeKey(), generation, revision]),
            ),
        },
        key,
        new TextEncoder().encode(JSON.stringify(saved)),
    );
    return { version: 1, generation, revision, key, iv, ciphertext };
}

describe("encrypted device-local private card storage", () => {
    it("survives a fresh adapter while storing ciphertext and a nonextractable key only", async () => {
        const db = backend(),
            first = createLocalAppDraftStorage(db.store),
            saved = fixture();
        await first.write(scope, saved);
        const raw = db.records.get(scopeKey())!;
        expect(Object.keys(raw).sort()).toEqual([
            "ciphertext",
            "generation",
            "iv",
            "key",
            "revision",
            "version",
        ]);
        expect(JSON.stringify(raw)).not.toMatch(
            /PRIVATE_CARD|PRIVATE_RECIPIENT|note|payload|approvalId/,
        );
        expect(new TextDecoder().decode(raw.ciphertext)).not.toContain("PRIVATE_CARD_SENTINEL");
        expect(raw.key?.extractable).toBe(false);
        await expect(crypto.subtle.exportKey("raw", raw.key!)).rejects.toThrow();
        await expect(createLocalAppDraftStorage(db.store).read(scope)).resolves.toEqual(
            collection(saved),
        );
        expect(raw.version).toBe(2);
        expect(raw.iv).toHaveLength(12);
    });

    it("uses a fresh IV on every save and rotates the local key after explicit removal", async () => {
        const db = backend(),
            storage = createLocalAppDraftStorage(db.store),
            saved = fixture();
        await storage.write(scope, saved);
        const first = db.records.get(scopeKey())!;
        await storage.write(scope, saved);
        const second = db.records.get(scopeKey())!;
        expect(second.iv).not.toEqual(first.iv);
        expect(new Uint8Array(second.ciphertext!)).not.toEqual(new Uint8Array(first.ciphertext!));
        await storage.remove(scope);
        const tombstone = db.records.get(scopeKey())!;
        expect(Object.keys(tombstone).sort()).toEqual(["generation", "revision", "version"]);
        expect(tombstone.version).toBe(2);
        await expect(storage.read(scope)).resolves.toBeUndefined();
        await storage.write(scope, saved);
        const next = db.records.get(scopeKey())!;
        await expect(
            crypto.subtle.decrypt({ name: "AES-GCM", iv: next.iv! }, first.key!, next.ciphertext!),
        ).rejects.toThrow();
    });

    it.each(["account", "backend"] as const)(
        "does not expose another %s's data and rejects a copied ciphertext row",
        async (field) => {
            const db = backend(),
                storage = createLocalAppDraftStorage(db.store),
                saved = fixture();
            const other = { ...scope, [field]: "another" };
            await storage.write(scope, saved);
            await expect(storage.read(other)).resolves.toBeUndefined();
            db.records.set(scopeKey(other), db.records.get(scopeKey())!);
            await expect(storage.read(other)).rejects.toThrow("Private card could not");
        },
    );

    it.each(["ciphertext", "iv", "generation", "revision", "key", "version"] as const)(
        "rejects tampered %s without leaking fields in its error",
        async (field) => {
            const db = backend(),
                storage = createLocalAppDraftStorage(db.store);
            await storage.write(scope, fixture());
            const row = db.records.get(scopeKey())!;
            if (field === "ciphertext") new Uint8Array(row.ciphertext!)[0] ^= 1;
            else if (field === "iv") row.iv![0] ^= 1;
            else if (field === "key")
                db.records.set(scopeKey(), {
                    ...row,
                    key: await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
                        "encrypt",
                        "decrypt",
                    ]),
                });
            else
                db.records.set(scopeKey(), {
                    ...row,
                    [field]: field === "generation" || field === "revision" ? "a".repeat(64) : 1,
                });
            await expect(storage.read(scope)).rejects.toThrow(
                /^Private card could not be saved, restored or removed on this device$/,
            );
        },
    );

    it("does not resurrect cards after another tab forgets the account", async () => {
        const db = backend(),
            stale = createLocalAppDraftStorage(db.store),
            current = createLocalAppDraftStorage(db.store);
        await stale.write(scope, fixture());
        await current.read(scope);
        await current.remove(scope);
        await expect(stale.write(scope, fixture())).rejects.toThrow("Private card could not");
        expect(db.records.get(scopeKey())?.ciphertext).toBeUndefined();
        await stale.read(scope);
        await expect(stale.write(scope, fixture())).resolves.toBeUndefined();
    });

    it("rejects a cross-tab removal between encryption and atomic write", async () => {
        const db = backend(),
            storage = createLocalAppDraftStorage(db.store);
        await storage.read(scope);
        const replace = db.store.replace;
        db.store.replace = async (key, expected, value) => {
            db.records.set(key, {
                version: 1,
                generation: "b".repeat(64),
                revision: "c".repeat(64),
            });
            await replace(key, expected, value);
        };
        await expect(storage.write(scope, fixture())).rejects.toThrow("Private card could not");
        expect(db.records.get(scopeKey())?.ciphertext).toBeUndefined();
    });

    it("rejects a stale tab edit that would erase another tab's dispatched-request lock", async () => {
        const db = backend(),
            active = createLocalAppDraftStorage(db.store),
            stale = createLocalAppDraftStorage(db.store);
        const original = fixture();
        await active.write(scope, original);
        await stale.read(scope);
        await active.write(scope, { ...original, draft: { ...original.draft, attempted: true } });
        await expect(
            stale.write(scope, {
                ...original,
                editorJson: '{"note":"changed after dispatch"}',
                draft: { ...original.draft, payload: { note: "changed after dispatch" } },
            }),
        ).rejects.toThrow("Private card could not");
        const persisted = await active.read(scope);
        expect(persisted?.cards[0].saved.draft.attempted).toBe(true);
        expect(persisted?.cards[0].saved.draft.idempotencyKey).toBe(original.draft.idempotencyKey);
        expect(persisted?.cards[0].saved.draft.payload).toEqual(original.draft.payload);
    });

    it("rejects quotas and never falls back to plaintext storage", async () => {
        const db = backend(),
            storage = createLocalAppDraftStorage(db.store);
        db.store.replace = async () => {
            throw new Error("PRIVATE_QUOTA_DIAGNOSTIC");
        };
        await expect(storage.write(scope, fixture())).rejects.toThrow(
            /^Private card could not be saved, restored or removed on this device$/,
        );
        expect(db.records.size).toBe(0);
    });

    it("rejects extra approval/session fields, accessors, oversized edits and modified attempted cards", () => {
        const saved = fixture();
        expect(() =>
            snapshotSavedLocalAppDraft({ ...saved, approvalId: "must-not-persist" }),
        ).toThrow();
        expect(() =>
            snapshotSavedLocalAppDraft({ ...saved, editorJson: "a".repeat(65537) }),
        ).toThrow();
        expect(() =>
            snapshotSavedLocalAppDraft({ ...saved, draft: { ...saved.draft, approval: {} } }),
        ).toThrow();
        const accessor = vi.fn(() => saved.draft);
        const malformed = { ...saved };
        Object.defineProperty(malformed, "draft", { enumerable: true, get: accessor });
        expect(() => snapshotSavedLocalAppDraft(malformed)).toThrow();
        expect(accessor).not.toHaveBeenCalled();
        expect(() =>
            snapshotSavedLocalAppDraft({
                ...saved,
                draft: { ...saved.draft, attempted: true },
                editorJson: '{"note":"changed"}',
            }),
        ).toThrow();
        expect(
            snapshotSavedLocalAppDraft({ ...saved, draft: { ...saved.draft, attempted: true } })
                .draft.attempted,
        ).toBe(true);
    });

    it("does not open IndexedDB at module construction and fails closed if it is unavailable", async () => {
        const getter = vi.fn(() => undefined);
        const storage = createBrowserLocalAppDraftStorage({ indexedDB: getter });
        expect(getter).not.toHaveBeenCalled();
        await expect(storage.write(scope, fixture())).rejects.toThrow("Private card could not");
        await expect(storage.read(scope)).rejects.toThrow("Private card could not");
        await expect(storage.remove(scope)).rejects.toThrow("Private card could not");
    });
});

describe("bounded private card collections", () => {
    it("roundtrips only an exact retained active card ID as encrypted collection metadata", async () => {
        const first = fixture(),
            second = fixture();
        const value = { ...collection(first, second), activeDraftId: second.draft.id };
        const snapshot = snapshotSavedLocalAppDraftCollection(value);
        expect(snapshot.activeDraftId).toBe(second.draft.id);
        const db = backend();
        const storage = createLocalAppDraftStorage(db.store);
        await storage.write(scope, snapshot);
        expect(JSON.stringify(db.records.get(scopeKey()))).not.toContain(second.draft.id);
        expect(await createLocalAppDraftStorage(db.store).read(scope)).toEqual(snapshot);
        await storage.write(scope, { ...value, activeDraftId: first.draft.id });
        expect((await storage.read(scope))?.activeDraftId).toBe(first.draft.id);
        expect(snapshotSavedLocalAppDraftCollection(first)).not.toHaveProperty("activeDraftId");
        expect(snapshotSavedLocalAppDraftCollection(collection())).not.toHaveProperty(
            "activeDraftId",
        );
    });

    it("rejects missing, malformed and accessor active card identities without changing saved data", async () => {
        const saved = fixture();
        const db = backend();
        const storage = createLocalAppDraftStorage(db.store);
        const original = { ...collection(saved), activeDraftId: saved.draft.id };
        await storage.write(scope, original);
        const row = db.records.get(scopeKey());
        for (const activeDraftId of [undefined, null, 1, "", "unknown", `${saved.draft.id} `]) {
            expect(() =>
                storage.write(scope, {
                    ...collection(saved),
                    activeDraftId,
                } as SavedLocalAppDraftCollection),
            ).toThrow();
            expect(db.records.get(scopeKey())).toBe(row);
        }
        expect(() =>
            snapshotSavedLocalAppDraftCollection({
                ...collection(),
                activeDraftId: saved.draft.id,
            }),
        ).toThrow();
        const getter = vi.fn(() => saved.draft.id);
        const accessor = Object.defineProperty(collection(saved), "activeDraftId", {
            enumerable: true,
            get: getter,
        });
        expect(() => snapshotSavedLocalAppDraftCollection(accessor)).toThrow();
        expect(getter).not.toHaveBeenCalled();
        expect(await storage.read(scope)).toEqual(original);
    });

    it("wraps legacy snapshots without inventing a source and deeply freezes copied entries", () => {
        const saved = fixture();
        expect(snapshotSavedLocalAppDraftCollection(saved)).toEqual(collection(saved));
        const source = { ...sourceReference };
        const input = { version: 2, cards: [{ saved, source }] };
        const snapshot = snapshotSavedLocalAppDraftCollection(input);
        source.chatKey = "changed";
        input.cards.length = 0;
        expect(snapshot.cards[0].source).toEqual(sourceReference);
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.cards)).toBe(true);
        expect(Object.isFrozen(snapshot.cards[0])).toBe(true);
        expect(Object.isFrozen(snapshot.cards[0].saved)).toBe(true);
        expect(Object.isFrozen(snapshot.cards[0].source)).toBe(true);
    });

    it("accepts empty or eight-card collections and rejects a ninth without eviction", async () => {
        const db = backend();
        const storage = createLocalAppDraftStorage(db.store);
        expect(MAX_SAVED_LOCAL_APP_DRAFTS).toBe(8);
        expect(snapshotSavedLocalAppDraftCollection(collection())).toEqual(collection());
        const saved = collection(...Array.from({ length: 8 }, fixture));
        await storage.write(scope, saved);
        const original = db.records.get(scopeKey());
        expect(() =>
            storage.write(scope, collection(...saved.cards.map((card) => card.saved), fixture())),
        ).toThrow("Private card could not");
        expect(db.records.get(scopeKey())).toBe(original);
        expect(await storage.read(scope)).toEqual(saved);
    });

    it("caps the entire collection at 256 KiB, including editor text and source references", async () => {
        const db = backend();
        const storage = createLocalAppDraftStorage(db.store);
        const cards = Array.from({ length: 4 }, () => ({
            ...fixture(),
            editorJson: "x".repeat(64 * 1024),
        }));
        for (const saved of cards) expect(() => snapshotSavedLocalAppDraft(saved)).not.toThrow();
        const original = collection(cards[0], cards[1], cards[2]);
        await storage.write(scope, original);
        const row = db.records.get(scopeKey());
        expect(() => storage.write(scope, collection(...cards))).toThrow("Private card could not");
        expect(db.records.get(scopeKey())).toBe(row);
        const encoder = new TextEncoder();
        const nearLimit = collection(...cards);
        const overhead = encoder.encode(JSON.stringify(nearLimit)).byteLength - 256 * 1024;
        const last = { ...cards[3], editorJson: cards[3].editorJson.slice(overhead + 10) };
        const bounded = collection(cards[0], cards[1], cards[2], last);
        expect(encoder.encode(JSON.stringify(bounded)).byteLength).toBe(256 * 1024 - 10);
        expect(() => snapshotSavedLocalAppDraftCollection(bounded)).not.toThrow();
        expect(() =>
            snapshotSavedLocalAppDraftCollection({
                ...bounded,
                activeDraftId: bounded.cards[0].saved.draft.id,
            }),
        ).toThrow("Private card could not");
        expect(() =>
            snapshotSavedLocalAppDraftCollection({
                ...bounded,
                cards: bounded.cards.map((card, index) =>
                    index === 0 ? { ...card, source: sourceReference } : card,
                ),
            }),
        ).toThrow("Private card could not");
        expect(await storage.read(scope)).toEqual(original);
    });

    it("rejects duplicate card and import identities, rather than dropping or replacing entries", () => {
        const first = fixture();
        const second = fixture();
        expect(() => snapshotSavedLocalAppDraftCollection(collection(first, first))).toThrow();
        expect(() =>
            snapshotSavedLocalAppDraftCollection(
                collection(first, {
                    ...second,
                    draft: { ...second.draft, idempotencyKey: first.draft.idempotencyKey },
                }),
            ),
        ).toThrow();
        expect(() => snapshotSavedLocalAppDraftCollection(collection(first, second))).not.toThrow();
    });

    it("rejects extra fields, sparse arrays and accessors without executing private callbacks", () => {
        const saved = fixture();
        const getter = vi.fn(() => saved);
        const accessorCard = Object.defineProperty({}, "saved", { enumerable: true, get: getter });
        const accessorArray = Object.defineProperty(new Array(1), "0", {
            enumerable: true,
            get: getter,
        });
        const accessorVersion = Object.defineProperty({ cards: [] }, "version", {
            enumerable: true,
            get: getter,
        });
        const invalid = [
            { version: 3, cards: [] },
            { ...collection(saved), approval: "old consent" },
            { version: 2, cards: new Array(1) },
            { version: 2, cards: Object.assign([{ saved }], { extra: true }) },
            { version: 2, cards: [{ saved, payload: "source content" }] },
            { version: 2, cards: [{ saved, source: undefined }] },
            { version: 2, cards: [accessorCard] },
            { version: 2, cards: accessorArray },
            accessorVersion,
            { ...collection(saved), toJSON: getter },
            { ...collection(saved), [Symbol("private")]: true },
        ];
        for (const value of invalid)
            expect(() => snapshotSavedLocalAppDraftCollection(value)).toThrow();
        expect(getter).not.toHaveBeenCalled();
    });

    it("accepts bounded host references exactly and rejects content, malformed indices and accessors", () => {
        expect(snapshotLocalAppDraftSourceReference(sourceReference)).toEqual(sourceReference);
        expect(
            snapshotLocalAppDraftSourceReference({ chatKey: "chat", messageId: "message" }),
        ).toEqual({ chatKey: "chat", messageId: "message" });
        const getter = vi.fn(() => "private");
        const accessor = Object.defineProperty({ messageId: "message" }, "chatKey", {
            enumerable: true,
            get: getter,
        });
        const invalid = [
            null,
            [],
            new Date(),
            { ...sourceReference, chatKey: "" },
            { ...sourceReference, chatKey: " " },
            { ...sourceReference, chatKey: "x".repeat(2049) },
            { ...sourceReference, chatKey: "chat\ncontent" },
            { ...sourceReference, messageId: "x".repeat(129) },
            { ...sourceReference, messageId: "" },
            { ...sourceReference, messageId: 1 },
            { ...sourceReference, content: "PRIVATE_SOURCE_NOT_STORED" },
            { ...sourceReference, recipient: "PRIVATE_RECIPIENT" },
            { ...sourceReference, threadRootMessageIndex: undefined },
            { ...sourceReference, threadRootMessageIndex: -1 },
            { ...sourceReference, threadRootMessageIndex: 0.5 },
            { ...sourceReference, threadRootMessageIndex: Infinity },
            { ...sourceReference, threadRootMessageIndex: Number.MAX_SAFE_INTEGER + 1 },
            accessor,
        ];
        for (const value of invalid)
            expect(() => snapshotLocalAppDraftSourceReference(value)).toThrow();
        expect(getter).not.toHaveBeenCalled();
    });

    it("encrypts two cards and their source references in one scoped row with no source text", async () => {
        const db = backend();
        const storage = createLocalAppDraftStorage(db.store);
        const saved = collection(fixture(), fixture());
        const value = {
            ...saved,
            cards: saved.cards.map((card) => ({ ...card, source: sourceReference })),
        };
        await storage.write(scope, value);
        expect(db.records.size).toBe(1);
        const row = db.records.get(scopeKey())!;
        expect(row.version).toBe(2);
        expect(JSON.stringify(row)).not.toMatch(/PRIVATE_|chatKey|messageId|payload|recipient/);
        expect(new TextDecoder().decode(row.ciphertext)).not.toContain(sourceReference.chatKey);
        expect(await createLocalAppDraftStorage(db.store).read(scope)).toEqual(value);
        for (const field of ["account", "backend"] as const) {
            const other = { ...scope, [field]: "other" };
            expect(await storage.read(other)).toBeUndefined();
            db.records.set(scopeKey(other), structuredClone(row));
            await expect(storage.read(other)).rejects.toThrow("Private card could not");
        }
    });

    it("preserves the other card on discard and keeps an encrypted empty collection until Forget", async () => {
        const db = backend();
        const storage = createLocalAppDraftStorage(db.store);
        const first = fixture();
        const second = fixture();
        await storage.write(scope, collection(first, second));
        await storage.write(scope, collection(second));
        expect(await storage.read(scope)).toEqual(collection(second));
        await storage.write(scope, collection());
        expect(await storage.read(scope)).toEqual(collection());
        expect(db.records.get(scopeKey())?.key).toBeDefined();
        expect(db.store.remove).not.toHaveBeenCalled();
        await storage.remove(scope);
        expect(await storage.read(scope)).toBeUndefined();
        expect(db.records.get(scopeKey())).toEqual({
            version: 2,
            generation: expect.stringMatching(/^[a-f0-9]{64}$/),
            revision: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
    });
});

describe("legacy migration and collection compare-and-swap", () => {
    it.each([false, true])(
        "reads real v1 ciphertext without writes and migrates attempted=%s losslessly",
        async (attempted) => {
            const db = backend();
            const source = fixture();
            const saved = { ...source, draft: { ...source.draft, attempted } };
            const row = await legacyRow(saved);
            db.records.set(scopeKey(), row);
            const storage = createLocalAppDraftStorage(db.store);
            expect(await storage.read(scope)).toEqual(collection(saved));
            expect(db.records.get(scopeKey())).toBe(row);
            expect(db.store.replace).not.toHaveBeenCalled();
            expect(db.store.remove).not.toHaveBeenCalled();
            const second = fixture();
            await storage.write(scope, collection(saved, second));
            const migrated = db.records.get(scopeKey())!;
            expect(migrated.version).toBe(2);
            expect(migrated.generation).toBe(row.generation);
            expect(migrated.revision).not.toBe(row.revision);
            expect(migrated.iv).not.toEqual(row.iv);
            const recovered = await createLocalAppDraftStorage(db.store).read(scope);
            expect(recovered).toEqual(collection(saved, second));
            const send = vi.fn<LocalDraftDelivery>(async () => ({ kind: "uncertain" }));
            const drafts = new LocalAppDraftStore(send);
            drafts.setAccount(scope.account);
            const opened = drafts.restore(recovered!.cards[0].saved.draft);
            expect(opened.approval).toBeUndefined();
            expect(opened.status).toBe(attempted ? "uncertain" : "draft");
            const approval = attempted
                ? drafts.reviewRecovered(opened.id)
                : drafts.review(opened.id);
            expect(approval.request).toEqual({
                ...saved.draft.target,
                idempotencyKey: saved.draft.idempotencyKey,
                payload: saved.draft.payload,
            });
            expect(send).not.toHaveBeenCalled();
            if (attempted)
                expect(() => drafts.edit(opened.id, { payload: { note: "changed" } })).toThrow();
        },
    );

    it("does not delete or replace legacy ciphertext when the migration write fails", async () => {
        const db = backend();
        const saved = fixture();
        const row = await legacyRow(saved);
        db.records.set(scopeKey(), row);
        const storage = createLocalAppDraftStorage(db.store);
        await storage.read(scope);
        db.store.replace = vi.fn(async () => {
            throw new Error("private quota");
        });
        await expect(storage.write(scope, collection(saved, fixture()))).rejects.toThrow(
            "Private card could not",
        );
        expect(db.records.get(scopeKey())).toBe(row);
        expect(db.store.remove).not.toHaveBeenCalled();
        expect(await createLocalAppDraftStorage(db.store).read(scope)).toEqual(collection(saved));
    });

    it("fences the legacy version-one writer before its replace operation", async () => {
        const db = backend();
        const storage = createLocalAppDraftStorage(db.store);
        await storage.write(scope, collection(fixture(), fixture()));
        const row = db.records.get(scopeKey());
        const replacement = await legacyRow(fixture());
        const replace = vi.fn((...args: Parameters<LocalDraftRecordBackend["replace"]>) =>
            db.store.replace(...args),
        );
        const legacyWrite = async () => {
            const previous = await db.store.read(scopeKey());
            // The unchanged v1 checkRecord fence runs before encryption/CAS in the old writer.
            if (previous?.version !== 1)
                throw new Error(
                    "Private card could not be saved, restored or removed on this device",
                );
            await replace(scopeKey(), previous.revision, replacement);
        };
        await expect(legacyWrite()).rejects.toThrow("Private card could not");
        expect(replace).not.toHaveBeenCalled();
        expect(db.records.get(scopeKey())).toBe(row);
        await storage.remove(scope);
        await expect(legacyWrite()).rejects.toThrow("Private card could not");
        expect(replace).not.toHaveBeenCalled();
    });

    it.each(["legacy", "collection", "tombstone"] as const)(
        "requires successful prior observation of an existing %s row",
        async (kind) => {
            const db = backend();
            const original = fixture();
            const active = createLocalAppDraftStorage(db.store);
            if (kind === "legacy") db.records.set(scopeKey(), await legacyRow(original));
            else if (kind === "tombstone") await active.remove(scope);
            else await active.write(scope, collection(original));
            const row = db.records.get(scopeKey());
            const fresh = createLocalAppDraftStorage(db.store);
            await expect(fresh.write(scope, collection(fixture()))).rejects.toThrow(
                "Private card could not",
            );
            expect(db.records.get(scopeKey())).toBe(row);
            const recovered = await fresh.read(scope);
            await fresh.write(scope, recovered ?? collection());
            expect(db.records.get(scopeKey())?.version).toBe(2);
        },
    );

    it("does not let an unread in-flight read authorize a captured collection write", async () => {
        const db = backend();
        const original = collection(fixture(), fixture());
        await createLocalAppDraftStorage(db.store).write(scope, original);
        const fresh = createLocalAppDraftStorage(db.store);
        const reading = fresh.read(scope);
        const failed = expect(fresh.write(scope, collection(fixture()))).rejects.toThrow(
            "Private card could not",
        );
        await reading;
        await failed;
        expect(await fresh.read(scope)).toEqual(original);
    });

    it("does not rebase a stale captured write onto a queued refreshed observation", async () => {
        const db = backend();
        const active = createLocalAppDraftStorage(db.store);
        const stale = createLocalAppDraftStorage(db.store);
        const first = fixture();
        const original = collection(first);
        await active.write(scope, original);
        await stale.read(scope);
        const updated = collection(
            { ...first, draft: { ...first.draft, attempted: true } },
            fixture(),
        );
        await active.write(scope, updated);
        const reading = stale.read(scope);
        const failed = expect(stale.write(scope, original)).rejects.toThrow(
            "Private card could not",
        );
        await reading;
        await failed;
        expect(await active.read(scope)).toEqual(updated);
    });

    it.each(["decrypt", "validation"] as const)(
        "does not authorize writes after a failed %s",
        async (kind) => {
            const db = backend();
            const storage = createLocalAppDraftStorage(db.store);
            const saved = collection(fixture(), fixture());
            await storage.write(scope, saved);
            await storage.read(scope);
            const original = structuredClone(db.records.get(scopeKey())!);
            if (kind === "decrypt") {
                new Uint8Array(db.records.get(scopeKey())!.ciphertext!)[0] ^= 1;
            } else {
                const iv = crypto.getRandomValues(new Uint8Array(12));
                const ciphertext = await crypto.subtle.encrypt(
                    {
                        name: "AES-GCM",
                        iv,
                        additionalData: new TextEncoder().encode(
                            JSON.stringify([
                                "oc-private-card",
                                2,
                                scopeKey(),
                                original.generation,
                                original.revision,
                            ]),
                        ),
                    },
                    original.key!,
                    new TextEncoder().encode(
                        JSON.stringify({ version: 2, cards: [saved.cards[0], saved.cards[0]] }),
                    ),
                );
                db.records.set(scopeKey(), { ...original, iv, ciphertext });
            }
            await expect(storage.read(scope)).rejects.toThrow("Private card could not");
            db.records.set(scopeKey(), original);
            await expect(storage.write(scope, collection())).rejects.toThrow(
                "Private card could not",
            );
            expect(await storage.read(scope)).toEqual(saved);
        },
    );

    it("allows ordered own writes but rejects stale append and discard after another tab dispatches", async () => {
        const db = backend();
        const active = createLocalAppDraftStorage(db.store);
        const stale = createLocalAppDraftStorage(db.store);
        const first = fixture();
        const second = fixture();
        await active.read(scope);
        await Promise.all([
            active.write(scope, collection(first)),
            active.write(scope, collection(first, second)),
        ]);
        await stale.read(scope);
        const attempted = { ...first, draft: { ...first.draft, attempted: true } };
        const locked = collection(attempted, second);
        await active.write(scope, locked);
        await expect(stale.write(scope, collection(first, second, fixture()))).rejects.toThrow(
            "Private card could not",
        );
        await expect(stale.write(scope, collection(second))).rejects.toThrow(
            "Private card could not",
        );
        expect(await active.read(scope)).toEqual(locked);
    });

    it("rejects cross-tab migration replacement between encryption and atomic CAS", async () => {
        const db = backend();
        const original = fixture();
        db.records.set(scopeKey(), await legacyRow(original));
        const storage = createLocalAppDraftStorage(db.store);
        await storage.read(scope);
        const newer = await legacyRow(original, "c".repeat(64));
        const replace = db.store.replace;
        db.store.replace = async (key, expected, value) => {
            db.records.set(key, newer);
            await replace(key, expected, value);
        };
        await expect(storage.write(scope, collection(original, fixture()))).rejects.toThrow(
            "Private card could not",
        );
        expect(db.records.get(scopeKey())).toBe(newer);
        expect(db.store.remove).not.toHaveBeenCalled();
    });

    it("keeps all cards on quota failure and rejects resurrection after collection Forget", async () => {
        const db = backend();
        const active = createLocalAppDraftStorage(db.store);
        const stale = createLocalAppDraftStorage(db.store);
        const original = collection(fixture(), fixture());
        await active.write(scope, original);
        await stale.read(scope);
        const row = db.records.get(scopeKey());
        const replace = db.store.replace;
        db.store.replace = async () => {
            throw new Error("private quota diagnostic");
        };
        await expect(
            active.write(scope, collection(...original.cards.map((card) => card.saved), fixture())),
        ).rejects.toThrow(/^Private card could not be saved, restored or removed on this device$/);
        expect(db.records.get(scopeKey())).toBe(row);
        db.store.replace = replace;
        await active.remove(scope);
        await expect(stale.write(scope, original)).rejects.toThrow("Private card could not");
        expect(db.records.get(scopeKey())?.key).toBeUndefined();
        expect(db.records.get(scopeKey())?.ciphertext).toBeUndefined();
    });
});

describe("frozen encrypted per-card app metadata", () => {
    it("accepts equal schema values independently of catalog property insertion order", () => {
        const saved = fixture();
        const app = JSON.parse(JSON.stringify(appFixture(saved)));
        app.actions[0].draftSchema = {
            type: "object",
            required: ["note"],
            properties: { note: { type: "string" } },
            additionalProperties: false,
        };
        expect(JSON.stringify(app.actions[0].draftSchema)).not.toBe(
            JSON.stringify(saved.draft.schema),
        );
        const result = snapshotSavedLocalAppDraftCollection({
            version: 2,
            cards: [{ saved, app }],
        });
        expect(result.cards[0].saved).toEqual(saved);
        expect(result.cards[0].app!.actions[0].draftSchema).toEqual(saved.draft.schema);
    });

    it("roundtrips original action, presentation and choices without rebinding or plaintext metadata", async () => {
        const original = fixture();
        const saved = snapshotSavedLocalAppDraft({
            ...original,
            draft: {
                ...original.draft,
                schema: {
                    type: "object",
                    properties: { note: { type: "string" }, category: { type: "string" } },
                    required: ["note"],
                    additionalProperties: false,
                },
            },
        });
        const app = JSON.parse(JSON.stringify(appFixture(saved)));
        app.actions[0].draftEditor = {
            version: 1,
            choices: [
                {
                    field: "category",
                    label: "Original category",
                    noneLabel: "No category",
                    options: [
                        {
                            value: "private-category-id",
                            label: "Original named choice",
                            assign: [],
                            defaults: [],
                        },
                    ],
                },
            ],
        };
        const snapshot = snapshotSavedLocalAppDraftCollection({
            version: 2,
            cards: [{ saved, app, source: sourceReference }],
        });
        app.actions[0].definition.card.rows[0].label = "Changed label";
        app.actions[0].draftEditor.choices[0].options[0].label = "Changed choice";
        expect(snapshot.cards[0].app!.actions[0].definition.card.rows[0].label).toBe(
            "Original note",
        );
        expect(snapshot.cards[0].app!.actions[0].draftEditor!.choices[0].options[0].label).toBe(
            "Original named choice",
        );
        expect(Object.isFrozen(snapshot.cards[0].app!.actions[0].draftPresentation)).toBe(true);
        expect(Object.isFrozen(snapshot.cards[0].app!.actions[0].draftEditor)).toBe(true);
        const db = backend();
        await createLocalAppDraftStorage(db.store).write(scope, snapshot);
        const row = db.records.get(scopeKey())!;
        expect(JSON.stringify(row)).not.toMatch(
            /Original|Frozen|private-category-id|PRIVATE_CHAT_REFERENCE/,
        );
        expect(await createLocalAppDraftStorage(db.store).read(scope)).toEqual(snapshot);
    });

    it.each(["id", "revision", "destination", "action", "schema"] as const)(
        "rejects saved app %s drift from the immutable draft",
        (field) => {
            const saved = fixture();
            const app = JSON.parse(JSON.stringify(appFixture(saved)));
            if (field === "id") app.id = "another-app";
            if (field === "revision") app.revision = "2";
            if (field === "destination") app.destination = "https://another.invalid/import";
            if (field === "action") app.actions[0].definition.name = "another-action";
            if (field === "schema") app.actions[0].draftSchema.properties.note.maxLength = 100;
            expect(() =>
                snapshotSavedLocalAppDraftCollection({ version: 2, cards: [{ saved, app }] }),
            ).toThrow();
        },
    );

    it("binds the exact recipient encryption declaration, not just the app destination", async () => {
        const keys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
            "deriveBits",
        ]);
        const deliveryEncryption = {
            version: 1,
            scheme: "p256-hkdf-sha256-aes-256-gcm-v1",
            keyId: "a".repeat(64),
            publicKeySpki: Buffer.from(
                await crypto.subtle.exportKey("spki", keys.publicKey),
            ).toString("base64url"),
            recipientContext: "AQ",
        };
        const original = fixture();
        const saved = snapshotSavedLocalAppDraft({
            ...original,
            draft: {
                ...original.draft,
                target: { ...original.draft.target, deliveryEncryption },
            },
        });
        const app = appFixture(saved);
        expect(() =>
            snapshotSavedLocalAppDraftCollection({ version: 2, cards: [{ saved, app }] }),
        ).not.toThrow();
        const reordered = {
            ...app,
            deliveryEncryption: Object.fromEntries(
                Object.entries(app.deliveryEncryption!).reverse(),
            ),
        };
        expect(JSON.stringify(reordered.deliveryEncryption)).not.toBe(
            JSON.stringify(saved.draft.target.deliveryEncryption),
        );
        expect(() =>
            snapshotSavedLocalAppDraftCollection({
                version: 2,
                cards: [{ saved, app: reordered }],
            }),
        ).not.toThrow();
        for (const drift of [
            { ...app, deliveryEncryption: { ...app.deliveryEncryption, keyId: "b".repeat(64) } },
            { ...app, deliveryEncryption: { ...app.deliveryEncryption, recipientContext: "Ag" } },
        ]) {
            expect(() =>
                snapshotSavedLocalAppDraftCollection({
                    version: 2,
                    cards: [{ saved, app: drift }],
                }),
            ).toThrow();
        }
        const missing = JSON.parse(JSON.stringify(app));
        delete missing.deliveryEncryption;
        expect(() =>
            snapshotSavedLocalAppDraftCollection({ version: 2, cards: [{ saved, app: missing }] }),
        ).toThrow();
    });

    it("rejects app accessors, toJSON, cycles and unknown metadata without executing callbacks", () => {
        const saved = fixture();
        const app = appFixture(saved);
        const getter = vi.fn(() => app.actions);
        const accessor = Object.defineProperty({ ...app }, "actions", {
            enumerable: true,
            get: getter,
        });
        const cyclic = { ...app, extra: {} };
        cyclic.extra = cyclic;
        for (const bad of [
            accessor,
            { ...app, toJSON: getter },
            cyclic,
            { ...app, sourceMessage: "PRIVATE_SOURCE_NOT_STORED" },
            undefined,
        ]) {
            expect(() =>
                snapshotSavedLocalAppDraftCollection({ version: 2, cards: [{ saved, app: bad }] }),
            ).toThrow();
        }
        expect(getter).not.toHaveBeenCalled();
    });

    it("counts frozen app metadata toward the same total byte cap", () => {
        const cards = Array.from({ length: 4 }, () => ({
            ...fixture(),
            editorJson: "x".repeat(64 * 1024),
        }));
        const value = collection(...cards);
        const overhead = new TextEncoder().encode(JSON.stringify(value)).byteLength - 256 * 1024;
        const bounded = collection(
            ...cards.map((saved, index) =>
                index === 3
                    ? { ...saved, editorJson: saved.editorJson.slice(overhead + 10) }
                    : saved,
            ),
        );
        expect(() => snapshotSavedLocalAppDraftCollection(bounded)).not.toThrow();
        expect(() =>
            snapshotSavedLocalAppDraftCollection({
                ...bounded,
                cards: bounded.cards.map((card, index) =>
                    index === 0 ? { ...card, app: appFixture(card.saved) } : card,
                ),
            }),
        ).toThrow("Private card could not");
    });
});

describe("restored private draft consent", () => {
    it("restores unsent cards without approval and never dispatches during restore", async () => {
        const send = vi.fn<LocalDraftDelivery>(async () => ({ kind: "delivered" as const }));
        const saved = fixture();
        const fresh = new LocalAppDraftStore(send);
        fresh.setAccount(scope.account);
        const restored = fresh.restore(saved.draft);
        expect(restored.status).toBe("draft");
        expect(restored.approval).toBeUndefined();
        expect(send).not.toHaveBeenCalled();
        await expect(fresh.confirm(restored.id, "stale approval")).resolves.toEqual({
            kind: "blocked",
        });
    });

    it("retains possibly delivered requests exactly with the same import ID and fresh explicit consent", async () => {
        const send = vi.fn<LocalDraftDelivery>(async () => ({ kind: "uncertain" as const }));
        const first = new LocalAppDraftStore(send);
        first.setAccount(scope.account);
        const opened = first.restore(fixture().draft);
        const prior = first.review(opened.id);
        await first.confirm(opened.id, prior.approvalId);
        const saved = first.snapshot(opened.id);
        expect(JSON.stringify(saved)).not.toContain("approvalId");
        const fresh = new LocalAppDraftStore(send);
        fresh.setAccount(scope.account);
        const restored = fresh.restore(saved);
        expect(restored.status).toBe("uncertain");
        expect(restored.approval).toBeUndefined();
        expect(() => fresh.edit(restored.id, { payload: { note: "tampered" } })).toThrow();
        await expect(fresh.retryUncertain(restored.id, prior.approvalId)).resolves.toEqual({
            kind: "blocked",
        });
        const reviewed = fresh.reviewRecovered(restored.id);
        expect(reviewed.approvalId).not.toEqual(prior.approvalId);
        expect(reviewed.request).toEqual(prior.request);
        expect(send).toHaveBeenCalledTimes(1);
        await fresh.retryUncertain(restored.id, reviewed.approvalId);
        expect(send).toHaveBeenCalledTimes(2);
        expect(send.mock.calls[1][0]).toEqual(prior.request);
    });
});
