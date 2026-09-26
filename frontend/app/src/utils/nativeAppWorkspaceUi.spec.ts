// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import type { OpenChat } from "@client";
import { privateAppWorkspaceState, privateAppWorkspace } from "./privateAppWorkspace";
import { nativeAppDelivery, nativeAppPairing } from "./nativeAppDelivery";
import { localAppDeliveryStatus } from "./localAppRelayDelivery";
import { identityStateStore, currentUserIdStore } from "@client";
import PrivateAppsWorkspace from "../components_shared/PrivateAppsWorkspace.svelte";

vi.mock("@client", async () => {
    const { writable } = await import("svelte/store");
    return { currentUserIdStore: writable("synthetic-account"), identityStateStore: writable({ kind: "logged_in" }) };
});
vi.mock("@shared", () => ({ ANON_USER_ID: "anonymous" }));
vi.mock("./privateAppWorkspace", async () => {
    const { writable } = await import("svelte/store");
    return { privateAppWorkspaceState: writable({}), privateAppWorkspace: {
        setAccount: vi.fn(), clear: vi.fn(), open: vi.fn(), close: vi.fn(), discard: vi.fn(),
        retryUncertain: vi.fn(), confirm: vi.fn(),
    } };
});
vi.mock("./nativeAppDelivery", async () => {
    const { writable } = await import("svelte/store");
    return { nativeAppPairing: writable(undefined), nativeAppDelivery: { copyCode: vi.fn(), openBrowser: vi.fn() } };
});
vi.mock("./localAppRelayDelivery", async () => {
    const { writable } = await import("svelte/store");
    return { localAppDeliveryStatus: writable(undefined) };
});

const importId = "s".repeat(43);
const approvalId = "reviewed-approval";
const view = (status = "sending") => ({
    open: true, account: "synthetic-account", processorReady: true, busy: status === "sending", message: "Synthetic status",
    editorJson: '{"value":42}', recipient: "Review app account", draft: {
        id: "draft", revision: 1, status, payload: { value: 42 },
        target: { appId: "synthetic", actionId: "add", destination: "https://example.test/import", recipient: "Review app account" },
        approval: { approvalId, request: { idempotencyKey: importId }, summary: "Exact synthetic reviewed request" },
    },
});
const pairing = { importId, handoffId: "a".repeat(32), url: "http://localhost:41000/handoff", pairingCode: "A".repeat(20), expiresAtMs: Date.now() + 120_000 };
let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
const state = privateAppWorkspaceState as unknown as { set(value: unknown): void };
const pair = nativeAppPairing as unknown as { set(value: unknown): void };
const identity = identityStateStore as unknown as { set(value: unknown): void };
const account = currentUserIdStore as unknown as { set(value: unknown): void };
async function render(native = true, existing = true) {
    component = mount(PrivateAppsWorkspace, { target, props: { client: {
        clientOnlyApps: () => true, isNativeApp: () => native, existingAccountOnly: () => existing, onLogout: vi.fn(),
    } as unknown as OpenChat } });
    await tick();
}
const button = (text: string) => [...target.querySelectorAll("button")].find(node => node.textContent === text)!;
beforeEach(() => {
    vi.clearAllMocks(); state.set(view()); pair.set(undefined); localAppDeliveryStatus.set(undefined);
    identity.set({ kind: "logged_in" }); account.set("synthetic-account");
    target = document.createElement("div"); document.body.append(target);
});
afterEach(async () => { if (component) await unmount(component); component = undefined; target.remove(); });

describe("native pairing and retry UI", () => {
    it("shows the exact transient local URL/code only after pairing and requires separate Copy/Open clicks", async () => {
        await render(); expect(target.textContent).not.toContain(pairing.pairingCode);
        pair.set(pairing); await tick();
        expect(target.textContent).toContain(pairing.pairingCode); expect(target.textContent).toContain(pairing.url);
        expect(nativeAppDelivery.copyCode).not.toHaveBeenCalled(); expect(nativeAppDelivery.openBrowser).not.toHaveBeenCalled();
        button("Copy pairing code").click(); button("Open local browser").click(); await tick();
        expect(nativeAppDelivery.copyCode).toHaveBeenCalledExactlyOnceWith(importId);
        expect(nativeAppDelivery.openBrowser).toHaveBeenCalledExactlyOnceWith(importId);
        pair.set(undefined); await tick(); expect(target.textContent).not.toContain(pairing.pairingCode);
    });

    it.each([[false, true], [true, false]])("never displays native pairing without both UI profile gates (%s/%s)", async (native, existing) => {
        pair.set(pairing); await render(native, existing);
        expect(target.textContent).not.toContain(pairing.pairingCode); expect(button("Copy pairing code")).toBeUndefined();
    });

    it("does not display another draft's code and hides private content on logout", async () => {
        pair.set({ ...pairing, importId: "other" }); await render(); expect(target.textContent).not.toContain(pairing.pairingCode);
        pair.set(pairing); await tick(); expect(target.textContent).toContain(pairing.pairingCode);
        identity.set({ kind: "anon" }); await tick(); expect(target.textContent).not.toContain(pairing.pairingCode);
        expect(privateAppWorkspace.setAccount).toHaveBeenLastCalledWith(undefined);
    });

    it("requires a fresh explicit retry acknowledgement and never retries on render/reconnect", async () => {
        state.set(view("uncertain")); await render();
        const retry = button("Retry the same reviewed request"); expect(retry.disabled).toBe(true);
        expect(privateAppWorkspace.retryUncertain).not.toHaveBeenCalled();
        (target.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); await tick();
        expect(retry.disabled).toBe(false); retry.click(); await tick();
        expect(privateAppWorkspace.retryUncertain).toHaveBeenCalledExactlyOnceWith(approvalId);
        expect(retry.disabled).toBe(true);
        state.set(view("sending")); await tick(); state.set(view("uncertain")); await tick();
        expect(button("Retry the same reviewed request").disabled).toBe(true);
        expect(privateAppWorkspace.retryUncertain).toHaveBeenCalledOnce();
    });

    it("distinguishes app receipt from its report of saving and clears on component teardown", async () => {
        state.set(view("delivered")); localAppDeliveryStatus.set({ importId, status: "received" }); await render();
        expect(target.textContent).toContain("finish its review before saving");
        expect(target.textContent).not.toContain("reports that this request was saved");
        localAppDeliveryStatus.set({ importId, status: "saved" }); await tick();
        expect(target.textContent).toContain("reports that this request was saved");
        await unmount(component!); component = undefined;
        expect(privateAppWorkspace.clear).toHaveBeenCalledOnce();
    });
});
