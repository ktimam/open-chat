// @vitest-environment jsdom
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenChat, MessageContent } from "@client";
import PrivateAppsWorkspace from "./PrivateAppsWorkspace.svelte";
import { privateAppWorkspace as workspace } from "../utils/privateAppWorkspace";

const calls = vi.hoisted(() => ({ extract: vi.fn(), deliver: vi.fn(), cancel: vi.fn() }));
vi.mock("@client", async () => {
    const { writable } = await import("svelte/store");
    return {
        currentUserIdStore: writable("synthetic-account"),
        identityStateStore: writable({ kind: "logged_in" }),
    };
});
vi.mock("@shared", () => ({ ANON_USER_ID: "anonymous" }));
vi.mock("../utils/aiActionRunner", () => ({ extractPrivateAppAction: calls.extract }));
vi.mock("../utils/isolatedAppProcessor", () => ({
    runIsolatedAppProcessor: vi.fn(),
    verifyImportedLocalProcessor: vi.fn(),
}));
vi.mock("../utils/localAppRelayDelivery", async () => ({
    deliverLocalAppViaRelay: calls.deliver,
    cancelLocalAppHandoffs: calls.cancel,
    localAppDeliveryStatus: (await import("svelte/store")).writable(undefined),
}));
vi.mock("../utils/nativeAppDelivery", async () => ({
    nativeAppPairing: (await import("svelte/store")).writable(undefined),
    nativeAppDelivery: { deliver: vi.fn(), cancelAll: vi.fn() },
    nativeDeliveryAllowed: () => false,
}));

const catalog = JSON.stringify({
    version: 1,
    apps: [
        {
            id: "synthetic",
            revision: "1",
            name: "Synthetic app",
            description: "Test only",
            destination: "https://example.test/import",
            actions: [
                {
                    definition: {
                        name: "capture",
                        description: "Capture",
                        promptTemplate: "Extract the selected value",
                        responseSchema: { type: "object" },
                        card: {
                            title: "App-defined title",
                            rows: [{ label: "App-defined value", valueKey: "value" }],
                            disclosure: "App-defined explanation",
                            confirmLabel: "Preview only",
                            cancelLabel: "Keep sending",
                        },
                    },
                    draftSchema: {
                        type: "object",
                        properties: { value: { type: "number" }, extra: { type: "string" } },
                        required: ["value"],
                        additionalProperties: false,
                    },
                    handoff: { kind: "single" },
                },
            ],
        },
    ],
});

let mounted: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
const settle = async () => {
    await tick();
    flushSync();
};
const button = (label: string) =>
    [...target.querySelectorAll("button")].find((node) => node.textContent === label)!;
const preview = () => target.querySelector('[aria-label="App-declared draft preview"]')!;
const editor = () => target.querySelector("textarea")!;

beforeEach(async () => {
    vi.clearAllMocks();
    workspace.clear();
    workspace.setAccount("synthetic-account");
    calls.extract.mockResolvedValue({
        kind: "extracted",
        candidates: [{ value: 42, extra: "Also sent" }],
    });
    calls.deliver.mockResolvedValue({ kind: "delivered" });
    workspace.importCatalog(catalog);
    workspace.select("synthetic", "capture");
    target = document.createElement("div");
    document.body.append(target);
    const client = {
        clientOnlyApps: () => true,
        isNativeApp: () => false,
        existingAccountOnly: () => true,
        onLogout: vi.fn(),
    } as unknown as OpenChat;
    mounted = mount(PrivateAppsWorkspace, { target, props: { client } });
    flushSync();
    await settle();
    await workspace.propose(
        client,
        { kind: "text_content", text: "synthetic source" } as MessageContent,
        { stillCurrent: () => true },
    );
    await settle();
});
afterEach(async () => {
    if (mounted) await unmount(mounted);
    mounted = undefined;
    document.body.replaceChildren();
});

describe("private workspace declarative card and authoritative review", () => {
    it("shows declared labels and additional fields without replacing explicit host sharing consent", async () => {
        expect(preview().textContent).toContain("App-defined title");
        expect(preview().textContent).toContain("App-defined value");
        expect(preview().textContent).toContain("Also sent");
        expect(editor().value).toContain('"extra": "Also sent"');
        expect(calls.deliver).not.toHaveBeenCalled();
        expect(target.textContent).not.toContain("Preview only");
        expect(target.textContent).not.toContain("Keep sending");
        button("Review full request").click();
        await settle();
        expect(button("Send reviewed request").disabled).toBe(true);
        expect(target.textContent).toContain("Send exactly this request outside OpenChat.");
        button("Send reviewed request").click();
        await settle();
        expect(calls.deliver).not.toHaveBeenCalled();
        target.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
        await settle();
        expect(button("Send reviewed request").disabled).toBe(false);
        button("Send reviewed request").click();
        await settle();
        expect(calls.deliver).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                destination: "https://example.test/import",
                payload: { value: 42, extra: "Also sent" },
            }),
            expect.any(AbortSignal),
        );
    });

    it("updates from edited JSON, revokes prior approval, and hides old values on invalid edits", async () => {
        button("Review full request").click();
        await settle();
        const firstApproval = workspace.state.draft!.approval!.approvalId;
        target.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
        await settle();
        editor().value = '{"value":43,"extra":"Edited payload"}';
        editor().dispatchEvent(new Event("input", { bubbles: true }));
        await settle();
        expect(preview().textContent).toContain("43");
        expect(preview().textContent).toContain("Edited payload");
        expect(preview().textContent).not.toContain("Also sent");
        expect(workspace.state.draft!.approval).toBeUndefined();
        expect(button("Send reviewed request")).toBeUndefined();
        await workspace.confirm(firstApproval);
        expect(calls.deliver).not.toHaveBeenCalled();
        editor().value = '{"value":';
        editor().dispatchEvent(new Event("input", { bubbles: true }));
        await settle();
        expect(preview().textContent).toContain("Preview unavailable");
        expect(preview().textContent).not.toContain("Edited payload");
        expect(preview().querySelector("dl")).toBeNull();
        button("Review full request").click();
        await settle();
        expect(workspace.state.draft!.approval).toBeUndefined();
        expect(calls.deliver).not.toHaveBeenCalled();
        expect(calls.extract).toHaveBeenCalledOnce();
    });
});
