import { parseLocalAppCatalog, type LocalAppCatalog } from "./localAppCatalog";
import { verifyImportedLocalProcessor, type ImportedLocalProcessor } from "./isolatedAppProcessor";
import { validateLocalAppInstallation, type LocalAppInstallation } from "./localAppDirectory";
import {
    validateLocalAppChatRoutes,
    type LocalAppAccountConnection,
    type LocalAppChatSetup,
} from "./localAppChatRoutes";

export type LocalAppSetupScope = Readonly<{ account: string; backend: string }>;
export type LocalAppEnabledChats = readonly Readonly<{
    chatKey: string;
    appIds: readonly string[];
}>[];
export type LocalAppSetupSnapshot = Readonly<{
    catalog: LocalAppCatalog;
    appId?: string;
    actionId?: string;
    processor?: ImportedLocalProcessor;
    processors?: readonly Readonly<{ appId: string; artifact: ImportedLocalProcessor }>[];
    installations?: readonly LocalAppInstallation[];
    disabledAppIds?: readonly string[];
    connections?: readonly LocalAppAccountConnection[];
    chatSetups?: readonly LocalAppChatSetup[];
    enabledChats: LocalAppEnabledChats;
}>;
export interface LocalAppSetupStorage {
    read(scope: LocalAppSetupScope): Promise<LocalAppSetupSnapshot | undefined>;
    write(scope: LocalAppSetupScope, snapshot: LocalAppSetupSnapshot): Promise<void>;
    remove(scope: LocalAppSetupScope): Promise<void>;
}

const DATABASE = "openchat-private-app-setup";
const STORE = "account-setup";
const VERSION = 1;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
// eslint-disable-next-line no-control-regex -- Scope/chat IDs must not contain invisible control characters.
const HIDDEN = /[\p{Cf}\u0000-\u001F\u007F-\u009F]/u;
const HASH = /^[a-f0-9]{64}$/;
const INITIAL_GENERATION = "0".repeat(64);
// Shared across adapter instances in this page. An older queued write cannot overtake removal.
const queues = new Map<string, Promise<void>>();
type LegacyStoredSetup = Readonly<{
    version: 1;
    scope: LocalAppSetupScope;
    generation: string;
    snapshotJson?: string;
}>;
type EncryptedStoredSetup = Readonly<{
    version: 2;
    scope: LocalAppSetupScope;
    generation: string;
    sealed?: Readonly<{
        key: CryptoKey;
        iv: Uint8Array<ArrayBuffer>;
        ciphertext: Uint8Array<ArrayBuffer>;
    }>;
}>;
type StoredSetup = LegacyStoredSetup | EncryptedStoredSetup;

function invalid(): never {
    throw new Error("Invalid stored private app setup");
}
function storageError(): Error {
    return new Error("Private app setup could not be saved, loaded or removed on this device");
}
function exact(
    value: unknown,
    required: readonly string[],
    optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const keys = Reflect.ownKeys(value);
    if (
        required.some((key) => !Object.hasOwn(value, key)) ||
        keys.some((key) => {
            const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
            return (
                typeof key !== "string" ||
                (!required.includes(key) && !optional.includes(key)) ||
                !("value" in descriptor) ||
                !descriptor.enumerable
            );
        })
    )
        invalid();
}
function identifier(value: unknown, max: number): asserts value is string {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > max ||
        value.trim() !== value ||
        HIDDEN.test(value)
    )
        invalid();
}
function scopeSnapshot(value: unknown): LocalAppSetupScope {
    exact(value, ["account", "backend"]);
    identifier(value.account, 512);
    identifier(value.backend, 2048);
    return Object.freeze({ account: value.account, backend: value.backend });
}

// Snapshot caller-owned data before any await, without invoking getters or toJSON. Catalog limits
// are enforced again by the shared parser; this larger outer bound also permits processor source.
function cloneJson(value: unknown, depth = 0, budget = { nodes: 0, bytes: 0 }): unknown {
    if (depth > 32 || ++budget.nodes > 262_144) invalid();
    if (typeof value === "string") {
        budget.bytes += new TextEncoder().encode(value).byteLength;
        if (budget.bytes > MAX_RECORD_BYTES) invalid();
        return value;
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : invalid();
    if (Array.isArray(value)) {
        if (value.length > 4096 || Reflect.ownKeys(value).length !== value.length + 1) invalid();
        return Object.freeze(
            Array.from({ length: value.length }, (_, index) => {
                const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
                if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
                return cloneJson(descriptor.value, depth + 1, budget);
            }),
        );
    }
    if (value === null || typeof value !== "object") invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key))
            invalid();
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!("value" in descriptor) || !descriptor.enumerable) invalid();
        budget.bytes += new TextEncoder().encode(key).byteLength;
        if (budget.bytes > MAX_RECORD_BYTES) invalid();
        result[key] = cloneJson(descriptor.value, depth + 1, budget);
    }
    return Object.freeze(result);
}

