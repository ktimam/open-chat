import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AiAppRegistration, ChatIdentifier, OpenChat } from "@client";
import { describe, expect, it, vi } from "vitest";
import { resolveActionAppForCard } from "./aiAppSurfaces";

const GROUP: ChatIdentifier = { kind: "group_chat", groupId: "aaaaa-aa" };
const DIRECT: ChatIdentifier = { kind: "direct_chat", userId: "2vxsx-fae" };
const APP = {
    id: 7,
    owner: "aaaaa-aa",
    created: 1n,
    updated: 2n,
    published: true,
    manifest: {
        name: "Generic app",
        description: "test",
        consumerPublicKey: "key",
        perUserKeys: true,
        actions: [
            {
                name: "entry.add",
                description: "add",
                promptTemplate: "prompt",
                card: { title: "Add", rows: [], confirmLabel: "Add", cancelLabel: "Cancel" },
            },
        ],
        surfaces: [{ kind: "card", url: "https://app.example/card?app={appId}", display: "sheet" }],
    },
} as AiAppRegistration;

function client(
    enabled: number[],
    keys: { appId: number; publicKey: string }[] = [
        { appId: APP.id, publicKey: "current-user-key" },
    ],
): OpenChat {
    return {
        aiApps: async () => [APP],
        enabledAiApps: async () => enabled,
        myAiAppKeys: async () => keys,
    } as unknown as OpenChat;
}

function directClient(
    app: AiAppRegistration = APP,
    keys: { appId: number; publicKey: string }[] = [
        { appId: APP.id, publicKey: "current-user-key" },
    ],
) {
    const calls = {
        aiApps: vi.fn(async () => [app]),
        myAiAppKeys: vi.fn(async () => keys),
        enabledAiApps: vi.fn(async () => []),
    };
    return { calls, client: calls as unknown as OpenChat };
}

