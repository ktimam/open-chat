import type { ActionCardContent, ChatIdentifier, OpenChat } from "@client";
import { mount, tick, unmount } from "svelte";
import { writable } from "svelte/store";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    resolveActionAppForCard: vi.fn(),
    privateContextAvailable: false,
    createAiAppCardCapability: vi.fn(),
}));

vi.mock("../../utils/aiAppSurfaces", () => ({
    resolveActionAppForCard: mocks.resolveActionAppForCard,
}));

vi.mock("../../utils/aiActionAvailability", () => ({
    appCardFinalConfirmationAvailable: () => true,
    appCardPrivateContextAvailable: () => mocks.privateContextAvailable,
    appCardRenderingAvailable: () => true,
}));

let ActionCardContentHarness: (typeof import("../../../test-stubs/ActionCardContentHarness.svelte"))["default"];
const matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, "matchMedia");

const CARD_URL = "https://app.example/openchat/card";
const GROUP: ChatIdentifier = { kind: "group_chat", groupId: "aaaaa-aa" };
const DIRECT: ChatIdentifier = { kind: "direct_chat", userId: "aaaaa-bb" };
const VIEWER = "2vxsx-fae";
const APP_ID = 7;
const APP_REVISION = 2n;

const RESOLVED_APP = {
    identity: {
        id: APP_ID,
        name: "Generic app",
        iconUrl: "https://app.example/icon.svg",
    },
    hasPersistentUserPairing: true,
    cardSurface: {
        app: { id: APP_ID, updated: APP_REVISION },
        surface: { kind: "card", url: CARD_URL, display: "sheet" },
        url: CARD_URL,
        dataDisclosures: [],
        labelToField: { Amount: "amount" },
    },
};

function card(overrides: Partial<ActionCardContent> = {}): ActionCardContent {
    return {
        kind: "action_card_content",
        title: "Add entry",
        rows: [{ label: "Amount", value: "25" }],
        confirmLabel: "Add",
        cancelLabel: "Cancel",
        actionId: "generic.entry.add",
        appId: APP_ID,
        appRevision: APP_REVISION,
        appVerified: true,
        appContentVerified: true,
        confirmPayload: new TextEncoder().encode('{"amount":25}'),
        state: "pending",
        ...overrides,
    };
}

function setCredentiallessSupport(supported: boolean): () => void {
    const descriptor = Object.getOwnPropertyDescriptor(
        HTMLIFrameElement.prototype,
        "credentialless",
    );
    if (supported) {
        Object.defineProperty(HTMLIFrameElement.prototype, "credentialless", {
            configurable: true,
            writable: true,
            value: true,
        });
    } else {
        delete (HTMLIFrameElement.prototype as { credentialless?: boolean }).credentialless;
    }
    return () => {
        if (descriptor === undefined) {
            delete (HTMLIFrameElement.prototype as { credentialless?: boolean }).credentialless;
        } else {
            Object.defineProperty(HTMLIFrameElement.prototype, "credentialless", descriptor);
        }
    };
}

function buttonNamed(target: HTMLElement, name: string): HTMLButtonElement | undefined {
    return Array.from(target.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === name,
    );
}

function postedMessageOfType(postMessage: ReturnType<typeof vi.spyOn>, type: string): boolean {
    return (postMessage.mock.calls as unknown[][]).some(
        ([message]) => (message as { type?: string }).type === type,
    );
}

beforeAll(async () => {
    Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: vi.fn().mockImplementation((query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
        })),
    });
    ({ default: ActionCardContentHarness } =
        await import("../../../test-stubs/ActionCardContentHarness.svelte"));
});

afterAll(() => {
    if (matchMediaDescriptor === undefined) {
        delete (window as { matchMedia?: typeof window.matchMedia }).matchMedia;
    } else {
        Object.defineProperty(window, "matchMedia", matchMediaDescriptor);
    }
});

async function mountCard(
    initialContent: ActionCardContent,
    messageId: bigint,
    chatId: ChatIdentifier = GROUP,
    readonly = false,
    onRespond?: (
        response: "confirm" | "cancel",
        confirmPayloadOverride?: Uint8Array,
        confirmationGrant?: Uint8Array,
    ) => void | Promise<unknown>,
) {
    const target = document.createElement("div");
    document.body.append(target);
    const contentStore = writable(initialContent);
    const component = mount(ActionCardContentHarness, {
        target,
        props: {
            contentStore,
            readonly,
            chatId,
            messageId,
            viewerId: VIEWER,
            onRespond,
        },
        context: new Map([
            [
                "client",
                {
                    createAiAppCardCapability: mocks.createAiAppCardCapability,
                } as unknown as OpenChat,
            ],
        ]),
    });
    await tick();
    return {
        target,
        component,
        contentStore,
        async cleanup() {
            await unmount(component);
            target.remove();
        },
    };
}

