// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatIdentifier } from "@client";
import LocalAppsChatSettings from "./LocalAppsChatSettings.svelte";
import {
    privateAppWorkspaceState,
    type PrivateAppWorkspaceState,
} from "../utils/privateAppWorkspace";
import { scopedAppFixture } from "../utils/localAppChatRoutes.testFixtures";

const calls = vi.hoisted(() => ({
    configureChat: vi.fn(async () => {}),
    navigate: vi.fn(),
    enabled: vi.fn(() => true),
    setEnabled: vi.fn(),
}));
vi.mock("../utils/privateAppWorkspace", async () => ({
    privateAppWorkspaceState: (await import("svelte/store")).writable({}),
    privateAppWorkspace: { configureChat: calls.configureChat },
}));
vi.mock("../utils/localAppChatState", async () => ({
    localAppChatRevision: (await import("svelte/store")).writable(0),
    localAppChatConfiguration: { enabled: calls.enabled, setEnabled: calls.setEnabled },
}));
vi.mock("../utils/mainAppsNavigation", () => ({ navigateToMainApps: calls.navigate }));
vi.mock("@client", async () => ({
    currentUserIdStore: (await import("svelte/store")).writable("viewer"),
}));
vi.mock("@shared", () => ({ chatIdentifierToString: () => "local-chat-a" }));

let mounted: ReturnType<typeof mount> | undefined;
let fixture: Awaited<ReturnType<typeof scopedAppFixture>>;
function update(patch: Partial<PrivateAppWorkspaceState>) {
    privateAppWorkspaceState.update((old) => ({ ...old, ...patch }));
    flushSync();
}
function render() {
    const target = document.createElement("div");
    document.body.append(target);
    mounted = mount(LocalAppsChatSettings, {
        target,
        props: { chatId: { kind: "direct_chat", userId: "synthetic" } as ChatIdentifier },
    });
    flushSync();
    return target;
}
beforeEach(async () => {
    vi.clearAllMocks();
    calls.enabled.mockReturnValue(true);
    vi.stubGlobal("crypto", webcrypto);
    fixture = await scopedAppFixture();
    privateAppWorkspaceState.set({
        catalog: fixture.catalog,
        connections: fixture.connections,
        chatSetups: [],
        setupLoading: false,
        busy: false,
        setupStatus: "",
    } as unknown as PrivateAppWorkspaceState);
});
afterEach(async () => {
    if (mounted) await unmount(mounted);
    mounted = undefined;
    document.body.replaceChildren();
    vi.unstubAllGlobals();
});

describe("existing chat app setup flow", () => {
    it("requires the chat opt-in before opening its setup", () => {
        calls.enabled.mockReturnValue(false);
        const target = render();
        const button = [...target.querySelectorAll("button")].find(
            (node) => node.textContent?.trim() === "Open setup",
        )!;
        expect(button.disabled).toBe(true);
        expect(target.textContent).toContain("Enable this app in the chat, then open setup");
        button.click();
        expect(calls.configureChat).not.toHaveBeenCalled();
    });
    it("opens only the selected app and current chat's setup without reconnecting the app", async () => {
        const target = render();
        expect(target.textContent).toContain("Set up this chat’s destination");
        const button = [...target.querySelectorAll("button")].find(
            (node) => node.textContent?.trim() === "Open setup",
        )!;
        button.click();
        await tick();
        expect(calls.configureChat).toHaveBeenCalledExactlyOnceWith("sample", "local-chat-a");
        expect(calls.navigate).not.toHaveBeenCalled();
        expect(calls.setEnabled).not.toHaveBeenCalled();
        update({ chatSetups: [fixture.route("local-chat-a", 1)] });
        expect(target.textContent).not.toContain("Set up this chat’s destination");
        expect((target.querySelector("input") as HTMLInputElement).checked).toBe(true);
    });
    it("does not treat another chat's setup as this chat's destination and disables setup while busy", () => {
        update({ chatSetups: [fixture.route("other-chat", 2)] });
        const target = render();
        expect(target.textContent).toContain("Set up this chat’s destination");
        update({ busy: true });
        const button = [...target.querySelectorAll("button")].find(
            (node) => node.textContent?.trim() === "Open setup",
        )!;
        expect(button.disabled).toBe(true);
        button.click();
        expect(calls.configureChat).not.toHaveBeenCalled();
    });
    it("keeps version-one app controls unchanged", () => {
        update({ catalog: fixture.pkg.catalog, connections: [], chatSetups: [] });
        const target = render();
        expect(target.textContent).not.toContain("Open setup");
        expect(target.textContent).toContain("Explore or connect apps");
    });
});
