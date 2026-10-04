// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import type { OpenChat } from "@client";
import { privateAppWorkspaceState, privateAppWorkspace } from "./privateAppWorkspace";
import { nativeAppDelivery, nativeAppPairing } from "./nativeAppDelivery";
import { localAppDeliveryStatus } from "./localAppRelayDelivery";
import { identityStateStore, currentUserIdStore } from "@client";
import LocalAppCards from "../components_shared/LocalAppCards.svelte";
import { localAppCardAnchors, type LocalAppCardAnchorSource } from "./localAppCardAnchors";
import type { PrivateAppWorkspaceState } from "./privateAppWorkspace";

vi.mock("@client", async () => {
    const { writable } = await import("svelte/store");
    return {
        currentUserIdStore: writable("synthetic-account"),
        identityStateStore: writable({ kind: "logged_in" }),
    };
});
vi.mock("@shared", () => ({ ANON_USER_ID: "anonymous" }));
vi.mock("@utils/navigation", () => ({ navigate: vi.fn() }));
vi.mock("./privateAppWorkspace", async () => {
    const { writable } = await import("svelte/store");
    return {
        privateAppWorkspaceState: writable({}),
        privateAppWorkspace: {
            setAccount: vi.fn(),
            setClient: vi.fn(),
            setConnectAppSetup: vi.fn(),
            configureDirectory: vi.fn(),
            refreshDirectory: vi.fn(async () => false),
            clear: vi.fn(),
            open: vi.fn(),
            close: vi.fn(),
            discard: vi.fn(),
            retryUncertain: vi.fn(),
            reopenDelivered: vi.fn(),
            confirm: vi.fn(),
        },
    };
});
vi.mock("./nativeAppDelivery", async () => {
    const { writable } = await import("svelte/store");
    return {
        nativeAppPairing: writable(undefined),
        nativeAppDelivery: { copyCode: vi.fn(), openBrowser: vi.fn() },
    };
});
vi.mock("./localAppRelayDelivery", async () => {
    const { writable } = await import("svelte/store");
    return { localAppDeliveryStatus: writable(undefined) };
});

const importId = "s".repeat(43);
const approvalId = "reviewed-approval";
let cardPresentation: PrivateAppWorkspaceState["cardPresentation"] = "saved";
const source: LocalAppCardAnchorSource = {
    chatKey: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    chatKind: "direct_chat",
    messageId: "1",
    messageIndex: 1,
};
const view = (status = "sending") => ({
    open: true,
    cardPresentation,
    fieldEditBlocked: false,
    presentationSource: cardPresentation === "source" ? source : undefined,
    presentationDraftId: cardPresentation === "source" ? "draft" : undefined,
    account: "synthetic-account",
    backend: "synthetic-backend",
    processorReady: true,
    busy: status === "sending",
    message: "Synthetic status",
    directoryLoading: false,
    directoryStatus: "",
    appUpdates: {},
    disabledAppIds: [],
    cards: [],
    cardSources: { draft: source },
    editorJson: '{"value":42}',
    recipient: "Review app account",
    draft: {
        id: "draft",
        revision: 1,
        status,
        payload: { value: 42 },
        target: {
            appId: "synthetic",
            actionId: "add",
            destination: "https://example.test/import",
            recipient: "Review app account",
        },
        approval: {
            approvalId,
            request: { idempotencyKey: importId },
            summary: "Exact synthetic reviewed request",
        },
    },
});
const pairing = {
    importId,
    handoffId: "a".repeat(32),
    url: "http://localhost:41000/handoff",
    pairingCode: "A".repeat(20),
    expiresAtMs: Date.now() + 120_000,
};
let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
let releaseAnchor: (() => void) | undefined;
const originalScrollIntoView = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollIntoView",
);
const state = privateAppWorkspaceState as unknown as { set(value: unknown): void };
const pair = nativeAppPairing as unknown as { set(value: unknown): void };
const identity = identityStateStore as unknown as { set(value: unknown): void };
const account = currentUserIdStore as unknown as { set(value: unknown): void };
async function render(native = true, privateApps = true) {
    if (cardPresentation === "source") {
        const anchor = document.createElement("div");
        target.append(anchor);
        releaseAnchor = localAppCardAnchors.register(
            { account: "synthetic-account", backend: "synthetic-backend" },
            source,
            anchor,
        );
    }
    component = mount(LocalAppCards, {
        target,
        props: {
            client: {
                clientOnlyApps: () => privateApps,
                isNativeApp: () => native,
                onLogout: vi.fn(),
            } as unknown as OpenChat,
        },
    });
    await tick();
}
const button = (text: string) =>
    [...target.querySelectorAll("button")].find((node) => node.textContent === text)!;
beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: vi.fn(),
    });
    state.set(view());
    pair.set(undefined);
    localAppDeliveryStatus.set(undefined);
    identity.set({ kind: "logged_in" });
    account.set("synthetic-account");
    target = document.createElement("div");
    document.body.append(target);
});
afterEach(async () => {
    if (component) await unmount(component);
    component = undefined;
    releaseAnchor?.();
    releaseAnchor = undefined;
    if (originalScrollIntoView)
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    target.remove();
});

