// @vitest-environment jsdom
import { flushSync, mount, tick, unmount } from "svelte";
import type { Writable } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PrivateAppsWorkspace from "./PrivateAppsWorkspace.svelte";
import MainMenu from "../components/home/nav/MainMenu.svelte";
import MyApps from "../components/home/profile/MyApps.svelte";
import AppSettings from "../components_mobile/home/user_profile/AppSettings.svelte";
import { anonUserStore, currentUserIdStore, identityStateStore } from "@client";
import { privateAppWorkspaceState } from "../utils/privateAppWorkspace";

// The public client stores are read-only. These test-owned writable handles refer
// only to the replacements created by vi.mock below, never the production stores.
const mockAnonymous = anonUserStore as unknown as Writable<boolean>;
const mockUserId = currentUserIdStore as unknown as Writable<string>;
const mockIdentity = identityStateStore as unknown as Writable<{ kind: string }>;

const calls = vi.hoisted(() => ({
    open: vi.fn(),
    close: vi.fn(),
    clear: vi.fn(),
    setAccount: vi.fn(),
    forgetSetup: vi.fn(async () => true),
    publish: vi.fn(),
}));
vi.mock("@client", async () => {
    const { writable } = await import("svelte/store");
    return {
        OpenChat: class {},
        anonUserStore: writable(false),
        currentUserIdStore: writable("synthetic-user"),
        identityStateStore: writable({ kind: "logged_in" }),
        canExtendDiamondStore: writable(false),
        iconSize: writable("1rem"),
        platformOperatorStore: writable(false),
        publish: calls.publish,
    };
});
vi.mock("@shared", () => ({ ANON_USER_ID: "anonymous" }));
vi.mock("../utils/privateAppWorkspace", async () => {
    const { writable } = await import("svelte/store");
    const state = writable({
        open: false,
        account: "synthetic-user",
        busy: false,
        processorReady: false,
        editorJson: "",
        recipient: "",
        message: "Synthetic setup",
    });
    calls.open.mockImplementation(() => state.update((value) => ({ ...value, open: true })));
    calls.close.mockImplementation(() => state.update((value) => ({ ...value, open: false })));
    return {
        privateAppWorkspaceState: state,
        privateAppWorkspace: { ...calls, contextVersion: 1 },
    };
});
vi.mock("../utils/localAppRelayDelivery", async () => ({
    localAppDeliveryStatus: (await import("svelte/store")).writable(undefined),
}));
vi.mock("../utils/nativeAppDelivery", async () => ({
    nativeAppPairing: (await import("svelte/store")).writable(undefined),
    nativeAppDelivery: {},
}));
vi.mock("@utils/navigation", () => ({ navigate: vi.fn() }));
vi.mock("@src/i18n/i18n", () => ({ i18nKey: (key: string) => key }));
vi.mock("@src/stores/toast", () => ({ toastStore: {} }));
vi.mock("../stores/settings", async () => ({
    myAppsSectionOpen: Object.assign((await import("svelte/store")).writable(false), {
        toggle: vi.fn(),
    }),
}));

// Keep the four product components real. Only their unrelated visual containers,
// translations and model/account services are stubbed; actual branches/events run.
vi.mock("../components/Menu.svelte", async () => ({
    default: (await import("./PrivateAppsNavigation.spec.shell.svelte")).default,
}));
vi.mock("../components/MenuItem.svelte", async () => ({
    default: (await import("./PrivateAppsNavigation.spec.shell.svelte")).default,
}));
vi.mock("../components/Button.svelte", async () => ({
    default: (await import("./PrivateAppsNavigation.spec.shell.svelte")).default,
}));
vi.mock("../components/CollapsibleCard.svelte", async () => ({
    default: (await import("./PrivateAppsNavigation.spec.shell.svelte")).default,
}));
vi.mock("../components/Translatable.svelte", async () => ({
    default: (await import("./PrivateAppsNavigation.spec.shell.svelte")).default,
}));
vi.mock("../components_mobile/Translatable.svelte", async () => ({
    default: (await import("./PrivateAppsNavigation.spec.shell.svelte")).default,
}));
vi.mock("../components_mobile/LinkedCard.svelte", async () => ({
    default: (await import("./PrivateAppsNavigation.spec.shell.svelte")).default,
}));
vi.mock("../components_mobile/home/SlidingPageContent.svelte", async () => ({
    default: (await import("./PrivateAppsNavigation.spec.shell.svelte")).default,
}));
vi.mock("component-lib", async () => {
    const component = (await import("./PrivateAppsNavigation.spec.shell.svelte")).default;
    return { BodySmall: component, Container: component, MenuItem: component };
});

let mounted: ReturnType<typeof mount>[] = [];
function client(local = true) {
    return {
        clientOnlyApps: () => local,
        privateAppStorageBackend: () => "synthetic-backend",
        isNativeApp: () => false,
        existingAccountOnly: () => local,
        onLogout: vi.fn(),
        accountLinkingCodeEnabled: () => false,
        myAiAppsPage: vi.fn(async () => ({ apps: [], total: 0 })),
        publishAiApp: vi.fn(),
        logout: vi.fn(),
    };
}
function render(
    Component: typeof MainMenu | typeof MyApps | typeof AppSettings | typeof PrivateAppsWorkspace,
    local = true,
) {
    const target = document.createElement("div");
    document.body.append(target);
    const fakeClient = client(local);
    const context = new Map([["client", fakeClient]]);
    if (Component === PrivateAppsWorkspace) {
        mounted.push(
            mount(PrivateAppsWorkspace, {
                target,
                context,
                props: { client: fakeClient as unknown as import("@client").OpenChat },
            }),
        );
    } else {
        mounted.push(
            mount(Component as typeof MainMenu | typeof MyApps | typeof AppSettings, {
                target,
                context,
            }),
        );
    }
    flushSync();
    return { target, fakeClient };
}
const privateButton = (target: Element) =>
    [...target.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Private apps",
    );

