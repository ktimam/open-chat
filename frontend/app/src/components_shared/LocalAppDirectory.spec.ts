// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { flushSync, mount, tick, unmount } from "svelte";
import { get, type Writable } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LocalAppDirectory from "./LocalAppDirectory.svelte";
import AiAppModal from "../components/home/AiAppModal.svelte";
import AiAppSheet from "../components_mobile/home/communities/explore/AiAppSheet.svelte";
import {
    privateAppWorkspaceState,
    type PrivateAppWorkspaceState,
} from "../utils/privateAppWorkspace";
import { directoryFixture, directorySource } from "../utils/localAppDirectory.testFixtures";

const calls = vi.hoisted(() => ({
    open: vi.fn(),
    invalidateReview: vi.fn(),
    selectCard: vi.fn((_id: string) => true),
    propose: vi.fn(),
    deliver: vi.fn(),
    discard: vi.fn(),
    refreshDirectory: vi.fn(async () => true),
    connectApp: vi.fn(async (_id: string) => true),
    disconnectApp: vi.fn(async (_id: string) => true),
    cancelConnection: vi.fn(() => true),
    navigate: vi.fn(),
    legacyDisconnect: vi.fn(),
    homeSurface: vi.fn(),
    toastSuccess: vi.fn(),
    toastFailure: vi.fn(),
}));
vi.mock("../utils/privateAppWorkspace", async () => ({
    privateAppWorkspaceState: (await import("svelte/store")).writable({}),
    privateAppWorkspace: calls,
}));
vi.mock("@utils/mainAppsNavigation", () => ({ navigateToMainApps: calls.navigate }));
vi.mock("@client", async () => ({ mobileWidth: (await import("svelte/store")).writable(false) }));
vi.mock("@utils/aiAppSurfaces", () => ({ homeSurfaceOpening: calls.homeSurface }));
vi.mock("@src/i18n/i18n", () => ({ i18nKey: (key: string) => key }));
vi.mock("@src/stores/toast", () => ({
    toastStore: { showSuccessToast: calls.toastSuccess, showFailureToast: calls.toastFailure },
}));
vi.mock("../components/Button.svelte", async () => ({
    default: (await import("./LocalAppDirectory.spec.shell.svelte")).default,
}));
vi.mock("../components/ButtonGroup.svelte", async () => ({
    default: (await import("./LocalAppDirectory.spec.shell.svelte")).default,
}));
vi.mock("../components/Overlay.svelte", async () => ({
    default: (await import("./LocalAppDirectory.spec.shell.svelte")).default,
}));
vi.mock("../components/ModalContent.svelte", async () => ({
    default: (await import("./LocalAppDirectory.spec.shell.svelte")).default,
}));
vi.mock("../components/Translatable.svelte", async () => ({
    default: (await import("./LocalAppDirectory.spec.shell.svelte")).default,
}));
vi.mock("../components_mobile/Translatable.svelte", async () => ({
    default: (await import("./LocalAppDirectory.spec.shell.svelte")).default,
}));
vi.mock("../components/home/communities/explore/AiAppIcon.svelte", async () => ({
    default: (await import("./LocalAppDirectory.spec.shell.svelte")).default,
}));
vi.mock("../components_mobile/home/communities/explore/AiAppIcon.svelte", async () => ({
    default: (await import("./LocalAppDirectory.spec.shell.svelte")).default,
}));
vi.mock("component-lib", async () => {
    const shell = (await import("./LocalAppDirectory.spec.shell.svelte")).default;
    return {
        Body: shell,
        BodySmall: shell,
        CommonButton: shell,
        Container: shell,
        Sheet: shell,
        Subtitle: shell,
        Title: shell,
    };
});

