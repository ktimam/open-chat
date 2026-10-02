import type { DBSchema, IDBPDatabase, OpenDBCallbacks } from "idb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    INDEXED_DB_OPEN_TIMEOUT_MS,
    IndexedDbCacheUnavailableError,
    IndexedDbConnectionManager,
} from "./indexedDb";

interface TestSchema extends DBSchema {
    values: {
        key: string;
        value: string;
    };
}

const driver = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock("idb", async (importOriginal) => ({
    ...(await importOriginal<typeof import("idb")>()),
    openDB: driver.open,
}));

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function database() {
    return {
        addEventListener: vi.fn(),
        close: vi.fn(),
    } as unknown as IDBPDatabase<TestSchema>;
}

function versionChangeEvent(type: string): IDBVersionChangeEvent {
    return Object.assign(new Event(type), { oldVersion: 1, newVersion: 2 });
}

function manager() {
    return IndexedDbConnectionManager.create<TestSchema>(
        "private-database-name",
        [{ name: "values" }],
        1,
    );
}

function callbacks(attempt = 0): OpenDBCallbacks<TestSchema> {
    return driver.open.mock.calls[attempt][2] as OpenDBCallbacks<TestSchema>;
}

beforeEach(() => {
    vi.useFakeTimers();
    driver.open.mockReset();
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("IndexedDbConnectionManager", () => {
    it("shares and retains a normal open connection", async () => {
        const db = database();
        driver.open.mockResolvedValue(db);
        const connections = manager();

        const first = connections.getDb();
        const second = connections.getDb();

        expect(second).toBe(first);
        await expect(first).resolves.toBe(db);
        expect(driver.open).toHaveBeenCalledOnce();
        expect(callbacks()).toEqual(
            expect.objectContaining({
                upgrade: expect.any(Function),
                blocked: expect.any(Function),
                blocking: expect.any(Function),
                terminated: expect.any(Function),
            }),
        );
        await vi.advanceTimersByTimeAsync(INDEXED_DB_OPEN_TIMEOUT_MS);
        expect(db.close).not.toHaveBeenCalled();
        expect(connections.getDb()).toBe(first);
    });

    it("fails with a fixed redacted error and does not flood retries while open remains pending", async () => {
        driver.open.mockReturnValue(new Promise(() => undefined));
        const connections = manager();
        const opening = connections.getDb();
        const rejection = expect(opening).rejects.toMatchObject({
            name: "IndexedDbCacheUnavailableError",
            code: "indexed_db_cache_unavailable",
            message: "Local cache is unavailable.",
        });

        await vi.advanceTimersByTimeAsync(INDEXED_DB_OPEN_TIMEOUT_MS);

        await rejection;
        expect(String(await opening.catch((error) => error))).not.toContain(
            "private-database-name",
        );
        expect(connections.getDb()).toBe(opening);
        expect(driver.open).toHaveBeenCalledOnce();
    });

    it("closes a handle that arrives after timeout before allowing a fresh attempt", async () => {
        const late = deferred<IDBPDatabase<TestSchema>>();
        const lateDb = database();
        const retryDb = database();
        driver.open.mockReturnValueOnce(late.promise).mockResolvedValueOnce(retryDb);
        const connections = manager();
        const opening = connections.getDb();
        const rejection = expect(opening).rejects.toBeInstanceOf(IndexedDbCacheUnavailableError);

        await vi.advanceTimersByTimeAsync(INDEXED_DB_OPEN_TIMEOUT_MS);
        await rejection;
        late.resolve(lateDb);
        await late.promise;
        await Promise.resolve();
        expect(lateDb.close).toHaveBeenCalledOnce();

        await expect(connections.getDb()).resolves.toBe(retryDb);
        expect(driver.open).toHaveBeenCalledTimes(2);
        expect(lateDb.addEventListener).not.toHaveBeenCalled();
    });

    it("treats a blocked open as unavailable and closes it if it later succeeds", async () => {
        const late = deferred<IDBPDatabase<TestSchema>>();
        const lateDb = database();
        driver.open.mockReturnValue(late.promise);
        const connections = manager();
        const opening = connections.getDb();

        callbacks().blocked?.(1, 2, versionChangeEvent("blocked"));

        await expect(opening).rejects.toBeInstanceOf(IndexedDbCacheUnavailableError);
        expect(connections.getDb()).toBe(opening);
        late.resolve(lateDb);
        await vi.waitFor(() => expect(lateDb.close).toHaveBeenCalledOnce());
    });

    it("closes and forgets a connection when another version needs it", async () => {
        const firstDb = database();
        const secondDb = database();
        driver.open.mockResolvedValueOnce(firstDb).mockResolvedValueOnce(secondDb);
        const connections = manager();

        await expect(connections.getDb()).resolves.toBe(firstDb);
        callbacks().blocking?.(1, 2, versionChangeEvent("versionchange"));

        expect(firstDb.close).toHaveBeenCalledOnce();
        await expect(connections.getDb()).resolves.toBe(secondDb);
        expect(driver.open).toHaveBeenCalledTimes(2);
    });

    it("does not let callbacks from an old connection clear its replacement", async () => {
        const firstDb = database();
        const secondDb = database();
        driver.open.mockResolvedValueOnce(firstDb).mockResolvedValueOnce(secondDb);
        const connections = manager();

        await expect(connections.getDb()).resolves.toBe(firstDb);
        const firstCallbacks = callbacks();
        const firstCloseListener = vi
            .mocked(firstDb.addEventListener)
            .mock.calls.find(([event]) => event === "close")?.[1];
        firstCallbacks.blocking?.(1, 2, versionChangeEvent("versionchange"));

        const replacement = connections.getDb();
        await expect(replacement).resolves.toBe(secondDb);

        firstCallbacks.terminated?.();
        if (typeof firstCloseListener === "function") {
            firstCloseListener.call(firstDb, new Event("close"));
        }

        expect(connections.getDb()).toBe(replacement);
        expect(driver.open).toHaveBeenCalledTimes(2);
        expect(secondDb.close).not.toHaveBeenCalled();
    });

    it("preserves retry after an ordinary open rejection", async () => {
        const failure = new Error("synthetic open failure");
        const db = database();
        driver.open.mockRejectedValueOnce(failure).mockResolvedValueOnce(db);
        const connections = manager();

        await expect(connections.getDb()).rejects.toBe(failure);
        await expect(connections.getDb()).resolves.toBe(db);
        expect(driver.open).toHaveBeenCalledTimes(2);
    });

    it("returns a rejected promise and permits retry after a synchronous open failure", async () => {
        const failure = new DOMException("Synthetic blocked storage context", "SecurityError");
        const db = database();
        driver.open
            .mockImplementationOnce(() => {
                throw failure;
            })
            .mockResolvedValueOnce(db);
        const connections = manager();

        const opening = connections.getDb();
        expect(opening).toBeInstanceOf(Promise);
        await expect(opening).rejects.toBe(failure);
        await expect(connections.getDb()).resolves.toBe(db);
        expect(driver.open).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(INDEXED_DB_OPEN_TIMEOUT_MS);
        expect(db.close).not.toHaveBeenCalled();
    });
});
