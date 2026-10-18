// @vitest-environment jsdom
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AiAppLinkModal from "../components/home/AiAppLinkModal.svelte";
import AiAppLinkSheet from "../components_mobile/home/AiAppLinkSheet.svelte";
import type { AiAppCodeTransport } from "../utils/aiAppCodeTransport";
import type { LocalAiAppPresentation } from "../utils/localAppDirectoryPresentation";

const calls = vi.hoisted(() => ({
    createAiAppLinkCode: vi.fn(),
    myAiAppKeys: vi.fn(),
    removeMyAiAppKey: vi.fn(),
    cancelConsent: vi.fn(),
    linked: vi.fn(),
    dismiss: vi.fn(),
    clipboard: vi.fn(),
    legacyOpen: vi.fn(),
    legacySurface: vi.fn(),
}));
vi.mock("@client", async () => ({
    mobileWidth: (await import("@client/utils/stores")).writable(false),
}));
vi.mock("@utils/aiAppSurfaces", () => ({
    connectSurfaceOpening: calls.legacySurface,
    openSurfaceExternally: calls.legacyOpen,
    aiAppSurfaceDestinationOrigin: (url: string) => new URL(url).origin,
}));
vi.mock("@utils/aiAppLinkConsent", () => ({
    aiAppLinkCompleted: vi.fn(),
    cancelAiAppLinkConsent: calls.cancelConsent,
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
vi.mock("../components/Overlay.svelte", async () => ({
    default: (await import("./LocalAppDirectory.spec.shell.svelte")).default,
}));
vi.mock("../components/ModalContent.svelte", async () => ({
    default: (await import("./LocalAppDirectory.spec.shell.svelte")).default,
}));
vi.mock("@shared_components/Translatable.svelte", async () => ({
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
        Title: shell,
    };
});
const app: LocalAiAppPresentation = {
    connectionKind: "local",
    id: "sample",
    manifest: { name: "Sample", description: "Synthetic", actions: [] },
    connected: false,
    actionsKnown: false,
    setupOrigin: "https://app.example",
};
let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
let transport: AiAppCodeTransport;
async function settle() {
    await tick();
    await Promise.resolve();
    flushSync();
}
async function render(mobile: boolean) {
    component = mount(mobile ? AiAppLinkSheet : AiAppLinkModal, {
        target,
        props: { app, codeTransport: transport, onDismiss: calls.dismiss, onLinked: calls.linked },
        context: new Map([
            ["client", { ...calls, durationFromMilliseconds: () => ({ minutes: 10, seconds: 0 }) }],
        ]),
    });
    await settle();
}
async function click(key: string) {
    const button = [...target.querySelectorAll("button")].find(
        (node) => node.textContent?.trim() === key,
    );
    expect(button, key).toBeDefined();
    button!.click();
    await settle();
}
function noLegacyCalls() {
    for (const call of [
        calls.createAiAppLinkCode,
        calls.myAiAppKeys,
        calls.removeMyAiAppKey,
        calls.cancelConsent,
        calls.legacyOpen,
        calls.legacySurface,
    ])
        expect(call).not.toHaveBeenCalled();
}
beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, "clipboard", {
        value: { writeText: calls.clipboard },
        configurable: true,
    });
    target = document.createElement("div");
    document.body.append(target);
    transport = {
        setupUrl: "https://app.example/connect",
        createCode: vi.fn(async () => ({
            code: "A".repeat(43),
            expiresAt: BigInt(Date.now() + 600000),
        })),
        openApp: vi.fn(async () => {}),
        checkConnection: vi.fn(async () => false),
        cancel: vi.fn(async () => {}),
    };
});
afterEach(async () => {
    if (component) await unmount(component);
    component = undefined;
    document.body.replaceChildren();
});
describe.each([false, true])(
    "original PR code UI with client-only transport (mobile=%s)",
    (mobile) => {
        it("creates, copies, opens, and checks through the injected transport only", async () => {
            await render(mobile);
            expect(transport.createCode).toHaveBeenCalledTimes(1);
            expect(target.textContent).toContain("A".repeat(43));
            expect(target.textContent).toContain("Destination:");
            expect(target.textContent).not.toMatch(/localhost|5193|upload|iframe/i);
            await click("aiApps.linkCodeCopy");
            expect(calls.clipboard).toHaveBeenCalledWith("A".repeat(43));
            await click("aiApps.linkOpenConnectPage");
            expect(transport.openApp).toHaveBeenCalledTimes(1);
            await click("aiApps.checkConnection");
            expect(calls.linked).not.toHaveBeenCalled();
            vi.mocked(transport.checkConnection).mockResolvedValue(true);
            await click("aiApps.checkConnection");
            expect(calls.linked).toHaveBeenCalledTimes(1);
            noLegacyCalls();
        });
        it("cancels without invoking the original user_index cancellation path", async () => {
            await render(mobile);
            await click("aiApps.close");
            expect(transport.cancel).toHaveBeenCalledTimes(1);
            expect(calls.dismiss).toHaveBeenCalledTimes(1);
            expect(calls.linked).not.toHaveBeenCalled();
            noLegacyCalls();
        });
        it("shows a retry after creation failure without changing transports", async () => {
            vi.mocked(transport.createCode).mockRejectedValueOnce(new Error("offline"));
            await render(mobile);
            expect(target.textContent).toContain("aiApps.linkCodeFailed");
            await click("aiApps.linkNewCode");
            expect(transport.createCode).toHaveBeenCalledTimes(2);
            expect(target.textContent).toContain("A".repeat(43));
            noLegacyCalls();
        });
    },
);