const state = privateAppWorkspaceState as Writable<PrivateAppWorkspaceState>;
let fixture: Awaited<ReturnType<typeof directoryFixture>>;
let mounted: ReturnType<typeof mount>[] = [];
function update(value: Partial<PrivateAppWorkspaceState>) {
    state.update((old) => ({ ...old, ...value }));
    flushSync();
}
async function settle() {
    await tick();
    await Promise.resolve();
    flushSync();
}
function render(mobile = false, props: { searchTerm?: string; connectedOnly?: boolean } = {}) {
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(
        mount(LocalAppDirectory, {
            target,
            props: { mobile, ...props },
            context: new Map([["client", { removeMyAiAppKey: calls.legacyDisconnect }]]),
        }),
    );
    flushSync();
    return target;
}
function button(target: Element, text: string) {
    const value = [...target.querySelectorAll("button")].find(
        (node) => node.textContent?.trim() === text,
    );
    expect(value, text).toBeDefined();
    return value!;
}
function select(target: Element) {
    [...target.querySelectorAll("button")]
        .find((node) => node.textContent?.includes("sample app"))!
        .click();
    flushSync();
}

beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal("crypto", webcrypto);
    fixture = await directoryFixture();
    state.set({
        account: "synthetic-account",
        backend: "synthetic-backend",
        directorySource,
        directory: fixture.directory,
        catalog: undefined,
        directoryLoading: false,
        directoryStatus: "",
        setupLoading: false,
        draftLoading: false,
        busy: false,
        cards: [],
        appUpdates: {},
        disabledAppIds: [],
    } as unknown as PrivateAppWorkspaceState);
    calls.connectApp.mockImplementation(async () => {
        update({ catalog: fixture.pkg.catalog });
        return true;
    });
    calls.disconnectApp.mockImplementation(async () => {
        update({ catalog: undefined });
        return true;
    });
    calls.selectCard.mockImplementation((id) => {
        const card = get(state).cards.find((entry) => entry.id === id);
        if (!card) return false;
        update({ draft: card });
        return true;
    });
});
afterEach(async () => {
    for (const instance of mounted) await unmount(instance);
    mounted = [];
    document.body.replaceChildren();
    vi.unstubAllGlobals();
});

