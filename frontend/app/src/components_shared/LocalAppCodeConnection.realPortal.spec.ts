// @vitest-environment jsdom
// Keep the production Sheet/SheetWrapper/SheetBehavior and Overlay/OverlayWrapper.
// Only unrelated layout, translations, client/network and account state are fixtures.
import { webcrypto } from "node:crypto";
import { flushSync, mount, tick, unmount } from "svelte";
import { get, writable } from "@client/utils/stores";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LocalAppDirectory from "./LocalAppDirectory.svelte";
import LocalAppCards from "./LocalAppCards.svelte";
import { localAppCodeConnection, type LocalAppCodeConnection } from "../utils/localAppSetupCode";
import { privateAppWorkspaceState } from "../utils/privateAppWorkspace";
import { directoryFixture, directorySource } from "../utils/localAppDirectory.testFixtures";
import type { OpenChat } from "@client";

const calls = vi.hoisted(() => ({
    refreshDirectory: vi.fn(async () => true),
    connectApp: vi.fn(),
    cancelConnection: vi.fn(),
    clear: vi.fn(),
    setAccount: vi.fn(),
    setClient: vi.fn(),
    setConnectAppSetup: vi.fn(),
    configureDirectory: vi.fn(),
    createAiAppLinkCode: vi.fn(),
    myAiAppKeys: vi.fn(),
    removeMyAiAppKey: vi.fn(),
    copy: vi.fn(),
}));
vi.hoisted(() => {
    window.matchMedia = ((media: string) => ({
        media,
        matches: false,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
        onchange: null,
    })) as typeof window.matchMedia;
});
vi.mock("../utils/privateAppWorkspace", async () => ({
    privateAppWorkspaceState: (await import("@client/utils/stores")).writable({}),
    privateAppWorkspace: calls,
}));
vi.mock("@client", async () => ({
    ...(await import("@client/utils/stores")),
    currentUserIdStore: (await import("@client/utils/stores")).writable("synthetic-account"),
    identityStateStore: (await import("@client/utils/stores")).writable({ kind: "logged_in" }),
    mobileWidth: (await import("@client/utils/stores")).writable(false),
}));
vi.mock("@shared", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@shared")>()),
    ANON_USER_ID: "anonymous",
}));
vi.mock("../utils/localAppSetupConnection", () => ({ connectLocalAppSetup: vi.fn() }));
vi.mock("../utils/aiActionRunner", () => ({ extractPrivateAppAction: vi.fn() }));
vi.mock("../theme/themes", async () => ({
    currentTheme: (await import("@client/utils/stores")).writable({ mode: "light" }),
}));
vi.mock("../utils/localAppRelayDelivery", async () => ({
    localAppDeliveryStatus: (await import("@client/utils/stores")).writable(undefined),
}));
vi.mock("@utils/mainAppsNavigation", () => ({ navigateToMainApps: vi.fn() }));
vi.mock("@utils/aiAppSurfaces", () => ({
    homeSurfaceOpening: vi.fn(),
    connectSurfaceOpening: vi.fn(),
    openSurfaceExternally: vi.fn(),
    aiAppSurfaceDestinationOrigin: (url: string) => new URL(url).origin,
}));
vi.mock("@utils/aiAppLinkConsent", () => ({
    aiAppLinkCompleted: vi.fn(),
    cancelAiAppLinkConsent: vi.fn(),
}));
vi.mock("@src/i18n/i18n", () => ({ i18nKey: (key: string) => key }));
vi.mock("@src/stores/time", async () => ({
    now500: (await import("@client/utils/stores")).writable(Date.now()),
}));
vi.mock("@src/stores/toast", () => ({
    toastStore: { showSuccessToast: vi.fn(), showFailureToast: vi.fn() },
}));
vi.mock("../components/Button.svelte", async () => ({
    default: (await import("./LocalAppDirectory.spec.shell.svelte")).default,
}));
vi.mock("../components/ButtonGroup.svelte", async () => ({
    default: (await import("./LocalAppDirectory.spec.shell.svelte")).default,
}));
vi.mock("../components/ModalContent.svelte", async () => ({
    default: (await import("./LocalAppDirectory.spec.shell.svelte")).default,
}));
vi.mock("@shared_components/Translatable.svelte", async () => ({
    default: (await import("./LocalAppDirectory.spec.shell.svelte")).default,
}));
vi.mock("../components/home/communities/explore/AiAppIcon.svelte", async () => ({
    default: (await import("./LocalAppDirectory.spec.shell.svelte")).default,
}));
vi.mock("../components_mobile/home/communities/explore/AiAppIcon.svelte", async () => ({
    default: (await import("./LocalAppDirectory.spec.shell.svelte")).default,
}));
vi.mock("component-lib", async (importOriginal) => {
    const actual = await importOriginal<typeof import("component-lib")>();
    const shell = (await import("./LocalAppDirectory.spec.shell.svelte")).default;
    return {
        ...actual,
        Body: shell,
        BodySmall: shell,
        CommonButton: shell,
        Title: shell,
        Subtitle: shell,
    };
});

const state = privateAppWorkspaceState as ReturnType<typeof writable<any>>;
const mounted: ReturnType<typeof mount>[] = [];
let connection: LocalAppCodeConnection;
let resolveCode: (value: { code: string; expiresAt: bigint }) => void;
let resolveConnection: (value: boolean) => void;
const button = (text: string) =>
    [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === text)!;
