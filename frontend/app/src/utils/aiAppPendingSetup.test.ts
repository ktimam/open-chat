import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AiAppRegistration, ChatIdentifier } from "@shared";
import { describe, expect, it, vi } from "vitest";

vi.mock("./onDeviceInference", () => ({ isNativeClient: () => false }));
import { bindPendingChatLinkSetup, pendingChatLinkSetupAppForChat } from "./aiAppSurfaces";

const APP = { id: 17 } as AiAppRegistration;
const GROUP_A: ChatIdentifier = { kind: "group_chat", groupId: "group-a" };
const GROUP_B: ChatIdentifier = { kind: "group_chat", groupId: "group-b" };

describe("pending chat-link setup", () => {
    it("can only be resumed for the canonical initiating group chat", () => {
        const pending = bindPendingChatLinkSetup(APP, GROUP_A, "viewer-a");

        expect(pendingChatLinkSetupAppForChat(pending, GROUP_A, "viewer-a")).toBe(APP);
        expect(pendingChatLinkSetupAppForChat(pending, GROUP_B, "viewer-a")).toBeUndefined();
        expect(pendingChatLinkSetupAppForChat(pending, GROUP_A, "viewer-b")).toBeUndefined();
    });

    it("binds direct chats using the viewer-aware canonical pair key", () => {
        const viewer = "2vxsx-fae";
        const counterpart = "aaaaa-aa";
        const otherViewer = "ryjl3-tyaaa-aaaaa-aaaba-cai";
        const chat: ChatIdentifier = { kind: "direct_chat", userId: counterpart };
        const pending = bindPendingChatLinkSetup(APP, chat, viewer);

        expect(pendingChatLinkSetupAppForChat(pending, chat, viewer)).toBe(APP);
        expect(pendingChatLinkSetupAppForChat(pending, chat, otherViewer)).toBeUndefined();
        expect(
            pendingChatLinkSetupAppForChat(
                pending,
                { kind: "direct_chat", userId: viewer },
                counterpart,
            ),
        ).toBeUndefined();
    });

    it("wires canonical pending state into all four settings variants", () => {
        const files = [
            resolve(__dirname, "../components/home/groupdetails/AiAppsSummary.svelte"),
            resolve(__dirname, "../components/home/groupdetails/AiAppsDirectSummary.svelte"),
            resolve(__dirname, "../components_mobile/home/groupdetails/AiAppsSummary.svelte"),
            resolve(__dirname, "../components_mobile/home/groupdetails/AiAppsDirectSummary.svelte"),
        ];

        for (const file of files) {
            const source = readFileSync(file, "utf8");
            expect(source).toContain("bindPendingChatLinkSetup");
            expect(source).toContain("pendingChatLinkSetupAppForChat");
            expect(source).toMatch(/return \(\) => \{[\s\S]*pendingSetup = undefined;/);
        }
    });
});