beforeEach(() => {
    vi.clearAllMocks();
    mockAnonymous.set(false);
    mockUserId.set("synthetic-user");
    mockIdentity.set({ kind: "logged_in" });
    privateAppWorkspaceState.set({
        open: false,
        account: "synthetic-user",
        busy: false,
        processorReady: false,
        editorJson: "",
        recipient: "",
        message: "Synthetic setup",
    } as never);
});
afterEach(async () => {
    for (const component of mounted) await unmount(component);
    mounted = [];
    document.body.replaceChildren();
});

describe("private apps use normal navigation rather than a composer overlay", () => {
    it("discloses setup-only retention, waits for restore and offers explicit device-local forgetting", async () => {
        privateAppWorkspaceState.update((state) => ({
            ...state,
            open: true,
            setupLoading: true,
            setupStatus: "Restoring",
        }));
        const { target } = render(PrivateAppsWorkspace);
        await tick();
        const text = target.textContent?.replace(/\s+/g, " ");
        expect(text).toContain("not protected by chat encryption");
        expect(text).toContain("Drafts and handoff details stay in memory only");
        expect(calls.setAccount).toHaveBeenLastCalledWith("synthetic-user", "synthetic-backend");
        const forget = [...target.querySelectorAll("button")].find((button) =>
            button.textContent?.includes("Forget this account"),
        )!;
        expect(forget.disabled).toBe(true);
        expect(target.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(true);
        privateAppWorkspaceState.update((state) => ({
            ...state,
            setupLoading: false,
            setupStatus: "Saved",
        }));
        await tick();
        expect(forget.disabled).toBe(false);
        forget.click();
        expect(calls.forgetSetup).toHaveBeenCalledOnce();
    });
    it.each([1454, 390])(
        "renders no closed workspace control at viewport width %s",
        async (width) => {
            Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
            const { target } = render(PrivateAppsWorkspace);
            await tick();
            flushSync();
            expect(target.querySelector(".workspace-launcher")).toBeNull();
            expect(target.querySelector("button, section, input")).toBeNull();
            expect(target.childElementCount).toBe(0);
        },
    );

    it("still opens and closes the same workspace without clearing its in-memory setup", async () => {
        const { target } = render(PrivateAppsWorkspace);
        calls.open();
        await tick();
        flushSync();
        expect(target.querySelector('[aria-label="Private app workspace"]')).not.toBeNull();
        [...target.querySelectorAll("button")]
            .find((button) => button.textContent === "Close")!
            .click();
        await tick();
        flushSync();
        expect(target.childElementCount).toBe(0);
        expect(calls.close).toHaveBeenCalledOnce();
        expect(calls.clear).not.toHaveBeenCalled();
    });

    it.each([MainMenu, MyApps, AppSettings])(
        "opens private setup from an existing signed-in navigation component",
        async (Component) => {
            const { target, fakeClient } = render(Component);
            await tick();
            flushSync();
            const button = privateButton(target);
            expect(button).toBeDefined();
            button!.click();
            expect(calls.open).toHaveBeenCalledOnce();
            expect(fakeClient.myAiAppsPage).not.toHaveBeenCalled();
            expect(fakeClient.publishAiApp).not.toHaveBeenCalled();
            if (Component === AppSettings) {
                expect(calls.publish).toHaveBeenCalledWith("closeModalStack");
                expect(calls.publish.mock.invocationCallOrder[0]).toBeLessThan(
                    calls.open.mock.invocationCallOrder[0],
                );
                expect(target.textContent).not.toContain("aiApps.myApps");
            }
        },
    );

    it.each([MainMenu, MyApps, AppSettings])(
        "does not expose private entry points to anonymous users",
        async (Component) => {
            mockAnonymous.set(true);
            const { target, fakeClient } = render(Component);
            await tick();
            flushSync();
            expect(privateButton(target)).toBeUndefined();
            expect(fakeClient.myAiAppsPage).not.toHaveBeenCalled();
        },
    );

    it("preserves the official classic profile registry list", async () => {
        const { target, fakeClient } = render(MyApps, false);
        await tick();
        flushSync();
        expect(privateButton(target)).toBeUndefined();
        expect(fakeClient.myAiAppsPage).toHaveBeenCalledExactlyOnceWith(0, 8);
    });

    it("preserves the official mobile My apps settings navigation", async () => {
        const { target } = render(AppSettings, false);
        await tick();
        flushSync();
        expect(privateButton(target)).toBeUndefined();
        [...target.querySelectorAll("button")]
            .find((button) => button.textContent === "aiApps.myApps")!
            .click();
        expect(calls.publish).toHaveBeenCalledWith("userProfileMyApps");
        expect(calls.open).not.toHaveBeenCalled();
    });

    it("does not add the private menu item to the official main menu", () => {
        const { target } = render(MainMenu, false);
        expect(privateButton(target)).toBeUndefined();
    });
});