async function settle() {
    await tick();
    await Promise.resolve();
    flushSync();
}
async function animate() {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await settle();
}
function clientFor(mobile: boolean) {
    return {
        ...calls,
        mobileLayout: mobile ? "v2" : "v1",
        clientOnlyApps: () => true,
        privateAppStorageBackend: () => "synthetic-backend",
        onLogout: vi.fn(),
        appDirectoryUrl: () => directorySource,
        durationFromMilliseconds: () => ({ minutes: 10, seconds: 0 }),
    } as unknown as OpenChat;
}
async function openDetail(mobile: boolean) {
    const client = clientFor(mobile);
    const target = document.createElement("div");
    document.body.append(target);
    const context = new Map([["client", client]]);
    mounted.push(mount(LocalAppCards, { target, props: { client }, context }));
    mounted.push(mount(LocalAppDirectory, { target, props: { mobile }, context }));
    await settle();
    const cardLabel = [...target.querySelectorAll<HTMLElement>("*")]
        .reverse()
        .find((node) => node.textContent?.trim() === "sample app");
    expect(cardLabel).toBeDefined();
    cardLabel!.click();
    await settle();
    await animate();
    expect(document.querySelector(mobile ? ".transient_sheet" : ".overlay")).not.toBeNull();
}
beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal("crypto", webcrypto);
    Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: calls.copy },
    });
    // jsdom has no layout. A nonzero measured height exercises actual delayed mobile collapse.
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(240);
    localAppCodeConnection.set(undefined);
    const fixture = await directoryFixture();
    state.set({
        account: "synthetic-account",
        backend: "synthetic-backend",
        directorySource,
        directory: fixture.directory,
        directoryStatus: "",
        cards: [],
        cardSources: {},
        appUpdates: {},
        disabledAppIds: [],
        open: false,
        editorJson: "{}",
    });
    connection = {
        app: {
            connectionKind: "local",
            id: "sample",
            manifest: { name: "sample app", description: "Synthetic", actions: [] },
            connected: false,
            actionsKnown: false,
            setupOrigin: "https://publisher.test",
        },
        transport: {
            setupUrl: "https://publisher.test/connect",
            createCode: vi.fn(
                () =>
                    new Promise<{ code: string; expiresAt: bigint }>((resolve) => {
                        resolveCode = resolve;
                    }),
            ),
            openApp: vi.fn(async () => {}),
            checkConnection: vi.fn(async () => false),
            cancel: vi.fn(async () => {
                localAppCodeConnection.set(undefined);
                resolveConnection?.(false);
            }),
        },
    };
    calls.connectApp.mockImplementation(() => {
        localAppCodeConnection.set(connection);
        return new Promise((resolve) => {
            resolveConnection = resolve;
        });
    });
    calls.cancelConnection.mockImplementation(() => {
        localAppCodeConnection.set(undefined);
        resolveConnection?.(false);
        return true;
    });
});
afterEach(async () => {
    localAppCodeConnection.set(undefined);
    for (const component of mounted.splice(0)) await unmount(component);
    await animate();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe.each([false, true])("real production app portal lifecycle mobile=%s", (mobile) => {
    it("keeps the request alive while its detail portal tears down, then allows explicit cancellation", async () => {
        await openDetail(mobile);
        button("aiApps.connect").click();
        await settle();
        await vi.waitFor(() => expect(connection.transport.createCode).toHaveBeenCalledTimes(1));
        await animate();
        expect(calls.cancelConnection).not.toHaveBeenCalled();
        expect(get(localAppCodeConnection)).toBe(connection);
        resolveCode({ code: "A".repeat(43), expiresAt: BigInt(Date.now() + 600000) });
        await settle();
        expect(document.body.textContent).toContain("A".repeat(43));
        button("aiApps.linkOpenConnectPage").click();
        await settle();
        expect(connection.transport.openApp).toHaveBeenCalledTimes(1);
        button("aiApps.close").click();
        await settle();
        await animate();
        expect(connection.transport.cancel).toHaveBeenCalled();
        expect(get(localAppCodeConnection)).toBeUndefined();
        if (mobile) {
            // Sheet's asynchronous portal can retain its outgoing snippet after the owner
            // is destroyed. It must be collapsed and retain valid captured props, not crash.
            const outgoing = [...document.querySelectorAll<HTMLElement>(".transient_sheet")].find(
                (node) => node.textContent?.includes("A".repeat(43)),
            );
            if (outgoing) expect(outgoing.style.transform).toBe("translateY(240px)");
        } else expect(document.body.textContent).not.toContain("A".repeat(43));
        expect(calls.createAiAppLinkCode).not.toHaveBeenCalled();
    });
    it("still dismisses an ordinary detail without an active code request", async () => {
        await openDetail(mobile);
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        await animate();
        if (mobile) {
            for (const outgoing of document.querySelectorAll<HTMLElement>(".transient_sheet"))
                expect(outgoing.style.transform).toBe("translateY(240px)");
        } else expect(document.querySelector(".overlay")).toBeNull();
        expect(calls.connectApp).not.toHaveBeenCalled();
        expect(get(localAppCodeConnection)).toBeUndefined();
    });
});
