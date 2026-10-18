// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { flushSync, mount, tick, unmount } from "svelte";
import { get, type Writable } from "@client/utils/stores";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LocalAppDirectory from "./LocalAppDirectory.svelte";
import LocalAppCards from "./LocalAppCards.svelte";
import { localAppCodeConnection, type LocalAppCodeConnection } from "../utils/localAppSetupCode";
import {
    privateAppWorkspaceState,
    type PrivateAppWorkspaceState,
} from "../utils/privateAppWorkspace";
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
vi.mock("../components/Overlay.svelte", async () => ({
    default: (await import("./LocalAppCodeConnection.spec.portal.svelte")).default,
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
vi.mock("component-lib", async () => {
    const shell = (await import("./LocalAppDirectory.spec.shell.svelte")).default;
    return {
        Body: shell,
        BodySmall: shell,
        CommonButton: shell,
        Container: shell,
        Title: shell,
        Subtitle: shell,
        Sheet: (await import("./LocalAppCodeConnection.spec.portal.svelte")).default,
    };
});
const state = privateAppWorkspaceState as Writable<PrivateAppWorkspaceState>;
const mounted: ReturnType<typeof mount>[] = [];
let connection: LocalAppCodeConnection;
let resolveCode: (value: { code: string; expiresAt: bigint }) => void;
async function settle() {
    await tick();
    await Promise.resolve();
    flushSync();
}
const button = (text: string) =>
    [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === text)!;

beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal("crypto", webcrypto);
    Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: calls.copy },
    });
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
    } as unknown as PrivateAppWorkspaceState);
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
            }),
        },
    };
    calls.connectApp.mockImplementation(() => {
        localAppCodeConnection.set(connection);
        return new Promise(() => {});
    });
    calls.cancelConnection.mockImplementation(() => {
        localAppCodeConnection.set(undefined);
        return true;
    });
});
afterEach(async () => {
    localAppCodeConnection.set(undefined);
    for (const component of mounted.splice(0)) await unmount(component);
    document.body.replaceChildren();
    vi.unstubAllGlobals();
});
describe.each([false, true])("Apps detail to real code host lifecycle mobile=%s", (mobile) => {
    it("does not treat replacing the detail portal as cancellation of its code request", async () => {
        const client = {
            ...calls,
            mobileLayout: mobile ? "v2" : "v1",
            clientOnlyApps: () => true,
            privateAppStorageBackend: () => "synthetic-backend",
            onLogout: vi.fn(),
            appDirectoryUrl: () => directorySource,
            durationFromMilliseconds: () => ({ minutes: 10, seconds: 0 }),
        } as unknown as OpenChat;
        const target = document.createElement("div");
        document.body.append(target);
        const context = new Map([["client", client]]);
        mounted.push(mount(LocalAppCards, { target, props: { client }, context }));
        mounted.push(mount(LocalAppDirectory, { target, props: { mobile }, context }));
        await settle();
        [...document.querySelectorAll("button")]
            .find((node) => node.textContent?.includes("sample app"))!
            .click();
        await settle();
        button("aiApps.connect").click();
        await settle();
        await vi.waitFor(() => expect(connection.transport.createCode).toHaveBeenCalledTimes(1));
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
        // The original portal may repeat dismissal while tearing itself down;
        // the transport's finish() is idempotent (covered by its own tests).
        expect(connection.transport.cancel).toHaveBeenCalled();
        expect(get(localAppCodeConnection)).toBeUndefined();
        expect(calls.createAiAppLinkCode).not.toHaveBeenCalled();
        expect(calls.myAiAppKeys).not.toHaveBeenCalled();
        expect(calls.removeMyAiAppKey).not.toHaveBeenCalled();
    });
});
