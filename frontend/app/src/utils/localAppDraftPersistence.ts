import {
    snapshotLocalDraftRecovery,
    snapshotLocalDraftPayload,
    type LocalDraftSnapshot,
} from "./localAppDrafts";
import type { LocalAppSetupScope } from "./localAppSetupStore";

export interface SavedLocalAppDraft {
    readonly version: 1;
    readonly draft: LocalDraftSnapshot;
    readonly editorJson: string;
    readonly recipient: string;
}
export interface LocalAppDraftStorage {
    read(scope: LocalAppSetupScope): Promise<SavedLocalAppDraft | undefined>;
    write(scope: LocalAppSetupScope, value: SavedLocalAppDraft): Promise<void>;
    remove(scope: LocalAppSetupScope): Promise<void>;
}
export interface EncryptedLocalDraftRecord {
    readonly version: 1;
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
        record.version !== 1 ||
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
const aad = (key: string, generation: string, revision: string) =>
    encoder.encode(JSON.stringify(["oc-private-card", 1, key, generation, revision]));

/** Device-only encryption. Same-origin code can use this key; it is not chat E2EE or XSS isolation. */
export function createLocalAppDraftStorage(backend: LocalDraftRecordBackend): LocalAppDraftStorage {
    const observed = new Map<string, string>();
    const revisions = new Map<string, string>();
    return {
        read(scope) {
            const key = scopeKey(scope);
            return queued(key, async () => {
                try {
                    const record = await backend.read(key);
                    checkRecord(record);
                    observed.set(key, record?.generation ?? ZERO);
                    revisions.set(key, record?.revision ?? ZERO);
                    if (!record?.key) return undefined;
                    const plaintext = await crypto.subtle.decrypt(
                        {
                            name: "AES-GCM",
                            iv: record.iv!,
                            additionalData: aad(key, record.generation, record.revision),
                        },
                        record.key,
                        record.ciphertext!,
                    );
                    try {
                        return snapshotSavedLocalAppDraft(JSON.parse(decoder.decode(plaintext)));
                    } finally {
                        new Uint8Array(plaintext).fill(0);
                    }
                } catch {
                    throw failure();
                }
            });
        },
        write(scope, value) {
            const key = scopeKey(scope);
            const snapshot = snapshotSavedLocalAppDraft(value);
            const capturedGeneration = observed.get(key);
            return queued(key, async () => {
                try {
                    const previous = await backend.read(key);
                    checkRecord(previous);
                    const expected =
                        capturedGeneration ?? observed.get(key) ?? previous?.generation ?? ZERO;
                    if ((previous?.generation ?? ZERO) !== expected) invalid();
                    // Ordinary saves also invalidate stale tabs. Otherwise a stale editor could
                    // overwrite attempted=true after another tab has dispatched the request.
                    const revision = revisions.get(key) ?? previous?.revision ?? ZERO;
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
                        { name: "AES-GCM", iv, additionalData: aad(key, expected, nextRevision) },
                        secret,
                        encoder.encode(JSON.stringify(snapshot)),
                    );
                    await backend.replace(key, previous?.revision, {
                        version: 1,
                        generation: expected,
                        revision: nextRevision,
                        key: secret,
                        iv,
                        ciphertext,
                    });
                    observed.set(key, expected);
                    revisions.set(key, nextRevision);
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
                    await backend.remove(key, { version: 1, generation: next, revision: next });
                    observed.set(key, next);
                    revisions.set(key, next);
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