export function validateLocalAppEnabledChats(
    value: unknown,
    catalog: LocalAppCatalog,
): LocalAppEnabledChats {
    if (!Array.isArray(value) || value.length > 256) invalid();
    const rows = cloneJson(value) as unknown[];
    const chats = new Set<string>();
    const knownApps = new Set(catalog.apps.map((app) => app.id));
    return Object.freeze(
        rows.map((row) => {
            exact(row, ["chatKey", "appIds"]);
            identifier(row.chatKey, 512);
            if (
                chats.has(row.chatKey) ||
                !Array.isArray(row.appIds) ||
                row.appIds.length === 0 ||
                row.appIds.length > 16 ||
                new Set(row.appIds).size !== row.appIds.length ||
                row.appIds.some((id) => typeof id !== "string" || !knownApps.has(id))
            )
                invalid();
            chats.add(row.chatKey);
            return Object.freeze({
                chatKey: row.chatKey,
                appIds: Object.freeze([...row.appIds]) as readonly string[],
            });
        }),
    );
}

function captureSnapshot(value: unknown): LocalAppSetupSnapshot {
    exact(
        value,
        ["catalog", "enabledChats"],
        [
            "appId",
            "actionId",
            "processor",
            "processors",
            "installations",
            "disabledAppIds",
            "connections",
            "chatSetups",
        ],
    );
    const catalog = parseLocalAppCatalog(JSON.stringify(cloneJson(value.catalog)));
    const appId = value.appId;
    const actionId = value.actionId;
    if (appId !== undefined) identifier(appId, 128);
    if (actionId !== undefined) identifier(actionId, 128);
    const app = catalog.apps.find((entry) => entry.id === appId);
    if (appId !== undefined && !app) invalid();
    if (actionId !== undefined && !app?.actions.some((a) => a.definition.name === actionId))
        invalid();
    let processor: ImportedLocalProcessor | undefined;
    if (value.processor !== undefined) {
        exact(value.processor, ["source", "sha256", "byteLength"]);
        const artifact = value.processor;
        if (
            !actionId ||
            !app?.processor ||
            typeof artifact.source !== "string" ||
            artifact.sha256 !== app.processor.sha256 ||
            artifact.byteLength !== app.processor.byteLength ||
            new TextEncoder().encode(artifact.source).byteLength !== artifact.byteLength
        )
            invalid();
        processor = Object.freeze({
            source: artifact.source,
            sha256: app.processor.sha256,
            byteLength: app.processor.byteLength,
        });
    }
    let processors: LocalAppSetupSnapshot["processors"];
    if (value.processors !== undefined) {
        if (!Array.isArray(value.processors) || value.processors.length > 16) invalid();
        const seen = new Set<string>();
        processors = Object.freeze(
            value.processors.map((row: unknown) => {
                exact(row, ["appId", "artifact"]);
                identifier(row.appId, 128);
                const owner = catalog.apps.find((entry) => entry.id === row.appId);
                exact(row.artifact, ["source", "sha256", "byteLength"]);
                const artifact = row.artifact;
                if (
                    seen.has(row.appId) ||
                    !owner?.processor ||
                    typeof artifact.source !== "string" ||
                    artifact.sha256 !== owner.processor.sha256 ||
                    artifact.byteLength !== owner.processor.byteLength ||
                    new TextEncoder().encode(artifact.source).byteLength !== artifact.byteLength
                )
                    invalid();
                seen.add(row.appId);
                return Object.freeze({
                    appId: row.appId,
                    artifact: Object.freeze({ source: artifact.source, ...owner.processor }),
                });
            }),
        );
        if (
            processor &&
            processors.some(
                (row) => row.appId === appId && row.artifact.source !== processor!.source,
            )
        )
            invalid();
    }
    let installations: LocalAppSetupSnapshot["installations"];
    if (value.installations !== undefined) {
        if (!Array.isArray(value.installations) || value.installations.length > 16) invalid();
        const seen = new Set<string>();
        installations = Object.freeze(
            value.installations.map((entry: unknown) => {
                exact(entry, ["appId", "sourceUrl", "descriptor", "publicCatalogJson"]);
                identifier(entry.appId, 128);
                if (seen.has(entry.appId) || !catalog.apps.some((app) => app.id === entry.appId))
                    invalid();
                seen.add(entry.appId);
                return cloneJson(entry) as LocalAppInstallation;
            }),
        );
    }
    let disabledAppIds: readonly string[] | undefined;
    if (value.disabledAppIds !== undefined) {
        if (
            !Array.isArray(value.disabledAppIds) ||
            value.disabledAppIds.length > 16 ||
            new Set(value.disabledAppIds).size !== value.disabledAppIds.length ||
            value.disabledAppIds.some(
                (id) => typeof id !== "string" || !catalog.apps.some((app) => app.id === id),
            )
        )
            invalid();
        disabledAppIds = Object.freeze([...value.disabledAppIds]) as readonly string[];
    }
    const enabledChats = validateLocalAppEnabledChats(value.enabledChats, catalog);
    if (enabledChats.some((row) => row.appIds.some((id) => disabledAppIds?.includes(id))))
        invalid();
    const routes = validateLocalAppChatRoutes(
        catalog,
        installations ?? [],
        value.connections,
        value.chatSetups,
    );
    return Object.freeze({
        catalog,
        ...(appId === undefined ? {} : { appId }),
        ...(actionId === undefined ? {} : { actionId }),
        ...(processor === undefined ? {} : { processor }),
        ...(processors === undefined ? {} : { processors }),
        ...(installations === undefined ? {} : { installations }),
        ...(disabledAppIds === undefined ? {} : { disabledAppIds }),
        ...(value.connections === undefined ? {} : { connections: routes.connections }),
        ...(value.chatSetups === undefined ? {} : { chatSetups: routes.chatSetups }),
        enabledChats,
    });
}

