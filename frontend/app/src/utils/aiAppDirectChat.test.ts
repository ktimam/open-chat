import type { OpenChat } from "@client";
import type { AiAppRegistration } from "@shared";
import { describe, expect, it, vi } from "vitest";
import {
    directChatAiAppKeys,
    loadDirectChatAiApps,
    resolveConnectedDirectChatAiApp,
} from "./aiAppDirectChat";

function app(id: number, overrides: Partial<AiAppRegistration> = {}): AiAppRegistration {
    return {
        id,
        owner: "owner",
        created: 1n,
        updated: BigInt(id * 10),
        published: true,
        manifest: {
            name: `app-${id}`,
            description: "test",
            consumerPublicKey: "manifest-key",
            perUserKeys: true,
            actions: [],
        },
        ...overrides,
    };
}

describe("directChatAiAppKeys", () => {
    it("deduplicates deterministically and lets an empty conflicting row fail closed", () => {
        expect([
            ...directChatAiAppKeys([
                { appId: 2, publicKey: "key-2" },
                { appId: 1, publicKey: "key-1" },
                { appId: 1, publicKey: "" },
            ]),
        ]).toEqual([
            [1, ""],
            [2, "key-2"],
        ]);
    });
});

describe("loadDirectChatAiApps", () => {
    it("merges directory and exact connected apps by id, prefers exact, and sorts by id", async () => {
        const directoryOne = app(1, { updated: 10n });
        const exactOne = app(1, { updated: 11n });
        const connectedTwo = app(2);
        const directoryThree = app(3);
        const aiApps = vi.fn(async () => [connectedTwo, exactOne]);
        const client = {
            myAiAppKeys: vi.fn(async () => [
                { appId: 2, publicKey: "key-2" },
                { appId: 1, publicKey: "" },
            ]),
            exploreAiApps: vi.fn(async () => ({
                matches: [directoryThree, directoryOne],
                total: 2,
            })),
            aiApps,
        } as unknown as OpenChat;

        const loaded = await loadDirectChatAiApps(client);

        expect(loaded.apps).toEqual([exactOne, connectedTwo, directoryThree]);
        expect([...loaded.connectedKeys]).toEqual([[2, "key-2"]]);
        expect([...loaded.exactAppIds].sort((left, right) => left - right)).toEqual([1, 2]);
        expect(aiApps).toHaveBeenCalledWith([{ appId: 1 }, { appId: 2 }]);
    });

    it("ignores unpublished and unrequested exact rows", async () => {
        const visible = app(1);
        const client = {
            myAiAppKeys: vi.fn(async () => [{ appId: 1, publicKey: "key-1" }]),
            exploreAiApps: vi.fn(async () => ({
                matches: [{ ...app(2), published: false }],
                total: 1,
            })),
            aiApps: vi.fn(async () => [visible, app(99), { ...app(3), published: false }]),
        } as unknown as OpenChat;

        const loaded = await loadDirectChatAiApps(client);

        expect(loaded.apps).toEqual([visible]);
        expect([...loaded.exactAppIds]).toEqual([1]);
    });

    it("bounds exact connected-app lookup to 32 deterministic ids", async () => {
        const aiApps = vi.fn(async () => []);
        const client = {
            myAiAppKeys: vi.fn(async () =>
                Array.from({ length: 33 }, (_, index) => ({
                    appId: 33 - index,
                    publicKey: `key-${index}`,
                })),
            ),
            exploreAiApps: vi.fn(async () => ({ matches: [], total: 0 })),
            aiApps,
        } as unknown as OpenChat;

        await loadDirectChatAiApps(client);

        expect(aiApps).toHaveBeenCalledWith(
            Array.from({ length: 32 }, (_, index) => ({ appId: index + 1 })),
        );
    });
});

describe("resolveConnectedDirectChatAiApp", () => {
    it("resolves only the matching exact published per-user-key revision", async () => {
        const target = app(7);
        const aiApps = vi.fn(async () => [target]);
        const client = {
            myAiAppKeys: vi.fn(async () => [{ appId: target.id, publicKey: "my-key" }]),
            aiApps,
        } as unknown as OpenChat;

        await expect(
            resolveConnectedDirectChatAiApp(client, target.id, target.updated),
        ).resolves.toEqual({ app: target, recipientKey: "my-key" });
        expect(aiApps).toHaveBeenCalledWith([{ appId: target.id, revision: target.updated }]);
    });

    it("does not query app metadata without this user's non-empty matching key", async () => {
        for (const keys of [
            [],
            [{ appId: 7, publicKey: "" }],
            [{ appId: 8, publicKey: "other-app-key" }],
        ]) {
            const aiApps = vi.fn();
            const client = {
                myAiAppKeys: vi.fn(async () => keys),
                aiApps,
            } as unknown as OpenChat;

            await expect(resolveConnectedDirectChatAiApp(client, 7, 70n)).resolves.toBeUndefined();
            expect(aiApps).not.toHaveBeenCalled();
        }
    });

    it.each([
        ["unpublished", { ...app(7), published: false }],
        ["not per-user-key", { ...app(7), manifest: { ...app(7).manifest, perUserKeys: false } }],
        ["stale", { ...app(7), updated: 71n }],
    ])("rejects an exact response that is %s", async (_label, returned) => {
        const client = {
            myAiAppKeys: vi.fn(async () => [{ appId: 7, publicKey: "my-key" }]),
            aiApps: vi.fn(async () => [returned]),
        } as unknown as OpenChat;

        await expect(resolveConnectedDirectChatAiApp(client, 7, 70n)).resolves.toBeUndefined();
    });
});
