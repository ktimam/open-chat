import { describe, expect, it, vi } from "vitest";
import type { AiAppRegistration, AiAppUserKey, ChatIdentifier, OpenChat } from "@client";
import { resolveAiAppReconnectTarget } from "./aiAppReconnect";

vi.mock("./aiAppSurfaces", () => ({
    cardSurfaceOpening: (app: AiAppRegistration) =>
        app.manifest.surfaces?.some((surface) => surface.kind === "card") ? {} : undefined,
}));

function registration(overrides: Partial<AiAppRegistration> = {}): AiAppRegistration {
    return {
        id: 7,
        owner: "owner",
        created: 1n,
        updated: 12n,
        published: true,
        manifest: {
            name: "Notebook",
            description: "",
            consumerPublicKey: "",
            perUserKeys: true,
            appCanisterId: "app-canister",
            inboxCanisterId: "inbox-canister",
            actions: [{ name: "record_observation" }],
            surfaces: [{ kind: "card", url: "https://app.example/card", display: "sheet" }],
        },
        ...overrides,
    } as AiAppRegistration;
}

const CHAT_ID = { kind: "direct_chat", userId: "other-user" } as ChatIdentifier;

function clientReturning(
    apps: AiAppRegistration[],
    keys: AiAppUserKey[] = [],
): OpenChat {
    return {
        aiApps: vi.fn().mockResolvedValue(apps),
        myAiAppKeys: vi.fn().mockResolvedValue(keys),
    } as unknown as OpenChat;
}

describe("resolveAiAppReconnectTarget", () => {
    it("resolves the current exact registration rather than the failed historical revision", async () => {
        const current = registration({ updated: 15n });
        const client = clientReturning([current]);

        await expect(
            resolveAiAppReconnectTarget(
                client,
                { appId: 7, appRevision: 12n, actionId: "record_observation" },
                CHAT_ID,
            ),
        ).resolves.toEqual({
            kind: "available",
            app: current,
            previousConnection: { publicKey: "", keyVersion: 0n },
            retryCoordinates: {
                appId: current.id,
                appRevision: current.updated,
                actionId: "record_observation",
            },
        });
        expect(client.aiApps).toHaveBeenCalledWith([{ appId: 7 }]);
    });

    it("uses an existing key only to frame the advisory as reconnect", async () => {
        const current = registration({ updated: 15n });
        const client = clientReturning(
            [current],
            [{ appId: current.id, publicKey: "existing-key", keyVersion: 4n }],
        );

        await expect(
            resolveAiAppReconnectTarget(
                client,
                { appId: 7, appRevision: 12n, actionId: "record_observation" },
                CHAT_ID,
            ),
        ).resolves.toEqual({
            kind: "available",
            app: current,
            previousConnection: { publicKey: "existing-key", keyVersion: 4n },
            retryCoordinates: {
                appId: current.id,
                appRevision: current.updated,
                actionId: "record_observation",
            },
        });
    });

    it("coalesces an impossible duplicate key snapshot instead of choosing by wire order", async () => {
        const current = registration({ updated: 15n });
        const client = clientReturning(
            [current],
            [
                { appId: current.id, publicKey: "first", keyVersion: 4n },
                { appId: current.id, publicKey: "second", keyVersion: 5n },
            ],
        );

        await expect(
            resolveAiAppReconnectTarget(
                client,
                { appId: 7, appRevision: 12n, actionId: "record_observation" },
                CHAT_ID,
            ),
        ).resolves.toEqual({ kind: "app_or_action_unavailable" });
    });

    it("drops a deferred result when the exact proposal context is no longer current", async () => {
        let releaseApps!: (apps: AiAppRegistration[]) => void;
        const client = {
            aiApps: vi.fn(
                () =>
                    new Promise<AiAppRegistration[]>((resolve) => {
                        releaseApps = resolve;
                    }),
            ),
            myAiAppKeys: vi.fn(),
        } as unknown as OpenChat;
        let current = true;
        const pending = resolveAiAppReconnectTarget(
            client,
            { appId: 7, appRevision: 12n, actionId: "record_observation" },
            CHAT_ID,
            () => current,
        );

        current = false;
        releaseApps([registration({ updated: 15n })]);

        await expect(pending).resolves.toEqual({ kind: "stale" });
        expect(client.myAiAppKeys).not.toHaveBeenCalled();
    });

    it.each([
        ["wrong app", registration({ id: 8 })],
        ["rolled-back revision", registration({ updated: 11n })],
        ["unpublished app", registration({ published: false })],
        [
            "app-level key app",
            registration({ manifest: { ...registration().manifest, perUserKeys: false } }),
        ],
        [
            "missing app canister",
            registration({ manifest: { ...registration().manifest, appCanisterId: undefined } }),
        ],
        [
            "missing inbox route",
            registration({ manifest: { ...registration().manifest, inboxCanisterId: undefined } }),
        ],
        [
            "missing exact action",
            registration({ manifest: { ...registration().manifest, actions: [] } }),
        ],
        [
            "missing card surface",
            registration({ manifest: { ...registration().manifest, surfaces: [] } }),
        ],
    ])("coalesces an authoritative %s as app_or_action_unavailable", async (_label, candidate) => {
        const client = clientReturning([candidate]);
        await expect(
            resolveAiAppReconnectTarget(
                client,
                { appId: 7, appRevision: 12n, actionId: "record_observation" },
                CHAT_ID,
            ),
        ).resolves.toEqual({ kind: "app_or_action_unavailable" });
        expect(client.myAiAppKeys).not.toHaveBeenCalled();
    });

    it("propagates a temporary directory query failure instead of calling it unavailable", async () => {
        const failure = new Error("transport unavailable");
        const client = {
            aiApps: vi.fn().mockRejectedValue(failure),
            myAiAppKeys: vi.fn(),
        } as unknown as OpenChat;

        await expect(
            resolveAiAppReconnectTarget(
                client,
                { appId: 7, appRevision: 12n, actionId: "record_observation" },
                CHAT_ID,
            ),
        ).rejects.toBe(failure);
        expect(client.myAiAppKeys).not.toHaveBeenCalled();
    });

    it("propagates a temporary key query failure after an available app was verified", async () => {
        const failure = new Error("key query unavailable");
        const client = {
            aiApps: vi.fn().mockResolvedValue([registration({ updated: 15n })]),
            myAiAppKeys: vi.fn().mockRejectedValue(failure),
        } as unknown as OpenChat;

        await expect(
            resolveAiAppReconnectTarget(
                client,
                { appId: 7, appRevision: 12n, actionId: "record_observation" },
                CHAT_ID,
            ),
        ).rejects.toBe(failure);
    });
});
