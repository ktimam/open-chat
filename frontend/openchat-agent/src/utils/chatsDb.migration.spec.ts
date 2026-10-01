// Regression: execute the real ChatsDb migration registration and connection
// manager, substituting only the IDB driver's upgrade callback. No browser storage is opened.
import type { Principal } from "@icp-sdk/core/principal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatsDb } from "./chatsDb";

const driver = vi.hoisted(() => ({ open: vi.fn(), remove: vi.fn() }));

vi.mock("idb", async (importOriginal) => ({
    ...(await importOriginal<typeof import("idb")>()),
    openDB: driver.open,
    deleteDB: driver.remove,
}));

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("merged chat-cache version 153", () => {
    it("upgrades version 152 by clearing only the two details stores", async () => {
        const network = vi.fn(() => {
            throw new Error("No network allowed in migration regression");
        });
        vi.stubGlobal("fetch", network);
        const clears = {
            group_details: vi.fn(async () => undefined),
            community_details: vi.fn(async () => undefined),
        };
        const transaction = {
            objectStore: vi.fn((name: string) => {
                if (name !== "group_details" && name !== "community_details") {
                    throw new Error(`Migration touched an unrelated store: ${name}`);
                }
                return { clear: clears[name] };
            }),
        };
        const database = {
            objectStoreNames: ["group_details", "community_details", "chat_events", "currentUser"],
            createObjectStore: vi.fn(),
            deleteObjectStore: vi.fn(),
            addEventListener: vi.fn(),
        };
        driver.open.mockImplementation(
            async (
                _name: string,
                version: number,
                options: {
                    upgrade: (
                        db: typeof database,
                        previousVersion: number,
                        nextVersion: number,
                        tx: typeof transaction,
                    ) => void;
                },
            ) => {
                options.upgrade(database, 152, version, transaction);
                return database;
            },
        );

        const chats = new ChatsDb({ toString: () => "synthetic-migration-user" } as Principal);
        await expect(chats.getDb()).resolves.toBe(database);
        // The real IDB upgrade callback schedules an asynchronous migration chain.
        await vi.waitFor(() => expect(clears.community_details).toHaveBeenCalledOnce());

        expect(driver.open).toHaveBeenCalledExactlyOnceWith(
            "openchat_db_synthetic-migration-user",
            153,
            expect.objectContaining({ upgrade: expect.any(Function) }),
        );
        expect(transaction.objectStore.mock.calls).toEqual([
            ["group_details"],
            ["community_details"],
        ]);
        expect(clears.group_details).toHaveBeenCalledOnce();
        expect(driver.remove).not.toHaveBeenCalled();
        expect(database.createObjectStore).not.toHaveBeenCalled();
        expect(database.deleteObjectStore).not.toHaveBeenCalled();
        expect(network).not.toHaveBeenCalled();
    });
});