describe("directory-bound card surface resolution", () => {
    it("resolves only an enabled exact published app revision/action", async () => {
        const paired = await resolveActionAppForCard(
            client([APP.id]),
            GROUP,
            "entry.add",
            APP.id,
            APP.updated,
        );
        expect(paired?.hasPersistentUserPairing).toBe(true);
        expect(
            await resolveActionAppForCard(client([]), GROUP, "entry.add", APP.id, APP.updated),
        ).toBeUndefined();
    });

    it("restores pairing only from this viewer's non-empty exact app key", async () => {
        await expect(
            resolveActionAppForCard(client([APP.id], []), GROUP, "entry.add", APP.id, APP.updated),
        ).resolves.toMatchObject({ hasPersistentUserPairing: false });
        await expect(
            resolveActionAppForCard(
                client([APP.id], [{ appId: APP.id + 1, publicKey: "other-key" }]),
                GROUP,
                "entry.add",
                APP.id,
                APP.updated,
            ),
        ).resolves.toMatchObject({ hasPersistentUserPairing: false });
        await expect(
            resolveActionAppForCard(
                client([APP.id], [{ appId: APP.id, publicKey: "" }]),
                GROUP,
                "entry.add",
                APP.id,
                APP.updated,
            ),
        ).resolves.toMatchObject({ hasPersistentUserPairing: false });
    });

    it("keeps trusted public identity available when the optional pairing lookup fails", async () => {
        const failing = {
            aiApps: vi.fn(async () => [APP]),
            enabledAiApps: vi.fn(async () => [APP.id]),
            myAiAppKeys: vi.fn(async () => {
                throw new Error("unavailable");
            }),
        } as unknown as OpenChat;

        await expect(
            resolveActionAppForCard(failing, GROUP, "entry.add", APP.id, APP.updated),
        ).resolves.toMatchObject({
            identity: { id: APP.id, name: APP.manifest.name },
            hasPersistentUserPairing: false,
        });
    });

    it("requests only the immutable producer id and revision, never the full registry", async () => {
        const aiApps = vi.fn(async () => [APP]);
        const exactClient = {
            aiApps,
            enabledAiApps: vi.fn(async () => [APP.id]),
        } as unknown as OpenChat;

        await resolveActionAppForCard(exactClient, GROUP, "entry.add", APP.id, APP.updated);

        expect(aiApps).toHaveBeenCalledOnce();
        expect(aiApps).toHaveBeenCalledWith([{ appId: APP.id, revision: APP.updated }]);
    });

    it("resolves a connected direct-chat app from its exact published revision without group enablement", async () => {
        const { client: direct, calls } = directClient();

        const resolved = await resolveActionAppForCard(
            direct,
            DIRECT,
            "entry.add",
            APP.id,
            APP.updated,
        );

        expect(resolved?.identity).toEqual({ id: APP.id, name: APP.manifest.name });
        expect(resolved?.hasPersistentUserPairing).toBe(true);
        expect(resolved?.cardSurface?.app).toBe(APP);
        expect(calls.myAiAppKeys).toHaveBeenCalledOnce();
        expect(calls.aiApps).toHaveBeenCalledOnce();
        expect(calls.aiApps).toHaveBeenCalledWith([{ appId: APP.id, revision: APP.updated }]);
        expect(calls.enabledAiApps).not.toHaveBeenCalled();
    });

    it.each([
        ["an empty current-user key", APP, [{ appId: APP.id, publicKey: "" }], APP.updated],
        [
            "a key registered for another app",
            APP,
            [{ appId: APP.id + 1, publicKey: "other-app-key" }],
            APP.updated,
        ],
        [
            "a legacy manifest-key app",
            {
                ...APP,
                manifest: { ...APP.manifest, perUserKeys: false },
            },
            [{ appId: APP.id, publicKey: "current-user-key" }],
            APP.updated,
        ],
        [
            "an unpublished app",
            { ...APP, published: false },
            [{ appId: APP.id, publicKey: "current-user-key" }],
            APP.updated,
        ],
        [
            "a stale carried revision",
            APP,
            [{ appId: APP.id, publicKey: "current-user-key" }],
            APP.updated - 1n,
        ],
        [
            "an app without a card surface",
            {
                ...APP,
                manifest: { ...APP.manifest, surfaces: [] },
            },
            [{ appId: APP.id, publicKey: "current-user-key" }],
            APP.updated,
        ],
    ])("does not resolve a direct-chat iframe for %s", async (_label, app, keys, revision) => {
        const { client: direct } = directClient(app as AiAppRegistration, keys);

        await expect(
            resolveActionAppForCard(direct, DIRECT, "entry.add", APP.id, revision),
        ).resolves.toBeUndefined();
    });

    it("checks backend-hydrated appVerified before lookup or iframe creation", () => {
        const source = readFileSync(
            resolve(__dirname, "../components/home/ActionCardContent.svelte"),
            "utf8",
        );
        const compact = source.replace(/\s+/g, " ");
        const markerCheck = source.indexOf(
            "let resolutionAppVerified = $derived(content.appVerified === true)",
        );
        const lookup = source.indexOf("resolveActionAppForCard(");
        expect(markerCheck).toBeGreaterThan(-1);
        expect(markerCheck).toBeLessThan(lookup);
        expect(source).toContain("if (!appVerified)");
        expect(source).toContain("if (!contentAttested)");
        expect(source).toContain("Directory binding only; card content is untrusted");
        expect(compact).toContain("title, rows, and payload are not attested as app-authored");
    });

    it("retains a successfully resolved app identity across card-session resets", () => {
        const source = readFileSync(
            resolve(__dirname, "../components/home/ActionCardContent.svelte"),
            "utf8",
        );
        const resolution = source.indexOf("const opening = resolution.cardSurface");
        const identityBound = source.indexOf("resolvedAppIdentity = resolution.identity");
        const resetStart = source.indexOf("function resetFrameSession()");
        const loadStart = source.indexOf("function requestCardLoad", resetStart);
        const resetBody = source.slice(resetStart, loadStart);

        expect({
            identityBoundBeforeSurfaceSelection:
                identityBound >= 0 && resolution >= 0 && identityBound < resolution,
            sessionResetPreservesIdentity: !resetBody.includes("resolvedAppIdentity = undefined"),
        }).toEqual({
            identityBoundBeforeSurfaceSelection: true,
            sessionResetPreservesIdentity: true,
        });
    });

    it("re-resolves when optimistic content becomes backend-verified", () => {
        const source = readFileSync(
            resolve(__dirname, "../components/home/ActionCardContent.svelte"),
            "utf8",
        );
        const lifecycle = source.indexOf("// Re-run app resolution when an optimistic local card");
        const effect = source.indexOf("$effect(() => {", lifecycle);
        const lookup = source.indexOf("resolveActionAppForCard(", effect);
        const end = source.indexOf("function postInit", lookup);
        const body = source.slice(effect, end);

        expect(lifecycle).toBeGreaterThan(-1);
        expect(effect).toBeGreaterThan(lifecycle);
        expect(lookup).toBeGreaterThan(effect);
        expect(body).toContain("const appVerified = resolutionAppVerified");
        expect(body).toContain("const contentAttested = resolutionContentAttested");
        expect(body).toContain("if (!appVerified)");
        expect(body).toContain("resolvedAppIdentity = undefined");
        expect(body).toContain("resolvedAppIdentity = resolution.identity");
        expect(body).toContain("if (!contentAttested)");
        const untrackedReset = body.slice(
            body.indexOf("untrack(() => {"),
            body.indexOf("if (!appVerified)"),
        );
        expect(untrackedReset).toContain("resetFrameSession()");
        expect(untrackedReset).toContain("resolvedAppIdentity = undefined");
    });
});
