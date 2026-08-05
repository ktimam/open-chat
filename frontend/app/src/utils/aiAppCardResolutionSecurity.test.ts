import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AiAppRegistration, ChatIdentifier, OpenChat } from "openchat-client";
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

function client(enabled: number[]): OpenChat {
    return {
        aiApps: async () => [APP],
        enabledAiApps: async () => enabled,
    } as unknown as OpenChat;
}

describe("directory-bound card surface resolution", () => {
    it("resolves only an enabled exact published app revision/action", async () => {
        expect(
            await resolveActionAppForCard(
                client([APP.id]),
                GROUP,
                "entry.add",
                APP.id,
                APP.updated,
            ),
        ).toBeDefined();
        expect(
            await resolveActionAppForCard(client([]), GROUP, "entry.add", APP.id, APP.updated),
        ).toBeUndefined();
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

    it("never resolves a direct-chat iframe while direct enablement is empty", async () => {
        expect(
            await resolveActionAppForCard(client([]), DIRECT, "entry.add", APP.id, APP.updated),
        ).toBeUndefined();
    });

    it("checks backend-hydrated appVerified before lookup or iframe creation", () => {
        const source = readFileSync(
            resolve(process.cwd(), "src/components/home/ActionCardContent.svelte"),
            "utf8",
        );
        const compact = source.replace(/\s+/g, " ");
        const markerCheck = source.indexOf("content.appVerified !== true");
        const lookup = source.indexOf("resolveActionAppForCard(");
        expect(markerCheck).toBeGreaterThan(-1);
        expect(markerCheck).toBeLessThan(lookup);
        expect(source).toContain("if (content.appVerified !== true)");
        expect(source).toContain("if (!cardContentAttested)");
        expect(source).toContain("Directory binding only; card content is untrusted");
        expect(compact).toContain("title, rows, and payload are not attested as app-authored");
    });
});
