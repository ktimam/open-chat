import { afterEach, describe, expect, it, vi } from "vitest";
import { parseLocalAppCatalog } from "./localAppCatalog";
import {
    createBrowserLocalAppSetupStorage,
    decodeLocalAppSetup,
    encodeLocalAppSetup,
    validateLocalAppEnabledChats,
    validateLocalAppSetupSnapshot,
    type LocalAppSetupScope,
    type LocalAppSetupSnapshot,
    type LocalAppSetupStorage,
} from "./localAppSetupStore";

const scope: LocalAppSetupScope = { account: "synthetic-account", backend: "synthetic-backend" };
const key = (owner = scope) => JSON.stringify([owner.backend, owner.account]);
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

async function digest(value: string): Promise<string> {
    return Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
        (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
}
async function fixture(withProcessor = false): Promise<LocalAppSetupSnapshot> {
    const source = "globalThis.SETUP_CODE_EXECUTED = true; // synthetic imported artifact";
    const processor = {
        source,
        sha256: await digest(source),
        byteLength: new TextEncoder().encode(source).byteLength,
    };
    const catalog = parseLocalAppCatalog(
        JSON.stringify({
            version: 1,
            apps: [
                {
                    id: "sample",
                    revision: "v1",
                    name: "Sample",
                    description: "Synthetic app",
                    destination: "https://example.invalid/import",
                    ...(withProcessor
                        ? {
                              processor: {
                                  sha256: processor.sha256,
                                  byteLength: processor.byteLength,
                              },
                          }
                        : {}),
                    actions: [
                        {
                            definition: {
                                name: "sample.save",
                                description: "Synthetic action",
                                promptTemplate: "Use app-owned instructions.",
                                responseSchema: {},
                                card: {
                                    title: "Review",
                                    rows: [{ label: "Value", valueKey: "value" }],
                                    confirmLabel: "Send",
                                    cancelLabel: "Cancel",
                                },
                            },
                            draftSchema: {
                                type: "object",
                                properties: { value: { type: "string" } },
                                additionalProperties: false,
                            },
                            processorContext: { options: ["PRIVATE_IMPORTED_SETUP_ONLY"] },
                            handoff: { kind: "single" },
                        },
                    ],
                },
            ],
        }),
    );
    return {
        catalog,
        appId: "sample",
        actionId: "sample.save",
        ...(withProcessor ? { processor } : {}),
        enabledChats: [{ chatKey: "synthetic-chat", appIds: ["sample"] }],
    };
}

type FakeRequest = {
    result?: unknown;
    onsuccess?: () => void;
    onerror?: () => void;
};
type FakeTransaction = {
    mode: IDBTransactionMode;
    oncomplete?: () => void;
    onabort?: () => void;
    onerror?: () => void;
    request?: FakeRequest;
    commit: () => void;
    abort: () => void;
    objectStore: () => unknown;
};
/** Event-controlled test double: request success and transaction commit are separate events. */
function fakeIndexedDb() {
    const records = new Map<string, unknown>();
    const transactions: FakeTransaction[] = [];
    const closes: ReturnType<typeof vi.fn>[] = [];
    const openings: {
        result: unknown;
        onsuccess?: () => void;
        onerror?: () => void;
        onblocked?: () => void;
        onupgradeneeded?: (event: { oldVersion: number }) => void;
        transaction: { abort: ReturnType<typeof vi.fn> };
    }[] = [];
    let created = false;
    const control = {
        autoCommit: true,
        openMode: "normal" as "normal" | "error" | "blocked" | "pending" | "throw",
        badStore: false,
        throwRequest: false,
    };
    const open = vi.fn((_name: string, _version: number) => {
        if (control.openMode === "throw") throw new Error("SYNTHETIC_PRIVATE_ERROR");
        const close = vi.fn();
        closes.push(close);
        const database = {
            close,
            onversionchange: undefined,
            objectStoreNames: {
                get length() {
                    return created ? 1 : 0;
                },
                contains: () => created,
            },
            createObjectStore: vi.fn(() => {
                created = true;
            }),
            transaction: (_store: string, mode: IDBTransactionMode) => {
                let terminal = false;
                let commitMutation = () => {};
                const tx: FakeTransaction = {
                    mode,
                    commit() {
                        if (terminal) return;
                        terminal = true;
                        commitMutation();
                        tx.oncomplete?.();
                    },
                    abort() {
                        if (terminal) return;
                        terminal = true;
                        queueMicrotask(() => tx.onabort?.());
                    },
                    objectStore: () => {
                        const request = (
                            kind: "read" | "write" | "remove",
                            entry: string,
                            value?: unknown,
                        ) => {
                            if (control.throwRequest) throw new Error("SYNTHETIC_PRIVATE_ERROR");
                            const req: FakeRequest = {
                                result: kind === "read" ? records.get(entry) : entry,
                            };
                            tx.request = req;
                            commitMutation = () => {
                                if (kind === "write") records.set(entry, value);
                                else if (kind === "remove") records.delete(entry);
                            };
                            queueMicrotask(() => {
                                req.onsuccess?.();
                                if (control.autoCommit) queueMicrotask(() => tx.commit());
                            });
                            return req;
                        };
                        return {
                            keyPath: control.badStore ? "unexpected" : null,
                            autoIncrement: false,
                            indexNames: { length: 0 },
                            get: (entry: string) => request("read", entry),
                            put: (value: unknown, entry: string) => request("write", entry, value),
                            delete: (entry: string) => request("remove", entry),
                        };
                    },
                };
                transactions.push(tx);
                return tx;
            },
        };
        const request = {
            result: database,
            transaction: { abort: vi.fn() },
        } as (typeof openings)[number];
        openings.push(request);
        queueMicrotask(() => {
            if (control.openMode === "pending") return;
            if (control.openMode === "error") return request.onerror?.();
            if (control.openMode === "blocked") return request.onblocked?.();
            if (!created) request.onupgradeneeded?.({ oldVersion: 0 });
            request.onsuccess?.();
        });
        return request;
    });
    const factory = { open } as unknown as IDBFactory;
    return { factory, open, records, transactions, closes, openings, control };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

async function prime(storage: LocalAppSetupStorage, db: ReturnType<typeof fakeIndexedDb>) {
    await storage.read(scope);
    db.transactions.length = 0;
    db.closes.length = 0;
}

function expectTombstone(db: ReturnType<typeof fakeIndexedDb>) {
    const value = db.records.get(key()) as Record<string, unknown>;
    expect(Object.keys(value).sort()).toEqual(["generation", "scope", "version"]);
    expect(value.generation).toMatch(/^[a-f0-9]{64}$/);
    expect(value.generation).not.toBe("0".repeat(64));
    expect(value.scope).toEqual(scope);
}

describe("strict device-local setup codec", () => {
    it("remembers and revalidates app views and binds chat opt-ins to their exact catalog", async () => {
        const snapshot = await fixture();
        const app = snapshot.catalog.apps[0];
        const draftView = {
            version: 1,
            nodes: [{ kind: "field", field: "value", control: "multiline" }],
            theme: { dark: { surface: "#112233" } },
        };
        const catalog = parseLocalAppCatalog(
            JSON.stringify({
                version: 1,
                apps: [{ ...app, actions: [{ ...app.actions[0], draftView }] }],
            }),
        );
        const serialized = await encodeLocalAppSetup(scope, { ...snapshot, catalog });
        const restored = await decodeLocalAppSetup(scope, serialized);
        expect(restored.catalog.apps[0].actions[0].draftView).toEqual(draftView);
        expect(Object.isFrozen(restored.catalog.apps[0].actions[0].draftView?.nodes)).toBe(true);
        const envelope = JSON.parse(serialized);
        const changed = JSON.parse(envelope.catalogJson);
        changed.apps[0].actions[0].draftView.theme.dark.surface = "#332211";
        envelope.catalogJson = JSON.stringify(changed);
        await expect(decodeLocalAppSetup(scope, JSON.stringify(envelope))).rejects.toThrow();
        envelope.catalogSha256 = await digest(envelope.catalogJson);
        await expect(decodeLocalAppSetup(scope, JSON.stringify(envelope))).rejects.toThrow();
        changed.apps[0].actions[0].draftView.nodes[0].field = "undeclared";
        envelope.catalogJson = JSON.stringify(changed);
        envelope.catalogSha256 = await digest(envelope.catalogJson);
        envelope.enabledChats.catalogSha256 = envelope.catalogSha256;
        await expect(decodeLocalAppSetup(scope, JSON.stringify(envelope))).rejects.toThrow();
    });
    it("remembers the app's named-choice declaration but not an initialized draft session", async () => {
        const snapshot = await fixture();
        const app = snapshot.catalog.apps[0];
        const action = app.actions[0];
        const draftEditor = {
            version: 1,
            choices: [
                {
                    field: "value",
                    label: "Private saved choice",
                    noneLabel: "None",
                    options: [
                        { value: "saved-a", label: "PRIVATE_LABEL", assign: [], defaults: [] },
                    ],
                },
            ],
        };
        const catalog = parseLocalAppCatalog(
            JSON.stringify({
                version: 1,
                apps: [{ ...app, actions: [{ ...action, draftEditor }] }],
            }),
        );
        const serialized = await encodeLocalAppSetup(scope, { ...snapshot, catalog });
        const restored = await decodeLocalAppSetup(scope, serialized);
        expect(restored.catalog.apps[0].actions[0].draftEditor).toEqual(draftEditor);
        expect(Object.isFrozen(restored.catalog.apps[0].actions[0].draftEditor)).toBe(true);
        expect(serialized).not.toMatch(/editorJson|baseline|choiceSession|draftManualValues/);
        const envelope = JSON.parse(serialized);
        const corrupted = JSON.parse(envelope.catalogJson);
        corrupted.apps[0].actions[0].draftEditor.choices[0].options[0].assign = [
            { field: "missing", value: "forged" },
        ];
        envelope.catalogJson = JSON.stringify(corrupted);
        envelope.catalogSha256 = await digest(envelope.catalogJson);
        envelope.enabledChats.catalogSha256 = envelope.catalogSha256;
        await expect(decodeLocalAppSetup(scope, JSON.stringify(envelope))).rejects.toThrow();
    });
    it("round-trips only imported setup, selection, verified code and enabled chats as immutable data", async () => {
        const snapshot = await fixture(true);
        const serialized = await encodeLocalAppSetup(scope, snapshot);
        const envelope = JSON.parse(serialized);
        expect(envelope.version).toBe(1);
        expect(envelope.scope).toEqual(scope);
        expect(envelope.catalogSha256).toBe(await digest(envelope.catalogJson));
        expect(envelope.enabledChats.catalogSha256).toBe(envelope.catalogSha256);
        const decoded = await decodeLocalAppSetup(scope, serialized);
        expect(decoded).toEqual(snapshot);
        expect(Object.isFrozen(decoded)).toBe(true);
        expect(Object.isFrozen(decoded.catalog.apps[0].actions[0].processorContext)).toBe(true);
        expect(Object.isFrozen(decoded.enabledChats[0].appIds)).toBe(true);
        expect(Object.isFrozen(decoded.processor)).toBe(true);
        expect((globalThis as Record<string, unknown>).SETUP_CODE_EXECUTED).toBeUndefined();
    });
    it.each([
        "draft",
        "choiceSession",
        "draftManualValues",
        "rows",
        "baseline",
        "message",
        "editorJson",
        "approval",
        "recipient",
        "delivery",
        "payload",
        "pairingCode",
        "idempotencyKey",
    ])(
        "rejects workspace-only field %s instead of silently retaining or discarding it",
        async (field) => {
            const input = { ...(await fixture()), [field]: "PRIVATE_RUNTIME_MARKER" };
            await expect(validateLocalAppSetupSnapshot(input)).rejects.toThrow(
                "Invalid stored private app setup",
            );
            const stored = JSON.parse(await encodeLocalAppSetup(scope, await fixture()));
            stored[field] = "PRIVATE_RUNTIME_MARKER";
            await expect(decodeLocalAppSetup(scope, JSON.stringify(stored))).rejects.toThrow();
        },
    );
    it("pins caller-owned data before asynchronous verification", async () => {
        const input = copy(await fixture(true));
        const owner = { ...scope };
        const original = copy(input);
        const pending = encodeLocalAppSetup(owner, input);
        Object.assign(input.processor!, { source: "changed" });
        Object.assign(input.catalog.apps[0], { destination: "https://other.invalid/" });
        Object.assign(input.enabledChats[0], { chatKey: "changed" });
        owner.account = "other";
        expect(await decodeLocalAppSetup(scope, await pending)).toEqual(original);
    });
    it("rejects account/backend mismatch, extra scope keys and invalid scope identifiers", async () => {
        const value = await encodeLocalAppSetup(scope, await fixture());
        for (const owner of [
            { ...scope, account: "other" },
            { ...scope, backend: "other" },
        ])
            await expect(decodeLocalAppSetup(owner, value)).rejects.toThrow();
        for (const owner of [
            { ...scope, account: "" },
            { ...scope, backend: " hidden" },
            { ...scope, account: "a\n" },
            { ...scope, extra: true },
        ])
            await expect(encodeLocalAppSetup(owner, await fixture())).rejects.toThrow();
    });
    it.each([0, 2, "1"])(
        "rejects unsupported version %s without migration/fallback",
        async (version) => {
            const stored = JSON.parse(await encodeLocalAppSetup(scope, await fixture()));
            stored.version = version;
            await expect(decodeLocalAppSetup(scope, JSON.stringify(stored))).rejects.toThrow();
        },
    );
    it("rejects catalog changes and opt-ins bound to a different exact catalog", async () => {
        const stored = JSON.parse(await encodeLocalAppSetup(scope, await fixture()));
        stored.catalogJson = stored.catalogJson.replace("example.invalid", "another.invalid");
        await expect(decodeLocalAppSetup(scope, JSON.stringify(stored))).rejects.toThrow();
        stored.catalogSha256 = await digest(stored.catalogJson);
        await expect(decodeLocalAppSetup(scope, JSON.stringify(stored))).rejects.toThrow();
    });
    it("rejects duplicate serialized keys, unknown nested fields and non-string/oversized records", async () => {
        const encoded = await encodeLocalAppSetup(scope, await fixture());
        await expect(
            decodeLocalAppSetup(scope, encoded.replace('"version":1', '"version":0,"version":1')),
        ).rejects.toThrow();
        const stored = JSON.parse(encoded);
        stored.enabledChats.hidden = "PRIVATE_RUNTIME_MARKER";
        await expect(decodeLocalAppSetup(scope, JSON.stringify(stored))).rejects.toThrow();
        await expect(decodeLocalAppSetup(scope, {})).rejects.toThrow();
        await expect(decodeLocalAppSetup(scope, "x".repeat(8 * 1024 * 1024 + 1))).rejects.toThrow();
    });
    it("rejects malformed catalog and stale app/action selections", async () => {
        const valid = await fixture();
        for (const patch of [
            { appId: "missing" },
            { actionId: "missing" },
            { appId: undefined },
            { catalog: { version: 2, apps: [] } },
        ])
            await expect(validateLocalAppSetupSnapshot({ ...valid, ...patch })).rejects.toThrow();
        expect(
            await validateLocalAppSetupSnapshot({ catalog: valid.catalog, enabledChats: [] }),
        ).toEqual({ catalog: valid.catalog, enabledChats: [] });
    });
    it("rehashes processor bytes and rejects a stale descriptor or unselected processor", async () => {
        const valid = await fixture(true);
        for (const patch of [
            {
                processor: {
                    ...valid.processor,
                    source: valid.processor!.source.replace("true", "null"),
                },
            },
            { processor: { ...valid.processor, sha256: "0".repeat(64) } },
            { processor: { ...valid.processor, byteLength: 1 } },
            { processor: { ...valid.processor, extra: "hidden" } },
            { actionId: undefined },
        ])
            await expect(validateLocalAppSetupSnapshot({ ...valid, ...patch })).rejects.toThrow();
        const stored = JSON.parse(await encodeLocalAppSetup(scope, valid));
        stored.processor.source = stored.processor.source.replace("true", "null");
        await expect(decodeLocalAppSetup(scope, JSON.stringify(stored))).rejects.toThrow();
    });
    it("never invokes caller getters or toJSON hooks", async () => {
        const getter = vi.fn(() => "secret");
        const input = { ...(await fixture()) };
        Object.defineProperty(input, "appId", { get: getter, enumerable: true });
        await expect(validateLocalAppSetupSnapshot(input)).rejects.toThrow();
        expect(getter).not.toHaveBeenCalled();
        const toJSON = vi.fn();
        await expect(
            validateLocalAppSetupSnapshot({ ...(await fixture()), catalog: { toJSON } }),
        ).rejects.toThrow();
        expect(toJSON).not.toHaveBeenCalled();
    });
    it("bounds and validates enabled chat metadata and returns independent frozen rows", async () => {
        const { catalog } = await fixture();
        const rows = [{ chatKey: "chat", appIds: ["sample"] }];
        const frozen = validateLocalAppEnabledChats(rows, catalog);
        rows[0].appIds[0] = "changed";
        expect(frozen[0].appIds).toEqual(["sample"]);
        for (const invalid of [
            [{ chatKey: "chat", appIds: [] }],
            [{ chatKey: "chat", appIds: ["missing"] }],
            [{ chatKey: "chat", appIds: ["sample", "sample"] }],
            [{ chatKey: "chat", appIds: ["sample"], payload: {} }],
            [
                { chatKey: "chat", appIds: ["sample"] },
                { chatKey: "chat", appIds: ["sample"] },
            ],
            [{ chatKey: "x".repeat(513), appIds: ["sample"] }],
            Array.from({ length: 257 }, (_, index) => ({
                chatKey: `chat-${index}`,
                appIds: ["sample"],
            })),
        ])
            expect(() => validateLocalAppEnabledChats(invalid, catalog)).toThrow();
    });
});

describe("isolated IndexedDB setup adapter", () => {
    it("is lazy and reports missing/denied storage without network or localStorage fallback", async () => {
        const fetch = vi.fn();
        const localStorage = { getItem: vi.fn(), setItem: vi.fn() };
        vi.stubGlobal("fetch", fetch);
        vi.stubGlobal("localStorage", localStorage);
        const getter = vi.fn(() => undefined);
        const storage = createBrowserLocalAppSetupStorage({ indexedDB: getter });
        expect(getter).not.toHaveBeenCalled();
        await expect(storage.read(scope)).rejects.toThrow("on this device");
        const denied = createBrowserLocalAppSetupStorage({
            indexedDB: () => {
                throw new Error("PRIVATE_ERROR");
            },
        });
        await expect(denied.remove(scope)).rejects.toThrow("on this device");
        expect(fetch).not.toHaveBeenCalled();
        expect(localStorage.getItem).not.toHaveBeenCalled();
        expect(localStorage.setItem).not.toHaveBeenCalled();
    });
    it("survives a new adapter instance and isolates each account and backend", async () => {
        const db = fakeIndexedDb();
        const storage = createBrowserLocalAppSetupStorage({ indexedDB: () => db.factory });
        expect(await storage.read(scope)).toBeUndefined();
        const value = await fixture(true);
        await storage.write(scope, value);
        const fresh = createBrowserLocalAppSetupStorage({ indexedDB: () => db.factory });
        expect(await fresh.read(scope)).toEqual(value);
        expect(await fresh.read({ ...scope, account: "other" })).toBeUndefined();
        expect(await fresh.read({ ...scope, backend: "other" })).toBeUndefined();
        await fresh.remove({ ...scope, account: "other" });
        expect(await fresh.read(scope)).toEqual(value);
        expect(db.open).toHaveBeenCalledWith("openchat-private-app-setup", 1);
        expect(db.closes.every((close) => close.mock.calls.length === 1)).toBe(true);
    });
    it("stores only ciphertext and a nonextractable key, including private connection setup", async () => {
        const db = fakeIndexedDb();
        const value = await fixture(true);
        const storage = createBrowserLocalAppSetupStorage({ indexedDB: () => db.factory });
        await storage.write(scope, value);
        const record = db.records.get(key()) as {
            version: number;
            sealed: { key: CryptoKey; iv: Uint8Array; ciphertext: Uint8Array };
        };
        expect(record.version).toBe(2);
        expect(record).not.toHaveProperty("snapshotJson");
        expect(JSON.stringify(record)).not.toContain("PRIVATE_IMPORTED_SETUP_ONLY");
        expect(JSON.stringify(record)).not.toContain("synthetic imported artifact");
        expect(record.sealed.key.extractable).toBe(false);
        await expect(crypto.subtle.exportKey("raw", record.sealed.key)).rejects.toThrow();
        // IndexedDB structured-clones CryptoKey and typed arrays, not JSON representations.
        db.records.set(key(), structuredClone(record));
        expect(
            await createBrowserLocalAppSetupStorage({ indexedDB: () => db.factory }).read(scope),
        ).toEqual(value);
    });
    it("reads legacy setup but upgrades only on a successful new write", async () => {
        const db = fakeIndexedDb();
        const value = await fixture();
        const legacy = {
            version: 1,
            scope,
            generation: "0".repeat(64),
            snapshotJson: await encodeLocalAppSetup(scope, value),
        };
        db.records.set(key(), legacy);
        const storage = createBrowserLocalAppSetupStorage({ indexedDB: () => db.factory });
        expect(await storage.read(scope)).toEqual(value);
        expect(db.records.get(key())).toBe(legacy);
        await storage.write(scope, value);
        expect(db.records.get(key())).toMatchObject({ version: 2 });
        expect(db.records.get(key())).not.toHaveProperty("snapshotJson");
        expect(await storage.read(scope)).toEqual(value);
    });
    it.each(["ciphertext", "iv", "generation", "scope"])(
        "rejects encrypted setup with tampered %s without deleting it",
        async (field) => {
            const db = fakeIndexedDb();
            const storage = createBrowserLocalAppSetupStorage({ indexedDB: () => db.factory });
            await storage.write(scope, await fixture());
            const record = structuredClone(db.records.get(key())) as {
                generation: string;
                scope: LocalAppSetupScope;
                sealed: { iv: Uint8Array; ciphertext: Uint8Array };
            };
            let requestedScope = scope;
            if (field === "ciphertext" || field === "iv") record.sealed[field][0] ^= 1;
            if (field === "generation") record.generation = "f".repeat(64);
            if (field === "scope") {
                requestedScope = { ...scope, account: "another-account" };
                record.scope = requestedScope;
            }
            db.records.set(key(requestedScope), record);
            await expect(storage.read(requestedScope)).rejects.toThrow();
            expect(db.records.get(key(requestedScope))).toBe(record);
        },
    );
    it("forgets ciphertext and key material and uses a fresh key after reconnecting", async () => {
        const db = fakeIndexedDb();
        const storage = createBrowserLocalAppSetupStorage({ indexedDB: () => db.factory });
        const value = await fixture();
        await storage.write(scope, value);
        const before = db.records.get(key()) as { sealed: { key: CryptoKey } };
        await storage.remove(scope);
        expectTombstone(db);
        expect(db.records.get(key())).not.toHaveProperty("sealed");
        await storage.write(scope, value);
        const after = db.records.get(key()) as { sealed: { key: CryptoKey } };
        expect(after.sealed.key).not.toBe(before.sealed.key);
        expect(await storage.read(scope)).toEqual(value);
    });
    it("does not report persistence success before transaction completion", async () => {
        const db = fakeIndexedDb();
        const storage = createBrowserLocalAppSetupStorage({ indexedDB: () => db.factory });
        await prime(storage, db);
        db.control.autoCommit = false;
        let complete = false;
        const pending = storage.write(scope, await fixture()).then(() => {
            complete = true;
        });
        await vi.waitFor(() => expect(db.transactions).toHaveLength(1));
        expect(db.transactions[0].request).toBeDefined();
        expect(complete).toBe(false);
        expect(db.records.size).toBe(0);
        db.transactions[0].commit();
        await pending;
        expect(complete).toBe(true);
        expect(db.records.size).toBe(1);
        expect(db.closes[0]).toHaveBeenCalledOnce();
    });
    it("rejects abort after request success and closes the connection", async () => {
        const db = fakeIndexedDb();
        const storage = createBrowserLocalAppSetupStorage({ indexedDB: () => db.factory });
        await prime(storage, db);
        db.control.autoCommit = false;
        const pending = storage.write(scope, await fixture());
        const rejected = expect(pending).rejects.toThrow("on this device");
        await vi.waitFor(() => expect(db.transactions).toHaveLength(1));
        db.transactions[0].abort();
        await rejected;
        expect(db.records.size).toBe(0);
        expect(db.closes[0]).toHaveBeenCalledOnce();
    });
    it("orders pending writes/removals across adapter instances without resurrecting removed setup", async () => {
        const db = fakeIndexedDb();
        const first = createBrowserLocalAppSetupStorage({ indexedDB: () => db.factory });
        const second = createBrowserLocalAppSetupStorage({ indexedDB: () => db.factory });
        await prime(first, db);
        db.control.autoCommit = false;
        const writing = first.write(scope, await fixture(true));
        const removing = second.remove(scope);
        await vi.waitFor(() => expect(db.transactions).toHaveLength(1));
        db.transactions[0].commit();
        await writing;
        await vi.waitFor(() => expect(db.transactions).toHaveLength(2));
        expect(db.records.has(key())).toBe(true);
        db.transactions[1].commit();
        await removing;
        expectTombstone(db);
        db.control.autoCommit = true;
        expect(await second.read(scope)).toBeUndefined();
    });
    it("captures input before queueing and a rejected operation does not poison later removal", async () => {
        const db = fakeIndexedDb();
        const storage = createBrowserLocalAppSetupStorage({ indexedDB: () => db.factory });
        const value = copy(await fixture());
        const writing = storage.write(scope, value);
        Object.assign(value, { appId: "missing" });
        await writing;
        expect((await storage.read(scope))?.appId).toBe("sample");
        await expect(storage.write(scope, value)).rejects.toThrow();
        await storage.remove(scope);
        expectTombstone(db);
    });
    it("rejects a request/quota failure and still performs a removal already queued behind it", async () => {
        const db = fakeIndexedDb();
        const storage = createBrowserLocalAppSetupStorage({ indexedDB: () => db.factory });
        await prime(storage, db);
        db.control.autoCommit = false;
        const writing = storage.write(scope, await fixture());
        const rejected = expect(writing).rejects.toThrow("on this device");
        const removing = storage.remove(scope);
        await vi.waitFor(() => expect(db.transactions).toHaveLength(1));
        db.transactions[0].request!.onerror?.();
        await rejected;
        await vi.waitFor(() => expect(db.transactions).toHaveLength(2));
        db.transactions[1].commit();
        await removing;
        expectTombstone(db);
        expect(db.closes.every((close) => close.mock.calls.length === 1)).toBe(true);
    });
    it.each(["error", "throw", "blocked"] as const)(
        "surfaces %s open failure without hiding the error",
        async (mode) => {
            const db = fakeIndexedDb();
            db.control.openMode = mode;
            const storage = createBrowserLocalAppSetupStorage({ indexedDB: () => db.factory });
            await expect(storage.read(scope)).rejects.toThrow("on this device");
            expect(db.transactions).toHaveLength(0);
            if (mode === "blocked") {
                db.openings[0].onupgradeneeded?.({ oldVersion: 0 });
                expect(db.openings[0].transaction.abort).toHaveBeenCalledOnce();
                db.openings[0].onsuccess?.();
                expect(db.closes[0]).toHaveBeenCalledOnce();
            }
        },
    );
    it.each(["badStore", "throwRequest"] as const)(
        "rejects %s and closes the database",
        async (mode) => {
            const db = fakeIndexedDb();
            db.control[mode] = true;
            const storage = createBrowserLocalAppSetupStorage({ indexedDB: () => db.factory });
            await expect(storage.read(scope)).rejects.toThrow("on this device");
            expect(db.closes[0]).toHaveBeenCalledOnce();
        },
    );
    it("times out a pending open and closes a late connection", async () => {
        vi.useFakeTimers();
        const db = fakeIndexedDb();
        db.control.openMode = "pending";
        const storage = createBrowserLocalAppSetupStorage({ indexedDB: () => db.factory });
        const pending = storage.read(scope);
        const rejected = expect(pending).rejects.toThrow("on this device");
        await vi.advanceTimersByTimeAsync(10_000);
        await rejected;
        db.openings[0].onsuccess?.();
        expect(db.closes[0]).toHaveBeenCalledOnce();
    });
    it("aborts a transaction that never completes and cannot later commit it", async () => {
        vi.useFakeTimers();
        const db = fakeIndexedDb();
        db.control.autoCommit = false;
        const storage = createBrowserLocalAppSetupStorage({ indexedDB: () => db.factory });
        const pending = storage.read(scope);
        const rejected = expect(pending).rejects.toThrow("on this device");
        await vi.advanceTimersByTimeAsync(10_000);
        await rejected;
        expect(db.transactions).toHaveLength(1);
        db.transactions[0].commit();
        expect(db.closes[0]).toHaveBeenCalledOnce();
        expect(db.records.size).toBe(0);
    });
    it("rejects a foreign owner envelope even if placed under the requested database key", async () => {
        const db = fakeIndexedDb();
        db.records.set(key(), {
            version: 1,
            scope: { ...scope, account: "different" },
            generation: "0".repeat(64),
            snapshotJson: await encodeLocalAppSetup(
                { ...scope, account: "different" },
                await fixture(),
            ),
        });
        const storage = createBrowserLocalAppSetupStorage({ indexedDB: () => db.factory });
        await expect(storage.read(scope)).rejects.toThrow("Invalid stored private app setup");
        expect(db.records.has(key())).toBe(true);
    });
    it("fails closed on corrupted/future records without deleting or rewriting them", async () => {
        const db = fakeIndexedDb();
        const storage = createBrowserLocalAppSetupStorage({ indexedDB: () => db.factory });
        const raw = JSON.stringify({
            version: 2,
            PRIVATE_SETUP_MARKER: "retain for explicit removal",
        });
        db.records.set(key(), raw);
        await expect(storage.read(scope)).rejects.toThrow("Invalid stored private app setup");
        expect(db.records.get(key())).toBe(raw);
        expect(db.transactions.every((tx) => tx.mode === "readonly")).toBe(true);
        await storage.remove(scope);
        expectTombstone(db);
    });
    it("allows rapid ordinary writes but rejects a save queued before Forget completed", async () => {
        const db = fakeIndexedDb();
        const storage = createBrowserLocalAppSetupStorage({ indexedDB: () => db.factory });
        await storage.read(scope);
        const value = await fixture();
        const first = storage.write(scope, value);
        const second = storage.write(scope, { ...value, enabledChats: [] });
        await Promise.all([first, second]);
        expect((await storage.read(scope))?.enabledChats).toEqual([]);
        const removing = storage.remove(scope);
        const stale = storage.write(scope, value);
        const rejected = expect(stale).rejects.toThrow("on this device");
        await removing;
        await rejected;
        expectTombstone(db);
    });
    it("blocks another tab's delayed hash/write after Forget and permits a fresh read/import", async () => {
        const db = fakeIndexedDb();
        const firstTab = createBrowserLocalAppSetupStorage({ indexedDB: () => db.factory });
        // A separately loaded module has its own queues, just like a different browser tab.
        vi.resetModules();
        const otherModule = await import("./localAppSetupStore");
        const otherTab = otherModule.createBrowserLocalAppSetupStorage({
            indexedDB: () => db.factory,
        });
        const value = await fixture(true);
        await firstTab.write(scope, value);
        let release!: () => void;
        let entered!: () => void;
        const paused = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
        vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (algorithm, bytes) => {
            entered();
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            return originalDigest(algorithm, bytes);
        });
        const writing = firstTab.write(scope, value);
        const rejected = expect(writing).rejects.toThrow("on this device");
        await paused;
        await otherTab.remove(scope);
        expectTombstone(db);
        release();
        await rejected;
        expectTombstone(db);
        await expect(firstTab.write(scope, value)).rejects.toThrow("on this device");
        expect(await firstTab.read(scope)).toBeUndefined();
        await firstTab.write(scope, value);
        expect(await otherTab.read(scope)).toEqual(value);
    });
    it("does not restore a capability when another tab Forgets during decryption", async () => {
        const db = fakeIndexedDb();
        const readingTab = createBrowserLocalAppSetupStorage({ indexedDB: () => db.factory });
        vi.resetModules();
        const otherModule = await import("./localAppSetupStore");
        const otherTab = otherModule.createBrowserLocalAppSetupStorage({
            indexedDB: () => db.factory,
        });
        await readingTab.write(scope, await fixture());
        let release!: () => void;
        let entered!: () => void;
        const paused = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
        vi.spyOn(crypto.subtle, "decrypt").mockImplementationOnce(async (algorithm, key, bytes) => {
            entered();
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            return decrypt(algorithm, key, bytes);
        });
        const reading = readingTab.read(scope);
        const rejected = expect(reading).rejects.toThrow("on this device");
        await paused;
        await otherTab.remove(scope);
        release();
        await rejected;
        expectTombstone(db);
        expect(await readingTab.read(scope)).toBeUndefined();
    });
    it("retains the new generation through reimport so an old tab cannot overwrite it", async () => {
        const db = fakeIndexedDb();
        const staleTab = createBrowserLocalAppSetupStorage({ indexedDB: () => db.factory });
        vi.resetModules();
        const freshModule = await import("./localAppSetupStore");
        const freshTab = freshModule.createBrowserLocalAppSetupStorage({
            indexedDB: () => db.factory,
        });
        const value = await fixture();
        await staleTab.write(scope, value);
        await freshTab.remove(scope);
        await freshTab.write(scope, { ...value, enabledChats: [] });
        await expect(staleTab.write(scope, value)).rejects.toThrow("on this device");
        expect((await freshTab.read(scope))?.enabledChats).toEqual([]);
    });
});