/** Strict setup-only copy; importing/rehydrating processor bytes never executes them. */
export async function validateLocalAppSetupSnapshot(
    value: unknown,
): Promise<LocalAppSetupSnapshot> {
    const snapshot = captureSnapshot(value);
    if (snapshot.processor && !(await verifyImportedLocalProcessor(snapshot.processor))) invalid();
    for (const row of snapshot.processors ?? []) {
        // The legacy selected artifact may also appear in the per-app map. Capture checked
        // equality above, so verify these exact bytes once rather than hashing them twice.
        if (row.appId === snapshot.appId && snapshot.processor) continue;
        if (!(await verifyImportedLocalProcessor(row.artifact))) invalid();
    }
    if (snapshot.installations) {
        const installations = await Promise.all(
            snapshot.installations.map((entry) =>
                validateLocalAppInstallation(
                    entry,
                    snapshot.catalog.apps.find((app) => app.id === entry.appId)!,
                ),
            ),
        );
        return Object.freeze({ ...snapshot, installations: Object.freeze(installations) });
    }
    return snapshot;
}
async function sha256(text: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
    );
}

/** The digest binds chat opt-ins to exact stored catalog bytes, not just a reusable app ID. */
export async function encodeLocalAppSetup(
    scope: LocalAppSetupScope,
    value: LocalAppSetupSnapshot,
): Promise<string> {
    const owner = scopeSnapshot(scope);
    const snapshot = await validateLocalAppSetupSnapshot(value);
    const catalogJson = JSON.stringify(snapshot.catalog);
    const catalogSha256 = await sha256(catalogJson);
    const serialized = JSON.stringify({
        version: VERSION,
        scope: owner,
        catalogJson,
        catalogSha256,
        ...(snapshot.appId === undefined ? {} : { appId: snapshot.appId }),
        ...(snapshot.actionId === undefined ? {} : { actionId: snapshot.actionId }),
        ...(snapshot.processor === undefined ? {} : { processor: snapshot.processor }),
        ...(snapshot.processors === undefined ? {} : { processors: snapshot.processors }),
        ...(snapshot.installations === undefined ? {} : { installations: snapshot.installations }),
        ...(snapshot.disabledAppIds === undefined
            ? {}
            : { disabledAppIds: snapshot.disabledAppIds }),
        ...(snapshot.connections === undefined ? {} : { connections: snapshot.connections }),
        ...(snapshot.chatSetups === undefined ? {} : { chatSetups: snapshot.chatSetups }),
        enabledChats: { catalogSha256, entries: snapshot.enabledChats },
    });
    if (new TextEncoder().encode(serialized).byteLength > MAX_RECORD_BYTES) invalid();
    return serialized;
}

