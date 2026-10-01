import {
    snapshotLocalDraftRecovery,
    snapshotLocalDraftPayload,
    snapshotLocalDraftJson,
    type LocalDraftSnapshot,
} from "./localAppDrafts";
import type { LocalAppSetupScope } from "./localAppSetupStore";
import { parseLocalAppCatalog, type LocalAppCatalogEntry } from "./localAppCatalog";

export interface SavedLocalAppDraft {
    readonly version: 1;
    readonly draft: LocalDraftSnapshot;
    readonly editorJson: string;
    readonly recipient: string;
}
export interface LocalAppDraftSourceReference {
    readonly chatKey: string;
    readonly messageId: string;
    readonly threadRootMessageIndex?: number;
}
export interface SavedLocalAppDraftCollection {
    readonly version: 2;
    readonly activeDraftId?: string;
    readonly cards: readonly {
        readonly saved: SavedLocalAppDraft;
        readonly source?: LocalAppDraftSourceReference;
        readonly app?: LocalAppCatalogEntry;
    }[];
}
export const MAX_SAVED_LOCAL_APP_DRAFTS = 8;
export interface LocalAppDraftStorage {
    read(scope: LocalAppSetupScope): Promise<SavedLocalAppDraftCollection | undefined>;
    write(
        scope: LocalAppSetupScope,
        value: SavedLocalAppDraftCollection | SavedLocalAppDraft,
    ): Promise<void>;
    remove(scope: LocalAppSetupScope): Promise<void>;
}
export interface EncryptedLocalDraftRecord {
    readonly version: 1 | 2;
    readonly generation: string;
    readonly revision: string;
    readonly key?: CryptoKey;
    readonly iv?: Uint8Array<ArrayBuffer>;
    readonly ciphertext?: ArrayBuffer;
}
/** Atomic compare/write is required; an asynchronous read followed by put is not equivalent. */
export interface LocalDraftRecordBackend {
    read(key: string): Promise<EncryptedLocalDraftRecord | undefined>;
    replace(
        key: string,
        expectedRevision: string | undefined,
        value: EncryptedLocalDraftRecord,
    ): Promise<void>;
    remove(key: string, tombstone: EncryptedLocalDraftRecord): Promise<void>;
}
const DATABASE = "openchat-private-app-drafts";
const STORE = "encrypted-cards";
const ZERO = "0".repeat(64);
const LIMIT = 256 * 1024;
const TIMEOUT_MS = 10_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const queues = new Map<string, Promise<void>>();
const failure = () =>
    new Error("Private card could not be saved, restored or removed on this device");
function invalid(): never {
    throw failure();
}

