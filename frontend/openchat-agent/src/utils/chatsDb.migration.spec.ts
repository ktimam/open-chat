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
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

describe("merged chat-cache version 157", () => {
    it.each([152, 153, 154, 155, 156])(
        "rebuilds version %i in only the chat-cache database",
        async (oldVersion) => {
            const network = vi.fn(() => {
                throw new Error("No network allowed in migration regression");
            });
            vi.stubGlobal("fetch", network);
            const transaction = {
                objectStore: vi.fn(),
            };
            const database = {
                objectStoreNames: [
                    "group_details",
                    "community_details",
                    "chat_events",
                    "currentUser",
                ],
                createObjectStore: vi.fn((_name: string) => ({ createIndex: vi.fn() })),
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
                    options.upgrade(database, oldVersion, version, transaction);
                    return database;
                },
            );

            const chats = new ChatsDb({ toString: () => "synthetic-migration-user" } as Principal);
            await expect(chats.getDb()).resolves.toBe(database);
            expect(driver.open).toHaveBeenCalledExactlyOnceWith(
                "openchat_db_synthetic-migration-user",
                157,
                expect.objectContaining({ upgrade: expect.any(Function) }),
            );
            expect(transaction.objectStore).not.toHaveBeenCalled();
            expect(driver.remove).not.toHaveBeenCalled();
            expect(database.deleteObjectStore.mock.calls).toEqual(
                database.objectStoreNames.map((name) => [name]),
            );
            expect(database.createObjectStore.mock.calls.map(([name]) => name)).toEqual([
                "chats",
                "chat_rows",
                "chat_tombstones",
                "bots",
                "chat_events",
                "thread_events",
                "group_details",
                "community_details",
                "failed_chat_messages",
                "failed_thread_messages",
                "cachePrimer",
                "currentUser",
                "publicProfile",
                "localUserIndex",
                "externalAchievements",
                "activityFeed",
                "sync",
            ]);
            // OpenChat's separate app setup, encrypted private-card and native-session databases
            // are never opened or deleted by this upstream chat-cache reset.
            expect(network).not.toHaveBeenCalled();
        },
    );
});