async function waitForResolution(): Promise<void> {
    await vi.waitFor(() => expect(mocks.resolveActionAppForCard).toHaveBeenCalled());
}

async function completeCardReadyHandshake(target: HTMLElement): Promise<{
    iframe: HTMLIFrameElement;
    postMessage: ReturnType<typeof vi.spyOn>;
    frameNonce: string;
}> {
    const iframe = target.querySelector("iframe");
    if (iframe?.contentWindow == null) throw new Error("card iframe is unavailable");
    const frameWindow = iframe.contentWindow;
    const postMessage = vi.spyOn(frameWindow, "postMessage");

    iframe.dispatchEvent(new Event("load"));
    await vi.waitFor(() => {
        expect(
            postMessage.mock.calls.some(
                ([message]) => (message as { type?: string }).type === "oc:card:bootstrap",
            ),
        ).toBe(true);
    });
    const bootstrap = postMessage.mock.calls
        .map(([message]) => message as { type?: string; frameNonce?: string })
        .find((message) => message.type === "oc:card:bootstrap");
    if (bootstrap?.frameNonce === undefined) throw new Error("card bootstrap nonce is unavailable");

    window.dispatchEvent(
        new MessageEvent("message", {
            data: {
                type: "oc:card:ready",
                version: 2,
                frameNonce: bootstrap.frameNonce,
            },
            origin: "null",
            source: frameWindow,
        }),
    );
    await vi.waitFor(() => expect(iframe.classList.contains("inactive")).toBe(false));
    return { iframe, postMessage, frameNonce: bootstrap.frameNonce };
}

beforeEach(() => {
    mocks.resolveActionAppForCard.mockReset();
    mocks.resolveActionAppForCard.mockResolvedValue(RESOLVED_APP);
    mocks.privateContextAvailable = false;
    mocks.createAiAppCardCapability.mockReset();
});