function scopeKey(scope: LocalAppSetupScope): string {
    if (
        !scope ||
        typeof scope.account !== "string" ||
        !scope.account.trim() ||
        scope.account.length > 512 ||
        typeof scope.backend !== "string" ||
        !scope.backend.trim() ||
        scope.backend.length > 2048
    )
        invalid();
    return JSON.stringify([scope.backend, scope.account]);
}
export function snapshotSavedLocalAppDraft(value: unknown): SavedLocalAppDraft {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
    const required = ["version", "draft", "editorJson", "recipient"];
    if (Reflect.ownKeys(value).length !== required.length) invalid();
    const fields: Record<string, unknown> = {};
    for (const name of required) {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
        fields[name] = descriptor.value;
    }
    if (
        fields.version !== 1 ||
        typeof fields.editorJson !== "string" ||
        encoder.encode(fields.editorJson).byteLength > 64 * 1024 ||
        typeof fields.recipient !== "string" ||
        fields.recipient.length > 2048
    )
        invalid();
    const draft = snapshotLocalDraftRecovery(fields.draft);
    // A possibly dispatched card can never recover an editable or different request.
    if (
        draft.attempted &&
        (JSON.stringify(snapshotLocalDraftPayload(JSON.parse(fields.editorJson), draft.schema)) !==
            JSON.stringify(draft.payload) ||
            fields.recipient !== draft.target.recipient)
    )
        invalid();
    const snapshot = Object.freeze({
        version: 1 as const,
        draft,
        editorJson: fields.editorJson,
        recipient: fields.recipient,
    });
    if (encoder.encode(JSON.stringify(snapshot)).byteLength > LIMIT) invalid();
    return snapshot;
}
function plainFields(
    value: unknown,
    required: readonly string[],
    optional: readonly string[] = [],
): Record<string, unknown> {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
        invalid();
    const fields: Record<string, unknown> = Object.create(null);
    for (const name of Reflect.ownKeys(value)) {
        if (typeof name !== "string" || ![...required, ...optional].includes(name)) invalid();
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
        fields[name] = descriptor.value;
    }
    if (required.some((name) => !Object.hasOwn(fields, name))) invalid();
    return fields;
}
/** Host-owned navigation identity only. Never carries source content or delivery authority. */
export function snapshotLocalAppDraftSourceReference(value: unknown): LocalAppDraftSourceReference {
    const fields = plainFields(value, ["chatKey", "messageId"], ["threadRootMessageIndex"]);
    for (const [name, limit] of [
        ["chatKey", 2048],
        ["messageId", 128],
    ] as const) {
        const text = fields[name];
        if (
            typeof text !== "string" ||
            !text.trim() ||
            text.length > limit ||
            // Navigation identifiers must not contain control characters.
            // eslint-disable-next-line no-control-regex
            /[\u0000-\u001f\u007f-\u009f]/u.test(text)
        )
            invalid();
    }
    const thread = fields.threadRootMessageIndex;
    if (
        Object.hasOwn(fields, "threadRootMessageIndex") &&
        (typeof thread !== "number" || !Number.isSafeInteger(thread) || thread < 0)
    )
        invalid();
    return Object.freeze({
        chatKey: fields.chatKey as string,
        messageId: fields.messageId as string,
        ...(thread === undefined ? {} : { threadRootMessageIndex: thread as number }),
    });
}
function snapshotSavedApp(value: unknown, saved: SavedLocalAppDraft): LocalAppCatalogEntry {
    // Inspect descriptors before serialization: JSON.stringify itself invokes getters/toJSON.
    // The catalog may exceed the draft payload's 64 KiB limit, but never this store's total cap.
    let values = 0;
    const active = new Set<object>();
    const copy = (input: unknown, depth: number): unknown => {
        if (++values > LIMIT || depth > 32) invalid();
        if (input === null || typeof input === "boolean") return input;
        if (typeof input === "number") {
            if (!Number.isFinite(input)) invalid();
            return input;
        }
        if (typeof input === "string") {
            if (encoder.encode(input).byteLength > LIMIT) invalid();
            return input;
        }
        if (!input || typeof input !== "object" || active.has(input)) invalid();
        active.add(input);
        try {
            if (Array.isArray(input)) {
                if (input.length > LIMIT || Reflect.ownKeys(input).length !== input.length + 1)
                    invalid();
                const result: unknown[] = [];
                for (let index = 0; index < input.length; index++) {
                    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
                    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
                        invalid();
                    result.push(copy(descriptor.value, depth + 1));
                }
                return result;
            }
            const fields = plainFields(input, Object.keys(input));
            const result: Record<string, unknown> = Object.create(null);
            for (const [name, field] of Object.entries(fields)) {
                if (["__proto__", "prototype", "constructor"].includes(name)) invalid();
                result[name] = copy(field, depth + 1);
            }
            return result;
        } finally {
            active.delete(input);
        }
    };
    const json = JSON.stringify({ version: 1, apps: [copy(value, 0)] });
    if (encoder.encode(json).byteLength > LIMIT) invalid();
    const app = parseLocalAppCatalog(json).apps[0];
    const target = saved.draft.target;
    const action = app.actions.find((entry) => entry.definition.name === target.actionId);
    if (
        app.id !== target.appId ||
        app.revision !== target.appRevision ||
        app.destination !== target.destination ||
        JSON.stringify(snapshotLocalDraftJson(app.deliveryEncryption ?? null)) !==
            JSON.stringify(snapshotLocalDraftJson(target.deliveryEncryption ?? null)) ||
        !action ||
        JSON.stringify(snapshotLocalDraftJson(action.draftSchema)) !==
            JSON.stringify(snapshotLocalDraftJson(saved.draft.schema))
    )
        invalid();
    return app;
}
export function snapshotSavedLocalAppDraftCollection(value: unknown): SavedLocalAppDraftCollection {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
    const version = Object.getOwnPropertyDescriptor(value, "version");
    if (!version || !("value" in version) || !version.enumerable) invalid();
    if (version.value === 1) {
        return snapshotSavedLocalAppDraftCollection({
            version: 2,
            cards: [{ saved: snapshotSavedLocalAppDraft(value) }],
        });
    }
    const fields = plainFields(value, ["version", "cards"], ["activeDraftId"]);
    if (
        fields.version !== 2 ||
        !Array.isArray(fields.cards) ||
        fields.cards.length > MAX_SAVED_LOCAL_APP_DRAFTS ||
        Reflect.ownKeys(fields.cards).length !== fields.cards.length + 1
    )
        invalid();
    const ids = new Set<string>();
    const importIds = new Set<string>();
    const cards: SavedLocalAppDraftCollection["cards"][number][] = [];
    for (let index = 0; index < fields.cards.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(fields.cards, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
        const entry = plainFields(descriptor.value, ["saved"], ["source", "app"]);
        const saved = snapshotSavedLocalAppDraft(entry.saved);
        if (ids.has(saved.draft.id) || importIds.has(saved.draft.idempotencyKey)) invalid();
        ids.add(saved.draft.id);
        importIds.add(saved.draft.idempotencyKey);
        cards.push(
            Object.freeze({
                saved,
                ...(Object.hasOwn(entry, "source")
                    ? { source: snapshotLocalAppDraftSourceReference(entry.source) }
                    : {}),
                ...(Object.hasOwn(entry, "app") ? { app: snapshotSavedApp(entry.app, saved) } : {}),
            }),
        );
    }
    if (
        Object.hasOwn(fields, "activeDraftId") &&
        (typeof fields.activeDraftId !== "string" || !ids.has(fields.activeDraftId))
    )
        invalid();
    const snapshot = Object.freeze({
        version: 2 as const,
        cards: Object.freeze(cards),
        ...(typeof fields.activeDraftId === "string"
            ? { activeDraftId: fields.activeDraftId }
            : {}),
    });
    if (encoder.encode(JSON.stringify(snapshot)).byteLength > LIMIT) invalid();
    return snapshot;
}
function generation(): string {
    return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
        byte.toString(16).padStart(2, "0"),
    ).join("");
}
function checkRecord(record: EncryptedLocalDraftRecord | undefined): void {
    if (record === undefined) return;
    if (!record || typeof record !== "object") invalid();
    const allowed = record.key
        ? ["version", "generation", "revision", "key", "iv", "ciphertext"]
        : ["version", "generation", "revision"];
    if (
        Object.keys(record).length !== allowed.length ||
        Object.keys(record).some((key) => !allowed.includes(key))
    )
        invalid();
    if (
        (record.version !== 1 && record.version !== 2) ||
        !/^[a-f0-9]{64}$/.test(record.generation) ||
        !/^[a-f0-9]{64}$/.test(record.revision)
    )
        invalid();
    if (!record.key && record.iv === undefined && record.ciphertext === undefined) return;
    const key = record.key;
    if (
        !key ||
        key.type !== "secret" ||
        key.extractable ||
        key.algorithm.name !== "AES-GCM" ||
        (key.algorithm as AesKeyAlgorithm).length !== 256 ||
        key.usages.join(",") !== "encrypt,decrypt" ||
        !(record.iv instanceof Uint8Array) ||
        record.iv.byteLength !== 12 ||
        !(record.ciphertext instanceof ArrayBuffer) ||
        record.ciphertext.byteLength < 16 ||
        record.ciphertext.byteLength > LIMIT + 16
    )
        invalid();
}
function queued<T>(key: string, task: () => Promise<T>): Promise<T> {
    const pending = (queues.get(key) ?? Promise.resolve()).then(task);
    const settled = pending.then(
        () => {},
        () => {},
    );
    queues.set(key, settled);
    void settled.then(() => {
        if (queues.get(key) === settled) queues.delete(key);
    });
    return pending;
}
const aad = (version: 1 | 2, key: string, generation: string, revision: string) =>
    encoder.encode(JSON.stringify(["oc-private-card", version, key, generation, revision]));