export async function decodeLocalAppSetup(
    scope: LocalAppSetupScope,
    serialized: unknown,
): Promise<LocalAppSetupSnapshot> {
    const owner = scopeSnapshot(scope);
    if (
        typeof serialized !== "string" ||
        new TextEncoder().encode(serialized).byteLength > MAX_RECORD_BYTES
    )
        invalid();
    let data: unknown;
    try {
        data = JSON.parse(serialized);
    } catch {
        return invalid();
    }
    // Only this version's exact serializer is accepted. This also rejects duplicate JSON keys.
    if (JSON.stringify(data) !== serialized) invalid();
    exact(
        data,
        ["version", "scope", "catalogJson", "catalogSha256", "enabledChats"],
        [
            "appId",
            "actionId",
            "processor",
            "processors",
            "installations",
            "disabledAppIds",
            "connections",
            "chatSetups",
        ],
    );
    const storedOwner = scopeSnapshot(data.scope);
    if (
        data.version !== VERSION ||
        storedOwner.account !== owner.account ||
        storedOwner.backend !== owner.backend ||
        typeof data.catalogJson !== "string" ||
        typeof data.catalogSha256 !== "string" ||
        !HASH.test(data.catalogSha256)
    )
        invalid();
    exact(data.enabledChats, ["catalogSha256", "entries"]);
    if (
        data.enabledChats.catalogSha256 !== data.catalogSha256 ||
        (await sha256(data.catalogJson)) !== data.catalogSha256
    )
        invalid();
    const catalog = parseLocalAppCatalog(data.catalogJson);
    if (JSON.stringify(catalog) !== data.catalogJson) invalid();
    return validateLocalAppSetupSnapshot({
        catalog,
        appId: data.appId,
        actionId: data.actionId,
        processor: data.processor,
        processors: data.processors,
        installations: data.installations,
        disabledAppIds: data.disabledAppIds,
        connections: data.connections,
        chatSetups: data.chatSetups,
        enabledChats: data.enabledChats.entries,
    });
}

function queued<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const pending = (queues.get(key) ?? Promise.resolve()).then(operation);
    const tail = pending.then(
        () => {},
        () => {},
    );
    queues.set(key, tail);
    void tail.then(() => {
        if (queues.get(key) === tail) queues.delete(key);
    });
    return pending;
}

function storedSetup(scope: LocalAppSetupScope, value: unknown): StoredSetup | undefined {
    if (value === undefined) return undefined;
    exact(value, ["version", "scope", "generation"], ["snapshotJson", "sealed"]);
    const owner = scopeSnapshot(value.scope);
    if (
        (value.version !== 1 && value.version !== 2) ||
        owner.account !== scope.account ||
        owner.backend !== scope.backend ||
        typeof value.generation !== "string" ||
        !HASH.test(value.generation)
    )
        invalid();
    if (value.version === 1) {
        if (
            Object.hasOwn(value, "sealed") ||
            (Object.hasOwn(value, "snapshotJson") &&
                (typeof value.snapshotJson !== "string" ||
                    new TextEncoder().encode(value.snapshotJson).byteLength > MAX_RECORD_BYTES))
        )
            invalid();
        return Object.freeze({
            version: 1,
            scope: owner,
            generation: value.generation,
            ...(typeof value.snapshotJson === "string" ? { snapshotJson: value.snapshotJson } : {}),
        });
    }
    if (Object.hasOwn(value, "snapshotJson")) invalid();
    if (!Object.hasOwn(value, "sealed")) {
        return Object.freeze({ version: 2, scope: owner, generation: value.generation });
    }
    exact(value.sealed, ["key", "iv", "ciphertext"]);
    const key = value.sealed.key as CryptoKey;
    if (
        !key ||
        key.type !== "secret" ||
        key.extractable ||
        key.algorithm?.name !== "AES-GCM" ||
        (key.algorithm as AesKeyAlgorithm).length !== 256 ||
        key.usages?.length !== 2 ||
        !key.usages.includes("encrypt") ||
        !key.usages.includes("decrypt") ||
        !setupBytes(value.sealed.iv) ||
        value.sealed.iv.byteLength !== 12 ||
        !setupBytes(value.sealed.ciphertext) ||
        value.sealed.ciphertext.byteLength < 17 ||
        value.sealed.ciphertext.byteLength > MAX_RECORD_BYTES + 16
    )
        invalid();
    return Object.freeze({
        version: 2,
        scope: owner,
        generation: value.generation,
        sealed: Object.freeze({
            key,
            iv: new Uint8Array(value.sealed.iv),
            ciphertext: new Uint8Array(value.sealed.ciphertext),
        }),
    });
}