describe("action-card external surface load consent", () => {
    it("auto-renders a fully attested paired recipient with its registered logo and no load gate", async () => {
        const restore = setCredentiallessSupport(true);
        const view = await mountCard(card({ confirmPayload: undefined }), 1_100n);
        try {
            await waitForResolution();
            await vi.waitFor(() => expect(view.target.querySelectorAll("iframe")).toHaveLength(1));

            expect(buttonNamed(view.target, "Load app card")).toBeUndefined();
            expect(view.target.querySelector(".card-load-gate")).toBeNull();
            expect(view.target.querySelector(".card-security-details")).toBeNull();
            expect(view.target.textContent).not.toContain("Security details");
            expect(view.target.querySelector<HTMLImageElement>(".app-icon")?.src).toBe(
                RESOLVED_APP.identity.iconUrl,
            );
            expect(view.target.querySelector(".card-url")?.textContent?.trim()).toBe(CARD_URL);
        } finally {
            await view.cleanup();
            restore();
        }
    });

    it("uses persistent per-user pairing to request private context once and hydrate the frame", async () => {
        const restore = setCredentiallessSupport(true);
        mocks.privateContextAvailable = true;
        mocks.createAiAppCardCapability.mockResolvedValue({
            capability: "opaque-capability",
            expiresAt: BigInt(Date.now() + 60_000),
            context: {
                contextVersion: 1,
                appSubject: "app-subject",
                chatHandle: "chat-handle",
                messageHandle: "message-handle",
                appId: APP_ID,
                appRevision: APP_REVISION,
                actionId: "generic.entry.add",
            },
        });
        const view = await mountCard(card({ confirmPayload: undefined }), 1_101n);
        let postMessage: ReturnType<typeof vi.spyOn> | undefined;
        try {
            await waitForResolution();
            const ready = await completeCardReadyHandshake(view.target);
            postMessage = ready.postMessage;
            await vi.waitFor(() =>
                expect(postedMessageOfType(postMessage!, "oc:card:private-context-request")).toBe(
                    true,
                ),
            );
            expect(
                (postMessage.mock.calls as unknown[][]).filter(
                    ([message]) =>
                        (message as { type?: string }).type === "oc:card:private-context-request",
                ),
            ).toHaveLength(1);

            const recipientKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
                .replaceAll("+", "-")
                .replaceAll("/", "_")
                .replaceAll("=", "");
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "oc:card:private-context-ready",
                        version: 2,
                        frameNonce: ready.frameNonce,
                        privateContext: {
                            recipientKeyScheme: "x25519-v1",
                            recipientPublicKey: recipientKey,
                        },
                    },
                    origin: "null",
                    source: ready.iframe.contentWindow,
                }),
            );

            await vi.waitFor(() => expect(mocks.createAiAppCardCapability).toHaveBeenCalledOnce());
            await vi.waitFor(() => {
                const initMessages = (postMessage!.mock.calls as unknown[][])
                    .map(
                        ([message]) =>
                            message as { type?: string; context?: { privateContext?: unknown } },
                    )
                    .filter(
                        (message: { type?: string; context?: { privateContext?: unknown } }) =>
                            message.type === "oc:card:init",
                    );
                expect(
                    initMessages.some(
                        (message: { type?: string; context?: { privateContext?: unknown } }) =>
                            message.context?.privateContext !== undefined,
                    ),
                ).toBe(true);
            });
        } finally {
            postMessage?.mockRestore();
            await view.cleanup();
            restore();
        }
    });

    it.each([
        ["unpaired", false, false],
        ["read-only", true, true],
    ])("never auto-shares private context for a %s viewer", async (_label, readonly, paired) => {
        const restore = setCredentiallessSupport(true);
        mocks.privateContextAvailable = true;
        mocks.resolveActionAppForCard.mockResolvedValue({
            ...RESOLVED_APP,
            hasPersistentUserPairing: paired,
        });
        const view = await mountCard(card({ confirmPayload: undefined }), 1_102n, GROUP, readonly);
        let postMessage: ReturnType<typeof vi.spyOn> | undefined;
        try {
            await waitForResolution();
            const ready = await completeCardReadyHandshake(view.target);
            postMessage = ready.postMessage;
            await tick();

            expect(postedMessageOfType(postMessage, "oc:card:private-context-request")).toBe(false);
            expect(mocks.createAiAppCardCapability).not.toHaveBeenCalled();
        } finally {
            postMessage?.mockRestore();
            await view.cleanup();
            restore();
        }
    });

    it("renders a trusted multi-entry summary as one classic stored-payload confirmation", async () => {
        const restore = setCredentiallessSupport(true);
        const onRespond = vi.fn();
        const view = await mountCard(
            card({
                title: "Add 2 entries",
                rows: [
                    { label: "Entry 1", value: "Settlement · 25 EGP" },
                    { label: "Entry 2", value: "Charge · 10 EGP" },
                ],
                confirmPayload: new TextEncoder().encode('[{"amount":25},{"amount":10}]'),
                disclosure: "I reviewed these entries.",
            }),
            1_103n,
            GROUP,
            false,
            onRespond,
        );
        try {
            await waitForResolution();
            await vi.waitFor(() =>
                expect(view.target.textContent).toContain("Settlement · 25 EGP"),
            );

            expect(view.target.querySelector("iframe")).toBeNull();
            expect(buttonNamed(view.target, "Load app card")).toBeUndefined();
            expect(view.target.textContent).not.toContain("Security details");
            expect(view.target.querySelector<HTMLImageElement>(".app-icon")?.src).toBe(
                RESOLVED_APP.identity.iconUrl,
            );

            expect(buttonNamed(view.target, "Add")?.disabled).toBe(true);
            const disclosure =
                view.target.querySelector<HTMLInputElement>('input[type="checkbox"]');
            expect(disclosure).not.toBeNull();
            disclosure?.click();
            await tick();
            expect(buttonNamed(view.target, "Add")?.disabled).toBe(false);
            buttonNamed(view.target, "Add")?.click();
            await vi.waitFor(() => expect(onRespond).toHaveBeenCalledOnce());
            expect(onRespond).toHaveBeenCalledWith("confirm", undefined, undefined);
        } finally {
            await view.cleanup();
            restore();
        }
    });

    it("shows only the exact registered URL, not technical disclosure copy", async () => {
        const restore = setCredentiallessSupport(true);
        const view = await mountCard(card({ confirmPayload: undefined }), 1_010n);
        try {
            await waitForResolution();
            await vi.waitFor(() => expect(view.target.querySelector("iframe")).not.toBeNull());

            expect(view.target.querySelector(".app-name")?.textContent?.trim()).toBe("Generic app");
            expect(view.target.querySelector(".title")?.textContent).toBe("Add entry");
            expect(view.target.querySelector(".card-url")?.textContent?.trim()).toBe(CARD_URL);
            expect(view.target.textContent).not.toContain("Security details");
            expect(view.target.textContent).not.toContain("IP address");
            expect(view.target.textContent).not.toContain("message identifiers");
        } finally {
            await view.cleanup();
            restore();
        }
    });

    it("does not render direct, group, viewer, or message identifiers in trusted card chrome", async () => {
        const restore = setCredentiallessSupport(true);
        const direct = await mountCard(card({ confirmPayload: undefined }), 1_011n, DIRECT);
        try {
            await waitForResolution();
            await vi.waitFor(() => expect(direct.target.querySelector("iframe")).not.toBeNull());
            expect(direct.target.textContent).not.toContain(VIEWER);
            expect(direct.target.textContent).not.toContain(DIRECT.userId);
            expect(direct.target.textContent).not.toContain("1011");
        } finally {
            await direct.cleanup();
        }

        mocks.resolveActionAppForCard.mockClear();
        const group = await mountCard(card({ confirmPayload: undefined }), 1_012n);
        try {
            await waitForResolution();
            await vi.waitFor(() => expect(group.target.querySelector("iframe")).not.toBeNull());
            expect(group.target.textContent).not.toContain(GROUP.groupId);
            expect(group.target.textContent).not.toContain("1012");
        } finally {
            await group.cleanup();
            restore();
        }
    });

    it("keeps unpaired private context behind one compact explicit action", async () => {
        const restore = setCredentiallessSupport(true);
        mocks.privateContextAvailable = true;
        mocks.resolveActionAppForCard.mockResolvedValue({
            ...RESOLVED_APP,
            hasPersistentUserPairing: false,
        });
        const view = await mountCard(card({ confirmPayload: undefined }), 1_013n);
        let postMessage: ReturnType<typeof vi.spyOn> | undefined;
        try {
            await waitForResolution();
            await vi.waitFor(() => expect(view.target.querySelector("iframe")).not.toBeNull());

            const ready = await completeCardReadyHandshake(view.target);
            postMessage = ready.postMessage;
            await vi.waitFor(() =>
                expect(buttonNamed(view.target, "Share app context")).toBeDefined(),
            );
            expect(view.target.querySelector("details")).toBeNull();
            expect(mocks.createAiAppCardCapability).not.toHaveBeenCalled();
            expect(postedMessageOfType(postMessage, "oc:card:private-context-request")).toBe(false);

            buttonNamed(view.target, "Share app context")?.click();
            await vi.waitFor(() =>
                expect(
                    postMessage === undefined
                        ? false
                        : postedMessageOfType(postMessage, "oc:card:private-context-request"),
                ).toBe(true),
            );
            expect(mocks.createAiAppCardCapability).not.toHaveBeenCalled();
        } finally {
            postMessage?.mockRestore();
            await view.cleanup();
            restore();
        }
    });

    it("opens a freshly proposed attested sender card without a second click", async () => {
        const restore = setCredentiallessSupport(true);
        const view = await mountCard(card(), 1_001n);
        try {
            await waitForResolution();
            await vi.waitFor(() => expect(view.target.querySelectorAll("iframe")).toHaveLength(1));

            expect(buttonNamed(view.target, "Load app card")).toBeUndefined();
            expect(view.target.querySelector("iframe")?.src).toBe(CARD_URL);
            expect(view.target.querySelector(".card-url")?.textContent?.trim()).toBe(CARD_URL);
            expect(view.target.textContent).not.toContain("Untrusted app content");
        } finally {
            await view.cleanup();
            restore();
        }
    });

    it("auto-loads after the normal optimistic sender card reconciles to backend trust", async () => {
        const restore = setCredentiallessSupport(true);
        const view = await mountCard(
            card({ appVerified: false, appContentVerified: false }),
            1_008n,
        );
        try {
            await tick();
            expect(mocks.resolveActionAppForCard).not.toHaveBeenCalled();
            expect(view.target.querySelector("iframe")).toBeNull();

            view.contentStore.set(card());
            await waitForResolution();
            await vi.waitFor(() => expect(view.target.querySelectorAll("iframe")).toHaveLength(1));
            expect(buttonNamed(view.target, "Load app card")).toBeUndefined();
        } finally {
            await view.cleanup();
            restore();
        }
    });

    it("shows directory trust but never loads content without full card attestation", async () => {
        const restore = setCredentiallessSupport(true);
        const view = await mountCard(card({ appContentVerified: false }), 1_009n);
        try {
            await waitForResolution();
            await vi.waitFor(() =>
                expect(view.target.querySelector(".app-name")?.textContent?.trim()).toBe(
                    "Generic app",
                ),
            );

            expect(view.target.querySelector("iframe")).toBeNull();
            expect(view.target.textContent).toContain(
                "Directory binding only; card content is untrusted",
            );
            expect(view.target.textContent).toContain("Untrusted card text");
            expect(view.target.textContent?.replace(/\s+/g, " ")).toContain(
                "its title, rows, and payload are not attested as app-authored",
            );
        } finally {
            await view.cleanup();
            restore();
        }
    });

    it("auto-renders recipient cards on every trusted view", async () => {
        const restore = setCredentiallessSupport(true);
        const view = await mountCard(card({ confirmPayload: undefined }), 1_002n);
        try {
            await waitForResolution();
            await vi.waitFor(() => expect(view.target.querySelectorAll("iframe")).toHaveLength(1));
            expect(buttonNamed(view.target, "Load app card")).toBeUndefined();
        } finally {
            await view.cleanup();
            restore();
        }
    });

    it("shows host rows but keeps confirmation fail-closed without credentialless support", async () => {
        const restore = setCredentiallessSupport(false);
        const view = await mountCard(card(), 1_003n);
        try {
            await waitForResolution();
            await vi.waitFor(() => expect(view.target.textContent).toContain("25"));
            expect(view.target.querySelector("iframe")).toBeNull();
            expect(buttonNamed(view.target, "Load app card")).toBeUndefined();
            expect(view.target.textContent).toContain("Secure app card unavailable");
            expect(buttonNamed(view.target, "Add")?.disabled).toBe(true);
        } finally {
            await view.cleanup();
            restore();
        }
    });

    it("never resolves or loads an optimistic or unattested card", async () => {
        const restore = setCredentiallessSupport(true);
        const view = await mountCard(
            card({ appVerified: false, appContentVerified: false }),
            1_004n,
        );
        try {
            await tick();
            expect(mocks.resolveActionAppForCard).not.toHaveBeenCalled();
            expect(view.target.querySelector("iframe")).toBeNull();
            expect(view.target.textContent).toContain("Unverified card binding");
            expect(view.target.textContent).toContain("Untrusted card text");
        } finally {
            await view.cleanup();
            restore();
        }
    });

    it("does not require the sender-only payload before rendering trusted public rows", async () => {
        const restore = setCredentiallessSupport(true);
        const view = await mountCard(card({ confirmPayload: undefined }), 1_005n);
        try {
            await waitForResolution();
            await vi.waitFor(() => expect(view.target.querySelectorAll("iframe")).toHaveLength(1));

            view.contentStore.set(card());
            await tick();
            await vi.waitFor(() => expect(view.target.querySelectorAll("iframe")).toHaveLength(1));
        } finally {
            await view.cleanup();
            restore();
        }
    });

    it("does not reset an auto-rendered card when the sender-only payload arrives late", async () => {
        const restore = setCredentiallessSupport(true);
        const view = await mountCard(card({ confirmPayload: undefined }), 1_007n);
        let postMessage: ReturnType<typeof vi.spyOn> | undefined;
        try {
            await waitForResolution();
            await vi.waitFor(() => expect(view.target.querySelector("iframe")).not.toBeNull());
            const ready = await completeCardReadyHandshake(view.target);
            postMessage = ready.postMessage;

            view.contentStore.set(card());
            await tick();

            expect(view.target.querySelector("iframe")).toBe(ready.iframe);
            expect(ready.iframe.classList.contains("inactive")).toBe(false);
            expect(view.target.textContent).not.toContain("Waiting for the isolated app");
        } finally {
            postMessage?.mockRestore();
            await view.cleanup();
            restore();
        }
    });

    it("auto-renders the same trusted card again after a remount", async () => {
        const restore = setCredentiallessSupport(true);
        const first = await mountCard(card(), 1_006n);
        try {
            await waitForResolution();
            await vi.waitFor(() => expect(first.target.querySelectorAll("iframe")).toHaveLength(1));
        } finally {
            await first.cleanup();
        }

        mocks.resolveActionAppForCard.mockClear();
        const remounted = await mountCard(card(), 1_006n);
        try {
            await waitForResolution();
            await vi.waitFor(() =>
                expect(remounted.target.querySelectorAll("iframe")).toHaveLength(1),
            );
            expect(buttonNamed(remounted.target, "Load app card")).toBeUndefined();
        } finally {
            await remounted.cleanup();
            restore();
        }
    });
});