/** Device-only encryption. Same-origin code can use this key; it is not chat E2EE or XSS isolation. */
export function createLocalAppDraftStorage(backend: LocalDraftRecordBackend): LocalAppDraftStorage {
    const observed = new Map<string, string>();
    const revisions = new Map<string, string>();
    // Reads replace the observation; own queued writes advance only its CAS revision.
    // A later refresh must not silently rebase an already-captured stale collection.
    const observations = new Map<string, object>();
    return {
        read(scope) {
            const key = scopeKey(scope);
            return queued(key, async () => {
                try {
                    const record = await backend.read(key);
                    checkRecord(record);
                    if (!record?.key) {
                        observed.set(key, record?.generation ?? ZERO);
                        revisions.set(key, record?.revision ?? ZERO);
                        observations.set(key, {});
                        return undefined;
                    }
                    const plaintext = await crypto.subtle.decrypt(
                        {
                            name: "AES-GCM",
                            iv: record.iv!,
                            additionalData: aad(
                                record.version,
                                key,
                                record.generation,
                                record.revision,
                            ),
                        },
                        record.key,
                        record.ciphertext!,
                    );
                    try {
                        const decoded = JSON.parse(decoder.decode(plaintext));
                        if (decoded?.version !== record.version) invalid();
                        const snapshot = snapshotSavedLocalAppDraftCollection(decoded);
                        observed.set(key, record.generation);
                        revisions.set(key, record.revision);
                        observations.set(key, {});
                        return snapshot;
                    } finally {
                        new Uint8Array(plaintext).fill(0);
                    }
                } catch {
                    observed.delete(key);
                    revisions.delete(key);
                    observations.delete(key);
                    throw failure();
                }
            });
        },
        write(scope, value) {
            const key = scopeKey(scope);
            const snapshot = snapshotSavedLocalAppDraftCollection(value);
            const capturedGeneration = observed.get(key);
            const capturedObservation = observations.get(key);
            return queued(key, async () => {
                try {
                    const previous = await backend.read(key);
                    checkRecord(previous);
                    if (
                        (previous !== undefined && capturedObservation === undefined) ||
                        observations.get(key) !== capturedObservation
                    )
                        invalid();
                    const expected = capturedGeneration ?? observed.get(key) ?? ZERO;
                    if ((previous?.generation ?? ZERO) !== expected) invalid();
                    // Ordinary saves also invalidate stale tabs. Otherwise a stale editor could
                    // overwrite attempted=true after another tab has dispatched the request.
                    const revision = revisions.get(key) ?? ZERO;
                    if ((previous?.revision ?? ZERO) !== revision) invalid();
                    const nextRevision = generation();
                    const secret =
                        previous?.key ??
                        (await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
                            "encrypt",
                            "decrypt",
                        ]));
                    const iv = crypto.getRandomValues(new Uint8Array(12));
                    const ciphertext = await crypto.subtle.encrypt(
                        {
                            name: "AES-GCM",
                            iv,
                            additionalData: aad(2, key, expected, nextRevision),
                        },
                        secret,
                        encoder.encode(JSON.stringify(snapshot)),
                    );
                    await backend.replace(key, previous?.revision, {
                        version: 2,
                        generation: expected,
                        revision: nextRevision,
                        key: secret,
                        iv,
                        ciphertext,
                    });
                    observed.set(key, expected);
                    revisions.set(key, nextRevision);
                    if (!capturedObservation) observations.set(key, {});
                } catch {
                    throw failure();
                }
            });
        },
        remove(scope) {
            const key = scopeKey(scope);
            return queued(key, async () => {
                try {
                    const next = generation();
                    // No ciphertext or key survives Forget. Tombstone rejects writes from old tabs.
                    await backend.remove(key, { version: 2, generation: next, revision: next });
                    observed.set(key, next);
                    revisions.set(key, next);
                    observations.set(key, {});
                } catch {
                    throw failure();
                }
            });
        },
    };
}

