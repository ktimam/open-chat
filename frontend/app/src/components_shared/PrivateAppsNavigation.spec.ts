// @vitest-environment jsdom
import { flushSync, mount, tick, unmount } from "svelte";
import type { Writable } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MainMenu from "../components/home/nav/MainMenu.svelte";
import AppSettings from "../components_mobile/home/user_profile/AppSettings.svelte";
import LocalAppsChatSettings from "./LocalAppsChatSettings.svelte";
import { anonUserStore, currentUserIdStore } from "@client";
import { privateAppWorkspaceState } from "../utils/privateAppWorkspace";

const mockAnonymous = anonUserStore as unknown as Writable<boolean>;
const mockUserId = currentUserIdStore as unknown as Writable<string>;

const calls = vi.hoisted(() => ({
    navigateToMainApps: vi.fn(),
    publish: vi.fn(),
    enabled: vi.fn(() => false),
    setEnabled: vi.fn(),
}));

vi.mock("@client", async () => {
    const { writable } = await import("svelte/store");
    return {
        OpenChat: class {},
        anonUserStore: writable(false),
        currentUserIdStore: writable("synthetic-user"),
        canExtendDiamondStore: writable(false),
        iconSize: writable("1rem"),
        platformOperatorStore: writable(false),
        publish: calls.publish,
    };
});
vi.mock("@shared", () => ({
    ANON_USER_ID: "anonymous",
    chatIdentifierToString: () => "synthetic-chat",
}));
vi.mock("../utils/mainAppsNavigation", () => ({
    navigateToMainApps: calls.navigateToMainApps,
}));
vi.mock("../utils/privateAppWorkspace", async () => ({
    privateAppWorkspaceState: (await import("svelte/store")).writable({}),
}));
vi.mock("../utils/localAppChatState", async () => ({
    localAppChatConfiguration: {
        enabled: calls.enabled,
        setEnabled: calls.setEnabled,
    },
    localAppChatRevision: (await import("svelte/store")).writable(0),
}));
vi.mock("@utils/navigation", () => ({ navigate: vi.fn() }));
vi.mock("@src/i18n/i18n", () => ({ i18nKey: (key: string) => key }));

vi.mock("../components/Menu.svelte", async () => ({
    default: (await import("./PrivateAppsNavigation.spec.shell.svelte")).default,
}));
vi.mock("../components/MenuItem.svelte", async () => ({
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

type NavigationComponent = typeof MainMenu | typeof AppSettings;

let mounted: ReturnType<typeof mount>[] = [];

function client(local = true) {
    return {
        clientOnlyApps: () => local,
        accountLinkingCodeEnabled: () => false,
        logout: vi.fn(),
        updateIdentityState: vi.fn(),
    };
}

function renderNavigation(Component: NavigationComponent, local = true) {
    const target = document.createElement("div");
    document.body.append(target);
    const fakeClient = client(local);
    mounted.push(
        mount(Component, {
            target,
            context: new Map([["client", fakeClient]]),
        }),
    );
    flushSync();
    return { target, fakeClient };
}

function renderChatSettings() {
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(
        mount(LocalAppsChatSettings, {
            target,
            props: {
                chatId: {
                    kind: "direct_chat",
                    userId: "synthetic-recipient",
                } as never,
            },
        }),
    );
    flushSync();
    return target;
}

function button(target: Element, label: string): HTMLButtonElement | undefined {
    return [...target.querySelectorAll("button")].find(
        (candidate) => candidate.textContent?.trim() === label,
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    mockAnonymous.set(false);
    mockUserId.set("synthetic-user");
    privateAppWorkspaceState.set({
        setupLoading: false,
        setupStatus: "",
        busy: false,
        cards: [],
        catalog: {
            version: 1,
            apps: [
                {
                    id: "reservations",
                    name: "Reservations",
                    description: "Save reservations",
                    actions: [{ definition: { name: "add" } }, { definition: { name: "cancel" } }],
                },
            ],
        },
    } as never);
});

afterEach(async () => {
    for (const component of mounted) await unmount(component);
    mounted = [];
    document.body.replaceChildren();
});

describe("main apps navigation", () => {
    it.each([MainMenu, AppSettings])(
        "opens Explore apps from a signed-in navigation entry point",
        async (Component) => {
            const { target } = renderNavigation(Component);
            await tick();

            const apps = button(target, "Apps");
            expect(apps).toBeDefined();
            apps!.click();

            expect(calls.navigateToMainApps).toHaveBeenCalledOnce();
        },
    );

    it("opens Explore apps from chat settings without replacing per-chat choices", async () => {
        const target = renderChatSettings();
        await tick();

        button(target, "Explore or connect apps")!.click();
        expect(calls.navigateToMainApps).toHaveBeenCalledOnce();

        const toggle = target.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
        toggle.checked = true;
        toggle.dispatchEvent(new Event("change", { bubbles: true }));
        expect(calls.setEnabled).toHaveBeenCalledExactlyOnceWith(
            "synthetic-user",
            "synthetic-chat",
            "reservations",
            true,
        );
    });

    it.each([MainMenu, AppSettings])(
        "does not expose Apps to anonymous users",
        async (Component) => {
            mockAnonymous.set(true);
            const { target } = renderNavigation(Component);
            await tick();

            expect(button(target, "Apps")).toBeUndefined();
            expect(calls.navigateToMainApps).not.toHaveBeenCalled();
        },
    );

    it("preserves the official mobile My apps navigation", async () => {
        const { target } = renderNavigation(AppSettings, false);
        await tick();

        expect(button(target, "Apps")).toBeUndefined();
        button(target, "aiApps.myApps")!.click();
        expect(calls.publish).toHaveBeenCalledWith("userProfileMyApps");
        expect(calls.navigateToMainApps).not.toHaveBeenCalled();
    });

    it("does not add the local Apps item to the official main menu", () => {
        const { target } = renderNavigation(MainMenu, false);
        expect(button(target, "Apps")).toBeUndefined();
    });
});