describe.each(["saved", "source"] as const)("native pairing and retry UI (%s)", (presentation) => {
    beforeEach(() => {
        cardPresentation = presentation;
        state.set(view());
    });
    it("shows the exact transient local URL/code only after pairing and requires separate Copy/Open clicks", async () => {
        await render();
        expect(target.textContent).not.toContain(pairing.pairingCode);
        pair.set(pairing);
        await tick();
        expect(target.textContent).toContain(pairing.pairingCode);
        expect(target.textContent).toContain(pairing.url);
        expect(nativeAppDelivery.copyCode).not.toHaveBeenCalled();
        expect(nativeAppDelivery.openBrowser).not.toHaveBeenCalled();
        button("Copy pairing code").click();
        button("Open local browser").click();
        await tick();
        expect(nativeAppDelivery.copyCode).toHaveBeenCalledExactlyOnceWith(importId);
        expect(nativeAppDelivery.openBrowser).toHaveBeenCalledExactlyOnceWith(importId);
        pair.set(undefined);
        await tick();
        expect(target.textContent).not.toContain(pairing.pairingCode);
    });

    it.each([
        [false, true],
        [true, false],
    ])(
        "never displays native pairing without both UI profile gates (%s/%s)",
        async (native, privateApps) => {
            pair.set(pairing);
            await render(native, privateApps);
            expect(target.textContent).not.toContain(pairing.pairingCode);
            expect(button("Copy pairing code")).toBeUndefined();
        },
    );

    it("does not display another draft's code and hides private content on logout", async () => {
        pair.set({ ...pairing, importId: "other" });
        await render();
        expect(target.textContent).not.toContain(pairing.pairingCode);
        pair.set(pairing);
        await tick();
        expect(target.textContent).toContain(pairing.pairingCode);
        identity.set({ kind: "anon" });
        await tick();
        expect(target.textContent).not.toContain(pairing.pairingCode);
        expect(privateAppWorkspace.setAccount).toHaveBeenLastCalledWith(undefined);
    });

    it("requires a fresh explicit retry acknowledgement and never retries on render/reconnect", async () => {
        state.set(view("uncertain"));
        await render();
        const retry = button("Retry the same reviewed request");
        expect(retry.disabled).toBe(true);
        expect(privateAppWorkspace.retryUncertain).not.toHaveBeenCalled();
        (target.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
        await tick();
        expect(retry.disabled).toBe(false);
        retry.click();
        await tick();
        expect(privateAppWorkspace.retryUncertain).toHaveBeenCalledExactlyOnceWith(approvalId);
        expect(retry.disabled).toBe(true);
        state.set(view("sending"));
        await tick();
        state.set(view("uncertain"));
        await tick();
        expect(button("Retry the same reviewed request").disabled).toBe(true);
        expect(privateAppWorkspace.retryUncertain).toHaveBeenCalledOnce();
    });

    it.each([false, true])(
        "reopens received-but-unsaved requests only after a fresh choice (native=%s)",
        async (native) => {
            state.set(view("delivered"));
            localAppDeliveryStatus.set({ importId, status: "received" });
            await render(native);
            const reopen = button("Reopen the same reviewed request");
            expect(reopen).toBeDefined();
            expect(reopen.disabled).toBe(true);
            expect(privateAppWorkspace.reopenDelivered).not.toHaveBeenCalled();
            expect(target.textContent?.replace(/\s+/g, " ")).toContain(
                "same receiving account and destination",
            );
            (target.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
            await tick();
            expect(reopen.disabled).toBe(false);
            reopen.click();
            await tick();
            expect(privateAppWorkspace.reopenDelivered).toHaveBeenCalledExactlyOnceWith(approvalId);
            expect(reopen.disabled).toBe(true);
            state.set(view("sending"));
            await tick();
            state.set(view("delivered"));
            await tick();
            expect(button("Reopen the same reviewed request").disabled).toBe(true);
            expect(privateAppWorkspace.confirm).not.toHaveBeenCalled();
            expect(privateAppWorkspace.retryUncertain).not.toHaveBeenCalled();
        },
    );

    it("keeps explicit reopen consent across unchanged receipt polling", async () => {
        state.set(view("delivered"));
        localAppDeliveryStatus.set({ importId, status: "received" });
        await render();
        (target.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
        await tick();
        expect(button("Reopen the same reviewed request").disabled).toBe(false);
        // Native polling emits a fresh object every second, even when its status is unchanged.
        localAppDeliveryStatus.set({ importId, status: "received" });
        await tick();
        expect(button("Reopen the same reviewed request").disabled).toBe(false);
        state.set({ ...view("delivered"), message: "Unchanged handoff received" });
        await tick();
        expect(button("Reopen the same reviewed request").disabled).toBe(false);
        expect(privateAppWorkspace.reopenDelivered).not.toHaveBeenCalled();
    });

    it("withdraws reopen consent when saving is reported or the workspace closes", async () => {
        state.set(view("delivered"));
        localAppDeliveryStatus.set({ importId, status: "received" });
        await render();
        expect(button("Reopen the same reviewed request")).toBeDefined();
        (target.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
        await tick();
        localAppDeliveryStatus.set({ importId, status: "saved" });
        await tick();
        expect(button("Reopen the same reviewed request")).toBeUndefined();
        expect(privateAppWorkspace.reopenDelivered).not.toHaveBeenCalled();
        localAppDeliveryStatus.set({ importId, status: "received" });
        await tick();
        expect(button("Reopen the same reviewed request").disabled).toBe(true);
        (target.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
        await tick();
        state.set({ ...view("delivered"), open: false });
        await tick();
        state.set(view("delivered"));
        await tick();
        expect(button("Reopen the same reviewed request").disabled).toBe(true);
    });

    it("distinguishes app receipt from its report of saving and clears on component teardown", async () => {
        state.set(view("delivered"));
        localAppDeliveryStatus.set({ importId, status: "received" });
        await render();
        expect(target.textContent).toContain("finish its review before saving");
        expect(target.textContent).not.toContain("reports that this request was saved");
        localAppDeliveryStatus.set({ importId, status: "saved" });
        await tick();
        expect(target.textContent).toContain("reports that this request was saved");
        await unmount(component!);
        component = undefined;
        expect(privateAppWorkspace.clear).toHaveBeenCalledOnce();
    });
});
