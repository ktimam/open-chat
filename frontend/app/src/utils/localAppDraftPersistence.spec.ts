// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { LocalAppDraftStore, type LocalDraftDelivery } from "./localAppDrafts";
import {
    createBrowserLocalAppDraftStorage,
    createLocalAppDraftStorage,
    snapshotSavedLocalAppDraft,
    type EncryptedLocalDraftRecord,
    type LocalDraftRecordBackend,
    type SavedLocalAppDraft,
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
        await expect(createLocalAppDraftStorage(db.store).read(scope)).resolves.toEqual(saved);
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
                    [field]: field === "generation" || field === "revision" ? "a".repeat(64) : 2,
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
        expect(persisted?.draft.attempted).toBe(true);
        expect(persisted?.draft.idempotencyKey).toBe(original.draft.idempotencyKey);
        expect(persisted?.draft.payload).toEqual(original.draft.payload);
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
