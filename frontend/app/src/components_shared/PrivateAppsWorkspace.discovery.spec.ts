// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenChat } from "@client";
import PrivateAppsWorkspace from "./PrivateAppsWorkspace.svelte";
import { privateAppWorkspace as workspace } from "../utils/privateAppWorkspace";
import { directoryFixture, directorySource } from "../utils/localAppDirectory.testFixtures";

const calls = vi.hoisted(() => ({ connect: vi.fn(), extract: vi.fn(), write: vi.fn() }));
vi.mock("@client", async () => {
    const { writable } = await import("svelte/store");
    return {
        currentUserIdStore: writable("synthetic-account"),
        identityStateStore: writable({ kind: "logged_in" }),
    };
});
vi.mock("@shared", () => ({ ANON_USER_ID: "anonymous" }));
vi.mock("../utils/aiActionRunner", () => ({ extractPrivateAppAction: calls.extract }));
vi.mock("../utils/localAppSetupConnection", () => ({ connectLocalAppSetup: calls.connect }));
vi.mock("../utils/localAppSetupStore", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../utils/localAppSetupStore")>()),
    createBrowserLocalAppSetupStorage: () => ({
        read: async () => undefined,
        write: calls.write,
        remove: async () => {},
    }),
}));
vi.mock("../utils/localAppDraftPersistence", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../utils/localAppDraftPersistence")>()),
    createBrowserLocalAppDraftStorage: () => undefined,
}));
vi.mock("../utils/localAppRelayDelivery", async () => ({
    deliverLocalAppViaRelay: vi.fn(),
    cancelLocalAppHandoffs: vi.fn(),
    localAppDeliveryStatus: (await import("svelte/store")).writable(undefined),
}));
vi.mock("../utils/nativeAppDelivery", async () => ({
    nativeAppPairing: (await import("svelte/store")).writable(undefined),
    nativeAppDelivery: { deliver: vi.fn(), cancelAll: vi.fn() },
    nativeDeliveryAllowed: () => false,
}));

let mounted: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let fixture: Awaited<ReturnType<typeof directoryFixture>>;
beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal("crypto", webcrypto);
    fixture = await directoryFixture("sample", "1", true);
    calls.connect.mockResolvedValue(fixture.connectedJson);
    fetcher = vi.fn<typeof fetch>(
        async (url) =>
            new Response(
                String(url) === directorySource
                    ? fixture.directoryJson
                    : String(url).endsWith(".js")
                      ? fixture.source
                      : fixture.catalogJson,
            ),
    );
    vi.stubGlobal("fetch", fetcher);
    workspace.clear();
    workspace.setAccount("synthetic-account", "synthetic-backend");
    await vi.waitFor(() => expect(workspace.state.setupLoading).toBe(false));
    workspace.open();
    target = document.createElement("div");
    document.body.append(target);
    const client = {
        clientOnlyApps: () => true,
        privateAppStorageBackend: () => "synthetic-backend",
        appDirectoryUrl: () => directorySource,
        onLogout: vi.fn(),
    } as unknown as OpenChat;
    mounted = mount(PrivateAppsWorkspace, { target, props: { client } });
    await tick();
    await vi.waitFor(() => expect(target.textContent).toContain("sample app"));
});
afterEach(async () => {
    if (mounted) await unmount(mounted);
    mounted = undefined;
    target?.remove();
    workspace.clear();
    vi.unstubAllGlobals();
});
const button = (label: string) =>
    [...target.querySelectorAll("button")].find((node) => node.textContent?.trim() === label)!;
describe("automatic app settings", () => {
    it("shows the configured app list automatically with recovery imports collapsed and no connection or inference", () => {
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(calls.connect).not.toHaveBeenCalled();
        expect(calls.extract).not.toHaveBeenCalled();
        const recovery = [...target.querySelectorAll("details")].find((node) =>
            node.querySelector("summary")?.textContent?.includes("Advanced recovery"),
        )!;
        expect(recovery.open).toBe(false);
        expect(recovery.querySelector('input[type="file"]')).not.toBeNull();
        expect(target.textContent?.replace(/\s+/g, " ")).toContain(
            "never enabled in your chats automatically",
        );
    });
    it("Connect installs the paired private setup and verified processor without file handling or chat opt-in", async () => {
        button("Connect").click();
        expect(calls.connect).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(workspace.state.processorReady).toBe(true));
        await tick();
        expect(workspace.selection()?.action.processorContext).toEqual({
            privateLabels: ["Private choice"],
        });
        expect(workspace.state.enabledChats).toEqual([]);
        expect(calls.extract).not.toHaveBeenCalled();
        expect(button("Reconnect / refresh setup")).toBeDefined();
        expect(calls.write).toHaveBeenCalled();
    });
    it("displays failure and permits only explicit retry, with no partial installation", async () => {
        calls.connect.mockRejectedValueOnce(new Error("private account error"));
        button("Connect").click();
        await vi.waitFor(() => expect(target.textContent).toContain("retry Connect explicitly"));
        expect(workspace.state.catalog).toBeUndefined();
        expect(calls.connect).toHaveBeenCalledOnce();
        expect(target.textContent).not.toContain("private account error");
        button("Connect").click();
        await vi.waitFor(() => expect(workspace.state.processorReady).toBe(true));
        expect(calls.connect).toHaveBeenCalledTimes(2);
    });
    it("renders publisher labels as text rather than HTML", async () => {
        const directory = JSON.parse(fixture.directoryJson);
        directory.apps[0].name = '<img src=x onerror="alert(1)">';
        fetcher.mockResolvedValueOnce(new Response(JSON.stringify(directory)));
        button("Refresh available apps").click();
        await vi.waitFor(() => expect(target.textContent).toContain("<img src=x"));
        expect(target.querySelector("img")).toBeNull();
        expect(calls.connect).not.toHaveBeenCalled();
    });
});