function setupBytes(value: unknown): value is Uint8Array {
    // Structured-cloned IndexedDB values can originate in another JS realm.
    return (
        ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === "[object Uint8Array]"
    );
}

function setupAdditionalData(
    scope: LocalAppSetupScope,
    generation: string,
): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(
        JSON.stringify([
            "openchat/private-app/setup-storage/v2",
            scope.backend,
            scope.account,
            generation,
        ]),
    );
}

async function sealSetup(
    scope: LocalAppSetupScope,
    generation: string,
    serialized: string,
): Promise<EncryptedStoredSetup> {
    const plaintext = new TextEncoder().encode(serialized);
    try {
        // A fresh nonextractable key/IV per committed snapshot avoids nonce reuse and also
        // lets Forget erase all key material atomically with its generation tombstone.
        const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
            "encrypt",
            "decrypt",
        ]);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = new Uint8Array(
            await crypto.subtle.encrypt(
                {
                    name: "AES-GCM",
                    iv,
                    additionalData: setupAdditionalData(scope, generation),
                    tagLength: 128,
                },
                key,
                plaintext,
            ),
        );
        return { version: 2, scope, generation, sealed: { key, iv, ciphertext } };
    } catch {
        throw storageError();
    } finally {
        plaintext.fill(0);
    }
}

async function openSetup(saved: StoredSetup): Promise<string | undefined> {
    if (saved.version === 1) return saved.snapshotJson;
    if (!saved.sealed) return undefined;
    let plaintext: Uint8Array | undefined;
    try {
        plaintext = new Uint8Array(
            await crypto.subtle.decrypt(
                {
                    name: "AES-GCM",
                    iv: saved.sealed.iv,
                    additionalData: setupAdditionalData(saved.scope, saved.generation),
                    tagLength: 128,
                },
                saved.sealed.key,
                saved.sealed.ciphertext,
            ),
        );
        if (plaintext.byteLength > MAX_RECORD_BYTES) invalid();
        return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    } catch {
        throw storageError();
    } finally {
        plaintext?.fill(0);
    }
}

function newGeneration(): string {
    const generation = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
        byte.toString(16).padStart(2, "0"),
    ).join("");
    if (generation === INITIAL_GENERATION) throw storageError();
    return generation;
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(fail, TIMEOUT_MS);
        function fail() {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(storageError());
        }
        let request: IDBOpenDBRequest;
        try {
            request = factory.open(DATABASE, VERSION);
        } catch {
            fail();
            return;
        }
        request.onerror = fail;
        request.onblocked = fail;
        request.onupgradeneeded = (event) => {
            try {
                if (settled || event.oldVersion !== 0) {
                    request.transaction?.abort();
                    fail();
                    return;
                }
                request.result.createObjectStore(STORE);
            } catch {
                request.transaction?.abort();
                fail();
            }
        };
        request.onsuccess = () => {
            const database = request.result;
            if (settled) {
                database.close();
                return;
            }
            if (
                database.objectStoreNames.length !== 1 ||
                !database.objectStoreNames.contains(STORE)
            ) {
                database.close();
                fail();
                return;
            }
            settled = true;
            clearTimeout(timer);
            database.onversionchange = () => database.close();
            resolve(database);
        };
    });
}

