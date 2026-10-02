import {
    type DBSchema,
    type IDBPDatabase,
    type IDBPTransaction,
    type IndexNames,
    openDB,
    type StoreNames,
} from "idb";

export type IndexedDbStore<Schema extends DBSchema> = {
    name: StoreNames<Schema>;
    indexes?: Record<IndexNames<Schema, StoreNames<Schema>>, string>;
};

export const INDEXED_DB_OPEN_TIMEOUT_MS = 15_000;

export class IndexedDbCacheUnavailableError extends Error {
    readonly code = "indexed_db_cache_unavailable";

    constructor() {
        super("Local cache is unavailable.");
        this.name = "IndexedDbCacheUnavailableError";
    }
}

export class IndexedDbConnectionManager<Schema extends DBSchema> {
    private readonly migrations: Map<
        number,
        (
            db: IDBPDatabase<Schema>,
            tx: IDBPTransaction<Schema, StoreNames<Schema>[], "versionchange">,
        ) => Promise<void>
    > = new Map();

    private earliestSupportedVersion: number | undefined = undefined;
    private openDbPromise: Promise<IDBPDatabase<Schema>> | undefined = undefined;

    private constructor(
        private readonly name: string,
        private readonly stores: IndexedDbStore<Schema>[],
        private readonly currentVersion: number,
    ) {}

    public static create<Schema extends DBSchema>(
        name: string,
        stores: IndexedDbStore<Schema>[],
        currentVersion: number,
    ): IndexedDbConnectionManager<Schema> {
        return new IndexedDbConnectionManager<Schema>(name, stores, currentVersion);
    }

    public withMigration(
        fromVersion: number,
        action: (
            db: IDBPDatabase<Schema>,
            tx: IDBPTransaction<Schema, StoreNames<Schema>[], "versionchange">,
        ) => Promise<void>,
    ): IndexedDbConnectionManager<Schema> {
        this.migrations.set(fromVersion, action);

        if (
            this.earliestSupportedVersion === undefined ||
            this.earliestSupportedVersion > fromVersion
        ) {
            this.earliestSupportedVersion = fromVersion;
        }
        return this;
    }

    public getDb(): Promise<IDBPDatabase<Schema>> {
        if (this.openDbPromise === undefined) {
            return this.startOpenAttempt();
        }
        return this.openDbPromise;
    }

    private startOpenAttempt(): Promise<IDBPDatabase<Schema>> {
        let resolveOpen!: (db: IDBPDatabase<Schema>) => void;
        let rejectOpen!: (error: unknown) => void;
        const promise = new Promise<IDBPDatabase<Schema>>((resolve, reject) => {
            resolveOpen = resolve;
            rejectOpen = reject;
        });
        this.openDbPromise = promise;

        let finished = false;
        let unavailable = false;
        let openedDb: IDBPDatabase<Schema> | undefined;
        const clearIfCurrent = () => {
            if (this.openDbPromise === promise) {
                this.openDbPromise = undefined;
            }
        };
        function failUnavailable() {
            if (finished) return;
            finished = true;
            unavailable = true;
            clearTimeout(timeoutId);
            // Keep the rejected promise installed until the underlying open settles. IndexedDB
            // open requests cannot be cancelled, so immediately retrying would only queue more
            // requests behind the same blocked operation.
            rejectOpen(new IndexedDbCacheUnavailableError());
        }
        const closeForVersionChange = () => {
            openedDb?.close();
            clearIfCurrent();
        };
        const timeoutId = setTimeout(failUnavailable, INDEXED_DB_OPEN_TIMEOUT_MS);

        let rawOpen: Promise<IDBPDatabase<Schema>>;
        try {
            rawOpen = this._openDB(failUnavailable, closeForVersionChange, clearIfCurrent);
        } catch (error) {
            finished = true;
            clearTimeout(timeoutId);
            clearIfCurrent();
            rejectOpen(error);
            return promise;
        }

        rawOpen.then(
            (db) => {
                openedDb = db;
                if (unavailable) {
                    // A timed-out or blocked request may still succeed later. Never install that
                    // stale handle as the active connection.
                    db.close();
                    clearIfCurrent();
                    return;
                }
                if (finished) {
                    db.close();
                    return;
                }
                finished = true;
                clearTimeout(timeoutId);
                db.addEventListener("close", clearIfCurrent);
                resolveOpen(db);
            },
            (error) => {
                clearTimeout(timeoutId);
                if (unavailable) {
                    clearIfCurrent();
                    return;
                }
                if (finished) return;
                finished = true;
                clearIfCurrent();
                rejectOpen(error);
            },
        );
        return promise;
    }

    private _openDB(
        blocked: () => void,
        blocking: () => void,
        terminated: () => void,
    ): Promise<IDBPDatabase<Schema>> {
        const earliestSupportedVersion = this.earliestSupportedVersion;
        const currentVersion = this.currentVersion;
        const nuke = this.nukeDb.bind(this);
        const migrate = this.migrate.bind(this);

        return openDB<Schema>(this.name, this.currentVersion, {
            blocked,
            blocking,
            terminated,
            upgrade(db, previousVersion, _, tx) {
                if (
                    previousVersion == null ||
                    earliestSupportedVersion == null ||
                    previousVersion < earliestSupportedVersion
                ) {
                    nuke(db);
                } else {
                    console.debug(
                        `DB: migrating database from ${previousVersion} to ${currentVersion}`,
                    );
                    migrate(previousVersion, db, tx).then(() => {
                        console.debug(
                            `DB: migration from ${previousVersion} to ${currentVersion} complete`,
                        );
                    });
                }
            },
        });
    }

    private nukeDb(db: IDBPDatabase<Schema>) {
        for (const existing of db.objectStoreNames) {
            db.deleteObjectStore(existing);
        }

        for (const store of this.stores) {
            const storeInstance = db.createObjectStore(store.name);

            if (store.indexes !== undefined) {
                for (const [name, key] of Object.entries(store.indexes) as [
                    IndexNames<Schema, StoreNames<Schema>>,
                    string,
                ][]) {
                    storeInstance.createIndex(name, key);
                }
            }
        }
    }

    private async migrate(
        fromVersion: number,
        db: IDBPDatabase<Schema>,
        tx: IDBPTransaction<Schema, StoreNames<Schema>[], "versionchange">,
    ): Promise<void> {
        for (let version = fromVersion; version < this.currentVersion; version++) {
            const migration = this.migrations.get(version);
            if (migration) {
                await migration(db, tx);
            } else {
                console.error("Migration missing from version " + version);
            }
        }
    }
}