describe("main AI Apps directory using the existing PR card and detail components", () => {
    it.each([false, true])(
        "reopens disconnected legacy saved cards with fresh review and no processing (mobile=%s)",
        (mobile) => {
            update({
                cards: [
                    { id: "legacy-no-source", status: "uncertain" },
                ] as unknown as PrivateAppWorkspaceState["cards"],
                catalog: undefined,
                cardSources: {},
            });
            const target = render(mobile, { connectedOnly: true });
            button(target, "Saved cards (1)").click();
            expect(calls.invalidateReview).toHaveBeenCalledOnce();
            expect(calls.selectCard).toHaveBeenCalledExactlyOnceWith("legacy-no-source");
            expect(calls.open).toHaveBeenCalledOnce();
            expect(calls.invalidateReview.mock.invocationCallOrder[0]).toBeLessThan(
                calls.open.mock.invocationCallOrder[0],
            );
            expect(calls.propose).not.toHaveBeenCalled();
            expect(calls.deliver).not.toHaveBeenCalled();
            expect(calls.discard).not.toHaveBeenCalled();
            expect(calls.connectApp).not.toHaveBeenCalled();
        },
    );
    it("does not open an empty card host if selection is rejected", () => {
        update({ cards: [{ id: "retained" }] as unknown as PrivateAppWorkspaceState["cards"] });
        calls.selectCard.mockReturnValueOnce(false);
        const target = render();
        button(target, "Saved cards (1)").click();
        expect(calls.open).not.toHaveBeenCalled();
        expect(calls.invalidateReview).not.toHaveBeenCalled();
    });
    it("preserves an active card and its pending editor instead of selecting another card", () => {
        const draft = { id: "active" } as PrivateAppWorkspaceState["draft"];
        update({
            draft,
            cards: [draft] as PrivateAppWorkspaceState["cards"],
            editorJson: "PENDING EDIT",
        });
        const target = render();
        button(target, "Saved cards (1)").click();
        expect(calls.selectCard).not.toHaveBeenCalled();
        expect(get(state).editorJson).toBe("PENDING EDIT");
        expect(calls.invalidateReview).toHaveBeenCalledOnce();
        expect(calls.open).toHaveBeenCalledOnce();
    });
    it.each(["busy", "draftLoading"] as const)("does not reopen a saved card while %s", (field) => {
        update({
            [field]: true,
            cards: [{ id: "retained" }] as unknown as PrivateAppWorkspaceState["cards"],
        });
        const target = render();
        expect(button(target, "Saved cards (1)").disabled).toBe(true);
        button(target, "Saved cards (1)").click();
        expect(calls.open).not.toHaveBeenCalled();
        expect(calls.selectCard).not.toHaveBeenCalled();
    });
    it.each([false, true])(
        "browses/connects/disconnects using local adapters only (mobile=%s)",
        async (mobile) => {
            const target = render(mobile);
            await settle();
            expect(calls.refreshDirectory).toHaveBeenCalledTimes(1);
            expect(calls.connectApp).not.toHaveBeenCalled();
            select(target);
            expect(target.textContent).toContain("https://publisher.test");
            expect(target.textContent?.replace(/\s+/g, " ")).toContain(
                "No chat messages or draft fields",
            );
            expect(target.querySelector("iframe,input,textarea")).toBeNull();
            button(target, "aiApps.connect").click();
            await settle();
            expect(calls.connectApp).toHaveBeenCalledExactlyOnceWith("sample");
            expect(target.textContent).toContain("aiApps.connectedBadge");
            button(target, "aiApps.disconnect").click();
            await settle();
            expect(calls.disconnectApp).toHaveBeenCalledExactlyOnceWith("sample");
            expect(calls.legacyDisconnect).not.toHaveBeenCalled();
            expect(calls.homeSurface).not.toHaveBeenCalled();
            expect(calls.refreshDirectory).toHaveBeenCalledTimes(1);
        },
    );
    it.each([false, true])(
        "cancels an in-flight connection and ignores its late success (mobile=%s)",
        async (mobile) => {
            let finish!: (value: boolean) => void;
            calls.connectApp.mockImplementation(
                () =>
                    new Promise((resolve) => {
                        finish = resolve;
                    }),
            );
            const target = render(mobile);
            select(target);
            button(target, "aiApps.connect").click();
            await settle();
            button(target, "Cancel connection").click();
            await settle();
            expect(calls.cancelConnection).toHaveBeenCalledOnce();
            finish(true);
            await settle();
            expect(target.textContent).toContain("Connection cancelled");
            expect(target.textContent).not.toContain("Connected. Enable");
        },
    );
    it.each(["busy", "setupLoading", "draftLoading", "directoryLoading"] as const)(
        "disables Connect while %s without attempting a backend call",
        (field) => {
            update({ [field]: true });
            const target = render();
            select(target);
            expect(button(target, "aiApps.connect").disabled).toBe(true);
            button(target, "aiApps.connect").click();
            expect(calls.connectApp).not.toHaveBeenCalled();
        },
    );
    it("does not block discovery or connection just because encrypted cards are retained", async () => {
        update({
            cards: [{ id: "saved-synthetic-card" }] as unknown as PrivateAppWorkspaceState["cards"],
        });
        const target = render();
        select(target);
        button(target, "aiApps.connect").click();
        await settle();
        expect(calls.connectApp).toHaveBeenCalledOnce();
    });
    it("shows retained disabled connections as connected, including their warning", () => {
        update({ catalog: fixture.pkg.catalog, disabledAppIds: ["sample"] });
        const target = render();
        select(target);
        expect(target.textContent).toContain("aiApps.connectedBadge");
        expect(target.textContent).toContain("connection is retained");
        expect(button(target, "aiApps.disconnect").disabled).toBe(false);
    });
    it("retains disconnect for removed apps but never guesses a reconnect URL", () => {
        update({ directory: { version: 1, apps: [] }, catalog: fixture.pkg.catalog });
        const target = render();
        select(target);
        expect(button(target, "aiApps.reconnect").disabled).toBe(true);
        expect(button(target, "aiApps.disconnect").disabled).toBe(false);
    });
    it("filters locally and lets My Apps discover the main app directory", () => {
        const target = render(false, { connectedOnly: true });
        expect(target.textContent).toContain("No connected apps yet");
        expect(target.textContent).not.toContain("sample app");
        button(target, "Discover apps").click();
        expect(calls.navigate).toHaveBeenCalledOnce();
    });
    it("clears old-account detail and ignores a late connection result", async () => {
        let finish!: (value: boolean) => void;
        calls.connectApp.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const target = render();
        select(target);
        button(target, "aiApps.connect").click();
        await settle();
        update({ account: "different-account" });
        finish(true);
        await settle();
        expect(target.textContent).not.toContain("Connected. Enable");
        expect(target.textContent).not.toContain("Connect opens");
    });
    it("shows only fixed errors from a failed connection and retries only explicitly", async () => {
        calls.connectApp.mockRejectedValueOnce(new Error("PRIVATE_PROVIDER_TEXT"));
        const target = render();
        select(target);
        button(target, "aiApps.connect").click();
        await settle();
        expect(target.textContent).toContain("Connection could not be completed");
        expect(target.textContent).not.toContain("PRIVATE_PROVIDER_TEXT");
        expect(calls.connectApp).toHaveBeenCalledTimes(1);
        button(target, "aiApps.connect").click();
        await settle();
        expect(calls.connectApp).toHaveBeenCalledTimes(2);
        expect(target.textContent).toContain("aiApps.connectedBadge");
    });
    it("refreshes again after signing out then back in to the same account", async () => {
        render();
        await settle();
        expect(calls.refreshDirectory).toHaveBeenCalledTimes(1);
        update({ account: undefined, directory: undefined });
        await settle();
        update({ account: "synthetic-account" });
        await settle();
        expect(calls.refreshDirectory).toHaveBeenCalledTimes(2);
    });
    it("shows a refresh failure without hiding previously verified apps", async () => {
        calls.refreshDirectory.mockImplementationOnce(async () => {
            await Promise.resolve();
            update({
                directoryStatus:
                    "The app directory could not be verified. Previously verified apps remain available.",
            });
            return false;
        });
        const target = render();
        await settle();
        expect(target.textContent).toContain("could not be verified");
        expect(target.textContent).toContain("sample app");
        expect(calls.connectApp).not.toHaveBeenCalled();
    });
    it.each([false, true])("escapes publisher labels as text (mobile=%s)", (mobile) => {
        const label = "<img src=x onerror=alert(1)>";
        update({ directory: { version: 1, apps: [{ ...fixture.descriptor, name: label }] } });
        const target = render(mobile);
        expect(target.textContent).toContain(label);
        expect(target.querySelector("img,script,iframe")).toBeNull();
    });
    it.each([AiAppModal, AiAppSheet])(
        "retains the original registered-app disconnect API in the original detail component",
        async (Component) => {
            const target = document.createElement("div");
            document.body.append(target);
            calls.legacyDisconnect.mockResolvedValueOnce(true);
            const app = {
                id: 7,
                manifest: {
                    name: "Synthetic registered app",
                    description: "",
                    actions: [],
                    perUserKeys: true,
                },
            } as unknown as import("@client").AiAppRegistration;
            mounted.push(
                mount(Component, {
                    target,
                    context: new Map([["client", { removeMyAiAppKey: calls.legacyDisconnect }]]),
                    props: {
                        app,
                        connected: true,
                        onDismiss: vi.fn(),
                        onConnect: vi.fn(),
                        onDisconnected: vi.fn(),
                    },
                }),
            );
            flushSync();
            button(target, "aiApps.disconnect").click();
            await settle();
            expect(calls.legacyDisconnect).toHaveBeenCalledExactlyOnceWith(7);
            expect(calls.disconnectApp).not.toHaveBeenCalled();
        },
    );
});