function database(factory: () => IDBFactory | undefined): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        let request: IDBOpenDBRequest | undefined;
        let settled = false;
        const timer = setTimeout(fail, TIMEOUT_MS);
        function fail() {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try {
                request?.transaction?.abort();
            } catch {
                /* Already closed. */
            }
            reject(failure());
        }
        try {
            const idb = factory();
            if (!idb) return fail();
            request = idb.open(DATABASE, 1);
            request.onerror = fail;
            request.onblocked = fail;
            request.onupgradeneeded = (event) => {
                if (settled || event.oldVersion !== 0) return fail();
                request!.result.createObjectStore(STORE);
            };
            request.onsuccess = () => {
                const db = request!.result;
                if (settled) {
                    db.close();
                    return;
                }
                if (db.objectStoreNames.length !== 1 || !db.objectStoreNames.contains(STORE)) {
                    db.close();
                    fail();
                    return;
                }
                settled = true;
                clearTimeout(timer);
                db.onversionchange = () => db.close();
                resolve(db);
            };
        } catch {
            fail();
        }
    });
}
async function transaction<T>(
    factory: () => IDBFactory | undefined,
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore, result: (value: T) => void, fail: () => void) => void,
): Promise<T> {
    const db = await database(factory);
    return new Promise((resolve, reject) => {
        let tx: IDBTransaction | undefined;
        let settled = false,
            complete = false;
        let result: T;
        const timer = setTimeout(fail, TIMEOUT_MS);
        function fail() {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try {
                tx?.abort();
            } catch {
                /* Already closed. */
            }
            db.close();
            reject(failure());
        }
        try {
            tx = db.transaction(STORE, mode);
            tx.onabort = fail;
            tx.onerror = fail;
            tx.oncomplete = () => {
                if (settled) return;
                if (!complete) return fail();
                settled = true;
                clearTimeout(timer);
                db.close();
                resolve(result);
            };
            const store = tx.objectStore(STORE);
            if (store.keyPath !== null || store.autoIncrement || store.indexNames.length)
                return fail();
            operation(
                store,
                (value) => {
                    complete = true;
                    result = value;
                },
                fail,
            );
        } catch {
            fail();
        }
    });
}
export function createBrowserLocalAppDraftStorage(
    options: { indexedDB?: () => IDBFactory | undefined } = {},
): LocalAppDraftStorage {
    const factory = options.indexedDB ?? (() => globalThis.indexedDB);
    return createLocalAppDraftStorage({
        read: (key) =>
            transaction(factory, "readonly", (store, done, fail) => {
                const request = store.get(key);
                request.onerror = fail;
                request.onsuccess = () => done(request.result);
            }),
        replace: (key, expected, value) =>
            transaction(factory, "readwrite", (store, done, fail) => {
                const read = store.get(key);
                read.onerror = fail;
                read.onsuccess = () => {
                    if (read.result?.revision !== expected) return fail();
                    const write = store.put(value, key);
                    write.onerror = fail;
                    write.onsuccess = () => done(undefined);
                };
            }),
        remove: (key, value) =>
            transaction(factory, "readwrite", (store, done, fail) => {
                const request = store.put(value, key);
                request.onerror = fail;
                request.onsuccess = () => done(undefined);
            }),
    });
}