async function transaction(
    factory: IDBFactory,
    mode: IDBTransactionMode,
    run: (
        store: IDBObjectStore,
        request: (request: IDBRequest, next?: (result: unknown) => void) => void,
    ) => void,
): Promise<unknown> {
    const database = await openDatabase(factory);
    return new Promise((resolve, reject) => {
        let settled = false;
        let tx: IDBTransaction | undefined;
        let result: unknown;
        let requestSucceeded = false;
        const timer = setTimeout(fail, TIMEOUT_MS);
        function fail() {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try {
                tx?.abort();
            } catch {
                // The transaction may already be complete/aborted.
            }
            database.close();
            reject(storageError());
        }
        try {
            tx = database.transaction(STORE, mode);
            tx.onabort = fail;
            tx.onerror = fail;
            tx.oncomplete = () => {
                if (settled) return;
                if (!requestSucceeded) {
                    fail();
                    return;
                }
                settled = true;
                clearTimeout(timer);
                database.close();
                resolve(result);
            };
            const store = tx.objectStore(STORE);
            if (store.keyPath !== null || store.autoIncrement || store.indexNames.length !== 0) {
                fail();
                return;
            }
            run(store, (request, next) => {
                request.onerror = fail;
                request.onsuccess = () => {
                    try {
                        if (next) next(request.result);
                        else {
                            result = request.result;
                            requestSucceeded = true;
                        }
                    } catch {
                        fail();
                    }
                };
            });
        } catch {
            fail();
        }
    });
}

/** Separate device-local DB; no access at module import/construction, no fallback or remote sync. */
export function createBrowserLocalAppSetupStorage(
    options: { indexedDB?: () => IDBFactory | undefined } = {},
): LocalAppSetupStorage {
    // A stale tab keeps its previously observed generation. It cannot silently adopt a newer
    // Forget tombstone merely because its next write happens later; a fresh read is required.
    const observed = new Map<string, string | null>();
    function factory(): IDBFactory {
        try {
            const value = options.indexedDB ? options.indexedDB() : globalThis.indexedDB;
            if (!value) throw storageError();
            return value;
        } catch {
            throw storageError();
        }
    }
    const keyOf = (scope: LocalAppSetupScope) => JSON.stringify([scope.backend, scope.account]);
    return {
        async read(scope) {
            const owner = scopeSnapshot(scope);
            const key = keyOf(owner);
            return queued(key, async () => {
                const raw = await transaction(factory(), "readonly", (store, request) =>
                    request(store.get(key)),
                );
                const saved = storedSetup(owner, raw);
                observed.set(key, saved?.generation ?? null);
                const serialized = saved ? await openSetup(saved) : undefined;
                if (serialized === undefined) return undefined;
                const snapshot = await decodeLocalAppSetup(owner, serialized);
                // Another tab can Forget while WebCrypto or catalog verification is pending.
                // Never restore the decrypted pre-Forget capability into a live connection.
                const latest = await transaction(factory(), "readonly", (store, request) =>
                    request(store.get(key)),
                );
                if (storedSetup(owner, latest)?.generation !== saved?.generation)
                    throw storageError();
                return snapshot;
            });
        },
        async write(scope, value) {
            const owner = scopeSnapshot(scope);
            const snapshot = captureSnapshot(value);
            const key = keyOf(owner);
            // Capture this before queueing/hashing, not after a pending removal has finished.
            const known = observed.has(key);
            const capturedGeneration = observed.get(key);
            return queued(key, async () => {
                let expected = capturedGeneration ?? null;
                if (!known) {
                    const baseline = await transaction(factory(), "readonly", (store, request) =>
                        request(store.get(key)),
                    );
                    expected = storedSetup(owner, baseline)?.generation ?? null;
                    observed.set(key, expected);
                }
                const serialized = await encodeLocalAppSetup(owner, snapshot);
                // An absent record and the first live record share the initial generation.
                // Ordinary queued saves do not revoke each other; only Forget rotates it.
                const generation = expected ?? INITIAL_GENERATION;
                const saved = await sealSetup(owner, generation, serialized);
                // The comparison and put are in ONE readwrite transaction. A concurrent Forget
                // rotates the generation, so pre-Forget code/hash work cannot resurrect setup.
                await transaction(factory(), "readwrite", (store, request) => {
                    request(store.get(key), (current) => {
                        if (
                            (storedSetup(owner, current)?.generation ?? INITIAL_GENERATION) !==
                            generation
                        )
                            throw storageError();
                        request(store.put(saved, key));
                    });
                });
                observed.set(key, generation);
            });
        },
        async remove(scope) {
            const owner = scopeSnapshot(scope);
            const key = keyOf(owner);
            return queued(key, async () => {
                const generation = newGeneration();
                // Keep only account/backend identity and a random invalidation token. Physically
                // deleting the key would let an old tab mistake absence for its original state.
                const tombstone: StoredSetup = { version: 2, scope: owner, generation };
                await transaction(factory(), "readwrite", (store, request) =>
                    request(store.put(tombstone, key)),
                );
                observed.set(key, generation);
            });
        },
    };
}

export default createBrowserLocalAppSetupStorage;
