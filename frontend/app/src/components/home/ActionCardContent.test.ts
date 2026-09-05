import type { ActionCardContent, ChatIdentifier, OpenChat } from "@client";
import { mount, tick, unmount } from "svelte";
import { writable } from "svelte/store";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    resolveActionAppForCard: vi.fn(),
    privateContextAvailable: false,
    createAiAppCardCapability: vi.fn(),
    createAiAppCardConfirmationGrant: vi.fn(),
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
        labelToField: { Quantity: "quantity" },
    },
};

function card(overrides: Partial<ActionCardContent> = {}): ActionCardContent {
    return {
        kind: "action_card_content",
        title: "Add entry",
        rows: [{ label: "Quantity", value: "25" }],
        confirmLabel: "Add",
        cancelLabel: "Cancel",
        actionId: "generic.entry.add",
        appId: APP_ID,
        appRevision: APP_REVISION,
        appVerified: true,
        appContentVerified: true,
        confirmPayload: new TextEncoder().encode('{"quantity":25}'),
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

type PostedCardMessage = {
    type?: string;
    frameNonce?: string;
    requestNonce?: string;
    busy?: boolean;
};

function postedCardMessages(postMessage: ReturnType<typeof vi.spyOn>): PostedCardMessage[] {
    return (postMessage.mock.calls as unknown[][]).map(([message]) => message as PostedCardMessage);
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
    ) => boolean | Promise<boolean>,
) {
    const target = document.createElement("div");
    document.body.append(target);
    const contentStore = writable(initialContent);
    const reconciliationStore = writable(false);
    const chatIdStore = writable(chatId);
    const component = mount(ActionCardContentHarness, {
        target,
        props: {
            contentStore,
            reconciliationStore,
            readonly,
            chatIdStore,
            messageId,
            viewerId: VIEWER,
            onRespond,
        },
        context: new Map([
            [
                "client",
                {
                    createAiAppCardCapability: mocks.createAiAppCardCapability,
                    createAiAppCardConfirmationGrant: mocks.createAiAppCardConfirmationGrant,
                } as unknown as OpenChat,
            ],
        ]),
    });
    await tick();
    return {
        target,
        component,
        contentStore,
        reconciliationStore,
        chatIdStore,
        async cleanup() {
            await unmount(component);
            target.remove();
        },
    };
}

async function waitForResolution(): Promise<void> {
    await vi.waitFor(() => expect(mocks.resolveActionAppForCard).toHaveBeenCalled());
    // Resolution is deliberately wrapped in the shared finite-settlement guard. Let its promise
    // chain publish the resulting identity before callers inspect the frame/chrome.
    await tick();
    await tick();
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

function dispatchFromCardFrame(iframe: HTMLIFrameElement, data: unknown): void {
    window.dispatchEvent(
        new MessageEvent("message", {
            data,
            origin: "null",
            source: iframe.contentWindow,
        }),
    );
}

function latestWindowMessageListener(
    addEventListener: ReturnType<typeof vi.spyOn>,
): EventListener {
    const listener = (addEventListener.mock.calls as unknown[][])
        .filter(([type, callback]) => type === "message" && typeof callback === "function")
        .map(([, callback]) => callback as EventListener)
        .at(-1);
    if (listener === undefined) throw new Error("card bridge listener is unavailable");
    return listener;
}

beforeEach(() => {
    mocks.resolveActionAppForCard.mockReset();
    mocks.resolveActionAppForCard.mockResolvedValue(RESOLVED_APP);
    mocks.privateContextAvailable = false;
    mocks.createAiAppCardCapability.mockReset();
    mocks.createAiAppCardConfirmationGrant.mockReset();
    mocks.createAiAppCardConfirmationGrant.mockResolvedValue({
        grant: new Uint8Array([7, 8, 9]),
        expiresAt: BigInt(Date.now() + 60_000),
    });
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

    it("absorbs paired private-context restoration rejection and waits for an explicit retry", async () => {
        const restore = setCredentiallessSupport(true);
        mocks.privateContextAvailable = true;
        mocks.createAiAppCardCapability.mockRejectedValueOnce(new Error("restore rejected"));
        const view = await mountCard(card({ confirmPayload: undefined }), 1_107n);
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

            const recipientKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))
                .replaceAll("+", "-")
                .replaceAll("/", "_")
                .replaceAll("=", "");
            dispatchFromCardFrame(ready.iframe, {
                type: "oc:card:private-context-ready",
                version: 2,
                frameNonce: ready.frameNonce,
                privateContext: {
                    recipientKeyScheme: "x25519-v1",
                    recipientPublicKey: recipientKey,
                },
            });

            await vi.waitFor(() => expect(mocks.createAiAppCardCapability).toHaveBeenCalledOnce());
            await vi.waitFor(() =>
                expect(buttonNamed(view.target, "Restore app data")?.disabled).toBe(false),
            );
            await tick();
            expect(
                postedCardMessages(postMessage).filter(
                    (message) => message.type === "oc:card:private-context-request",
                ),
            ).toHaveLength(1);
            expect(view.target.textContent).not.toContain("Share app context");
        } finally {
            postMessage?.mockRestore();
            await view.cleanup();
            restore();
        }
    });

    it("times out a non-settling paired capability mint and lets a fresh Restore retry succeed", async () => {
        const restore = setCredentiallessSupport(true);
        mocks.privateContextAvailable = true;
        mocks.createAiAppCardCapability
            .mockImplementationOnce(() => new Promise(() => undefined))
            .mockResolvedValueOnce({
                capability: "fresh-retry-capability",
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
        const view = await mountCard(card({ confirmPayload: undefined }), 1_108n);
        let postMessage: ReturnType<typeof vi.spyOn> | undefined;
        let fakeTimers = false;
        try {
            await waitForResolution();
            const ready = await completeCardReadyHandshake(view.target);
            postMessage = ready.postMessage;
            await vi.waitFor(() =>
                expect(postedMessageOfType(postMessage!, "oc:card:private-context-request")).toBe(
                    true,
                ),
            );

            const recipientKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(11)))
                .replaceAll("+", "-")
                .replaceAll("/", "_")
                .replaceAll("=", "");
            vi.useFakeTimers();
            fakeTimers = true;
            dispatchFromCardFrame(ready.iframe, {
                type: "oc:card:private-context-ready",
                version: 2,
                frameNonce: ready.frameNonce,
                privateContext: {
                    recipientKeyScheme: "x25519-v1",
                    recipientPublicKey: recipientKey,
                },
            });
            await vi.advanceTimersByTimeAsync(0);
            await tick();
            expect(mocks.createAiAppCardCapability).toHaveBeenCalledOnce();
            expect(
                view.target.querySelector<HTMLButtonElement>(".private-context-action button")
                    ?.disabled,
            ).toBe(true);
            expect(buttonNamed(view.target, "Add")?.disabled).toBe(true);

            await vi.advanceTimersByTimeAsync(30_000);
            await tick();
            expect(buttonNamed(view.target, "Restore app data")?.disabled).toBe(false);
            expect(buttonNamed(view.target, "Add")?.disabled).toBe(true);

            vi.useRealTimers();
            fakeTimers = false;
            buttonNamed(view.target, "Restore app data")?.click();
            await vi.waitFor(() => {
                expect(
                    postedCardMessages(postMessage!).filter(
                        (message) => message.type === "oc:card:private-context-request",
                    ),
                ).toHaveLength(2);
            });
            dispatchFromCardFrame(ready.iframe, {
                type: "oc:card:private-context-ready",
                version: 2,
                frameNonce: ready.frameNonce,
                privateContext: {
                    recipientKeyScheme: "x25519-v1",
                    recipientPublicKey: recipientKey,
                },
            });

            await vi.waitFor(() =>
                expect(mocks.createAiAppCardCapability).toHaveBeenCalledTimes(2),
            );
            await vi.waitFor(() =>
                expect(
                    postedCardMessages(postMessage!).some(
                        (message) =>
                            message.type === "oc:card:init" &&
                            (
                                message as PostedCardMessage & {
                                    context?: { privateContext?: { capability?: string } };
                                }
                            ).context?.privateContext?.capability === "fresh-retry-capability",
                    ),
                ).toBe(true),
            );
            expect(buttonNamed(view.target, "Add")?.disabled).toBe(true);
            dispatchFromCardFrame(ready.iframe, {
                type: "oc:card:private-context-status",
                version: 2,
                frameNonce: ready.frameNonce,
                capability: "fresh-retry-capability",
                status: "ready",
            });
            await vi.waitFor(() => expect(buttonNamed(view.target, "Add")?.disabled).toBe(false));
            expect(buttonNamed(view.target, "Restore app data")).toBeUndefined();
        } finally {
            if (fakeTimers) vi.useRealTimers();
            postMessage?.mockRestore();
            await view.cleanup();
            restore();
        }
    });

    it("keeps Add disabled and exposes Restore when the exact capability reports hydration error", async () => {
        const restore = setCredentiallessSupport(true);
        mocks.privateContextAvailable = true;
        mocks.createAiAppCardCapability.mockResolvedValue({
            capability: "hydration-error-capability",
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
        const view = await mountCard(card({ confirmPayload: undefined }), 1_109n);
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
            const recipientKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(12)))
                .replaceAll("+", "-")
                .replaceAll("/", "_")
                .replaceAll("=", "");
            dispatchFromCardFrame(ready.iframe, {
                type: "oc:card:private-context-ready",
                version: 2,
                frameNonce: ready.frameNonce,
                privateContext: {
                    recipientKeyScheme: "x25519-v1",
                    recipientPublicKey: recipientKey,
                },
            });
            await vi.waitFor(() =>
                expect(
                    postedCardMessages(postMessage!).some(
                        (message) =>
                            message.type === "oc:card:init" &&
                            (
                                message as PostedCardMessage & {
                                    context?: { privateContext?: { capability?: string } };
                                }
                            ).context?.privateContext?.capability === "hydration-error-capability",
                    ),
                ).toBe(true),
            );
            expect(buttonNamed(view.target, "Add")?.disabled).toBe(true);

            dispatchFromCardFrame(ready.iframe, {
                type: "oc:card:private-context-status",
                version: 2,
                frameNonce: ready.frameNonce,
                capability: "hydration-error-capability",
                status: "error",
            });

            await vi.waitFor(() =>
                expect(buttonNamed(view.target, "Restore app data")?.disabled).toBe(false),
            );
            expect(buttonNamed(view.target, "Add")?.disabled).toBe(true);
        } finally {
            postMessage?.mockRestore();
            await view.cleanup();
            restore();
        }
    });

    it("bounds the exact capability hydration wait and exposes paired Restore after 30 seconds", async () => {
        const restore = setCredentiallessSupport(true);
        mocks.privateContextAvailable = true;
        mocks.createAiAppCardCapability.mockResolvedValue({
            capability: "hydration-timeout-capability",
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
        const view = await mountCard(card({ confirmPayload: undefined }), 1_110n);
        let postMessage: ReturnType<typeof vi.spyOn> | undefined;
        let fakeTimers = false;
        try {
            await waitForResolution();
            const ready = await completeCardReadyHandshake(view.target);
            postMessage = ready.postMessage;
            await vi.waitFor(() =>
                expect(postedMessageOfType(postMessage!, "oc:card:private-context-request")).toBe(
                    true,
                ),
            );
            const recipientKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(13)))
                .replaceAll("+", "-")
                .replaceAll("/", "_")
                .replaceAll("=", "");
            vi.useFakeTimers();
            fakeTimers = true;
            dispatchFromCardFrame(ready.iframe, {
                type: "oc:card:private-context-ready",
                version: 2,
                frameNonce: ready.frameNonce,
                privateContext: {
                    recipientKeyScheme: "x25519-v1",
                    recipientPublicKey: recipientKey,
                },
            });
            await vi.advanceTimersByTimeAsync(0);
            await tick();
            expect(mocks.createAiAppCardCapability).toHaveBeenCalledOnce();
            expect(buttonNamed(view.target, "Add")?.disabled).toBe(true);

            await vi.advanceTimersByTimeAsync(29_999);
            await tick();
            expect(buttonNamed(view.target, "Restore app data")).toBeUndefined();
            await vi.advanceTimersByTimeAsync(1);
            await tick();
            expect(buttonNamed(view.target, "Restore app data")?.disabled).toBe(false);
            expect(buttonNamed(view.target, "Add")?.disabled).toBe(true);
        } finally {
            if (fakeTimers) vi.useRealTimers();
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

    it("restores the verified sender's multi-entry payload in one editable app card", async () => {
        const restore = setCredentiallessSupport(true);
        const onRespond = vi.fn().mockResolvedValue(true);
        const messageId = 1_103n;
        mocks.resolveActionAppForCard.mockResolvedValueOnce({
            ...RESOLVED_APP,
            hasPersistentUserPairing: false,
        });
        const view = await mountCard(
            card({
                title: "Add 2 entries",
                rows: [
                    { label: "Entry 1", value: "Sample · 25 paper" },
                    { label: "Entry 2", value: "Specimen · 10 paper" },
                ],
                confirmPayload: new TextEncoder().encode('[{"quantity":25},{"quantity":10}]'),
            }),
            messageId,
            GROUP,
            false,
            onRespond,
        );
        let postMessage: ReturnType<typeof vi.spyOn> | undefined;
        try {
            await waitForResolution();
            await vi.waitFor(() => expect(view.target.querySelectorAll("iframe")).toHaveLength(1));
            expect(view.target.querySelector(".action-card")?.classList.contains("has-frame")).toBe(
                true,
            );
            const ready = await completeCardReadyHandshake(view.target);
            postMessage = ready.postMessage;
            const init = (postMessage.mock.calls as unknown[][])
                .map(([message]) => message as { type?: string; data?: unknown })
                .find((message) => message.type === "oc:card:init");
            expect(init?.data).toEqual({ entries: [{ quantity: 25 }, { quantity: 10 }] });

            await vi.waitFor(() => expect(buttonNamed(view.target, "Add")?.disabled).toBe(false));
            buttonNamed(view.target, "Add")?.click();
            await vi.waitFor(() =>
                expect(
                    postedCardMessages(postMessage!).filter(
                        (message) => message.type === "oc:card:collect-confirm",
                    ),
                ).toHaveLength(1),
            );
            const collect = postedCardMessages(postMessage).find(
                (message) => message.type === "oc:card:collect-confirm",
            );
            const editedPayload = [
                { quantity: 26, description: "edited first" },
                { quantity: 11, description: "edited second" },
            ];
            dispatchFromCardFrame(ready.iframe, {
                type: "oc:card:confirm-collected",
                version: 2,
                frameNonce: ready.frameNonce,
                requestNonce: collect?.requestNonce,
                payload: editedPayload,
            });

            const exactBytes = new TextEncoder().encode(JSON.stringify(editedPayload));
            await vi.waitFor(() =>
                expect(mocks.createAiAppCardConfirmationGrant).toHaveBeenCalledOnce(),
            );
            expect(mocks.createAiAppCardConfirmationGrant).toHaveBeenCalledWith(
                GROUP,
                undefined,
                messageId,
                exactBytes,
            );
            await vi.waitFor(() => expect(onRespond).toHaveBeenCalledOnce());
            expect(onRespond).toHaveBeenCalledWith(
                "confirm",
                exactBytes,
                new Uint8Array([7, 8, 9]),
            );
        } finally {
            postMessage?.mockRestore();
            await view.cleanup();
            restore();
        }
    });

    it("reconstructs a received or reloaded canonical multi card as one editable app card", async () => {
        const restore = setCredentiallessSupport(true);
        const onRespond = vi.fn().mockResolvedValue(true);
        mocks.resolveActionAppForCard.mockResolvedValueOnce({
            ...RESOLVED_APP,
            hasPersistentUserPairing: false,
            cardSurface: {
                ...RESOLVED_APP.cardSurface,
                labelToField: {
                    Quantity: "quantity",
                    Material: "material",
                    Type: "kind",
                    Location: "location",
                    Observed: "observedAt",
                    Description: "description",
                },
            },
        });
        const view = await mountCard(
            card({
                title: "Add to Notebook (2 entries)",
                rows: [
                    {
                        label: "Entry 1",
                        value: "Quantity: 200 · Type: specimen · Location: indoor · Description: fern",
                    },
                    {
                        label: "Entry 2",
                        value: "Quantity: 400 · Material: paper · Type: sample · Location: outdoor · Description: moss",
                    },
                ],
                confirmPayload: undefined,
            }),
            1_106n,
            GROUP,
            false,
            onRespond,
        );
        let postMessage: ReturnType<typeof vi.spyOn> | undefined;
        try {
            await waitForResolution();
            await vi.waitFor(() => expect(view.target.querySelectorAll("iframe")).toHaveLength(1));
            const ready = await completeCardReadyHandshake(view.target);
            postMessage = ready.postMessage;
            const init = (postMessage.mock.calls as unknown[][])
                .map(([message]) => message as { type?: string; data?: unknown })
                .find((message) => message.type === "oc:card:init");
            expect(init?.data).toEqual({
                entries: [
                    { quantity: "200", kind: "specimen", location: "indoor", description: "fern" },
                    {
                        quantity: "400",
                        material: "paper",
                        kind: "sample",
                        location: "outdoor",
                        description: "moss",
                    },
                ],
            });
            expect(view.target.textContent).not.toContain("Entry 1\t");

            await vi.waitFor(() => expect(buttonNamed(view.target, "Add")?.disabled).toBe(false));
            buttonNamed(view.target, "Add")?.click();
            await vi.waitFor(() =>
                expect(
                    postedCardMessages(postMessage!).filter(
                        (message) => message.type === "oc:card:collect-confirm",
                    ),
                ).toHaveLength(1),
            );
            const collect = postedCardMessages(postMessage).find(
                (message) => message.type === "oc:card:collect-confirm",
            );
            const editedPayload = [
                { quantity: 210, kind: "specimen", location: "indoor", description: "edited fern" },
                {
                    quantity: 410,
                    material: "paper",
                    kind: "sample",
                    location: "outdoor",
                    description: "edited moss",
                },
            ];
            dispatchFromCardFrame(ready.iframe, {
                type: "oc:card:confirm-collected",
                version: 2,
                frameNonce: ready.frameNonce,
                requestNonce: collect?.requestNonce,
                payload: editedPayload,
            });

            const exactBytes = new TextEncoder().encode(JSON.stringify(editedPayload));
            await vi.waitFor(() =>
                expect(mocks.createAiAppCardConfirmationGrant).toHaveBeenCalledOnce(),
            );
            expect(mocks.createAiAppCardConfirmationGrant).toHaveBeenCalledWith(
                GROUP,
                undefined,
                1_106n,
                exactBytes,
            );
            await vi.waitFor(() => expect(onRespond).toHaveBeenCalledOnce());
            expect(onRespond).toHaveBeenCalledWith(
                "confirm",
                exactBytes,
                new Uint8Array([7, 8, 9]),
            );
        } finally {
            postMessage?.mockRestore();
            await view.cleanup();
            restore();
        }
    });

    it("shows a stable neutral shell instead of unverified sender content before acknowledgement", async () => {
        const restore = setCredentiallessSupport(true);
        const view = await mountCard(
            card({
                appVerified: false,
                appContentVerified: false,
                appProvenance: new Uint8Array([1, 2, 3]),
            }),
            1_022n,
        );
        try {
            await tick();
            expect(view.target.querySelector(".action-card.pending-verification")).not.toBeNull();
            expect(view.target.textContent).toContain("Preparing verified card");
            expect(view.target.textContent).not.toContain("Unverified card binding");
            expect(view.target.textContent).not.toContain("Untrusted card text");
            expect(view.target.textContent).not.toContain("Add entry");
            expect(view.target.textContent).not.toContain("25");
        } finally {
            await view.cleanup();
            restore();
        }
    });

    it("keeps a failed stored-card confirm retryable and latches only the later success", async () => {
        const restore = setCredentiallessSupport(true);
        const onRespond = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const view = await mountCard(
            card({
                rows: [
                    { label: "Entry 1", value: "Sample Â· 25 paper" },
                    { label: "Entry 2", value: "Specimen Â· 10 paper" },
                ],
                // Received/reloaded cards intentionally do not hydrate the sender-only payload,
                // so they retain the host-owned stored-card confirmation path.
                confirmPayload: undefined,
            }),
            1_104n,
            GROUP,
            false,
            onRespond,
        );
        try {
            await waitForResolution();
            await vi.waitFor(() => expect(buttonNamed(view.target, "Add")?.disabled).toBe(false));

            buttonNamed(view.target, "Add")?.click();
            await vi.waitFor(() => expect(onRespond).toHaveBeenCalledOnce());
            await vi.waitFor(() => expect(buttonNamed(view.target, "Add")?.disabled).toBe(false));

            buttonNamed(view.target, "Add")?.click();
            await vi.waitFor(() => expect(onRespond).toHaveBeenCalledTimes(2));
            await vi.waitFor(() => expect(buttonNamed(view.target, "Add")?.disabled).toBe(true));
        } finally {
            await view.cleanup();
            restore();
        }
    });

    it("keeps the resolved frame session when chat props are replaced by an equivalent object", async () => {
        const restore = setCredentiallessSupport(true);
        const view = await mountCard(card(), 1_105n);
        let postMessage: ReturnType<typeof vi.spyOn> | undefined;
        try {
            await waitForResolution();
            const ready = await completeCardReadyHandshake(view.target);
            postMessage = ready.postMessage;
            expect(mocks.resolveActionAppForCard).toHaveBeenCalledOnce();

            view.chatIdStore.set({ kind: "group_chat", groupId: "aaaaa-aa" });
            await tick();

            expect(mocks.resolveActionAppForCard).toHaveBeenCalledOnce();
            expect(view.target.querySelector("iframe")).toBe(ready.iframe);
            expect(ready.iframe.classList.contains("inactive")).toBe(false);
        } finally {
            postMessage?.mockRestore();
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

    it("keeps an unpaired card public-only and leaves linking to chat settings", async () => {
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
            await tick();
            expect(buttonNamed(view.target, "Share app context")).toBeUndefined();
            expect(buttonNamed(view.target, "Restore app data")).toBeUndefined();
            expect(view.target.querySelector("details")).toBeNull();
            expect(mocks.createAiAppCardCapability).not.toHaveBeenCalled();
            expect(postedMessageOfType(postMessage, "oc:card:private-context-request")).toBe(false);
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

    it("re-evaluates an in-place trust mutation on the authoritative edge without remounting", async () => {
        const restore = setCredentiallessSupport(true);
        const optimistic = card({ appVerified: false, appContentVerified: false });
        const view = await mountCard(optimistic, 1_018n);
        try {
            await tick();
            const mountedCard = view.target.querySelector(".action-card");
            expect(mountedCard).not.toBeNull();
            expect(mocks.resolveActionAppForCard).not.toHaveBeenCalled();
            expect(view.target.querySelector("iframe")).toBeNull();

            optimistic.appVerified = true;
            optimistic.appContentVerified = true;
            view.reconciliationStore.set(true);
            await waitForResolution();
            await vi.waitFor(() => expect(view.target.querySelectorAll("iframe")).toHaveLength(1));

            expect(view.target.querySelector(".action-card")).toBe(mountedCard);
        } finally {
            await view.cleanup();
            restore();
        }
    });

    it("bounds a hung app lookup and lets an explicit verification retry resolve", async () => {
        const restore = setCredentiallessSupport(true);
        mocks.resolveActionAppForCard
            .mockImplementationOnce(() => new Promise(() => undefined))
            .mockResolvedValueOnce(RESOLVED_APP);
        vi.useFakeTimers();
        const view = await mountCard(card(), 1_019n);
        try {
            expect(mocks.resolveActionAppForCard).toHaveBeenCalledOnce();
            expect(view.target.textContent).toContain("Verifying app identity");

            await vi.advanceTimersByTimeAsync(30_000);
            await tick();
            expect(view.target.textContent).not.toContain("Verifying app identity");
            const retry = buttonNamed(view.target, "Retry verification");
            expect(retry).toBeDefined();

            retry?.click();
            await vi.advanceTimersByTimeAsync(0);
            await tick();
            await tick();
            expect(mocks.resolveActionAppForCard).toHaveBeenCalledTimes(2);
            expect(view.target.querySelectorAll("iframe")).toHaveLength(1);
        } finally {
            await view.cleanup();
            vi.useRealTimers();
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

    it.each(["confirmed", "cancelled", "expired"] as const)(
        "preserves backend-attested terminal evidence when current app details do not resolve: %s",
        async (state) => {
            const restore = setCredentiallessSupport(true);
            mocks.resolveActionAppForCard.mockResolvedValue(undefined);
            const view = await mountCard(card({ state }), 1_004n);
            try {
                await waitForResolution();
                await vi.waitFor(() =>
                    expect(view.target.textContent).toContain("Verified terminal card"),
                );

                expect(view.target.textContent).toContain(
                    `Original app ${APP_ID} · revision ${APP_REVISION}`,
                );
                expect(view.target.textContent).not.toContain("Unverified card binding");
                expect(view.target.querySelector(".app-identity.unverified")).toBeNull();
                expect(buttonNamed(view.target, "Retry current app details")).toBeDefined();
                expect(view.target.querySelector("iframe")).toBeNull();
                expect(buttonNamed(view.target, "Add")).toBeUndefined();
            } finally {
                await view.cleanup();
                restore();
            }
        },
    );

    it("keeps a pending card fail-closed when current app details do not resolve", async () => {
        const restore = setCredentiallessSupport(true);
        mocks.resolveActionAppForCard.mockResolvedValue(undefined);
        const view = await mountCard(card(), 1_004n);
        try {
            await waitForResolution();
            await vi.waitFor(() =>
                expect(view.target.textContent).toContain("Unverified card binding"),
            );

            expect(view.target.textContent).not.toContain("Verified terminal card");
            expect(view.target.querySelector(".app-identity.unverified")).not.toBeNull();
            expect(buttonNamed(view.target, "Retry verification")).toBeDefined();
            expect(view.target.querySelector("iframe")).toBeNull();
            expect(buttonNamed(view.target, "Add")?.disabled).toBe(true);
        } finally {
            await view.cleanup();
            restore();
        }
    });

    it("does not turn an unattested terminal card into verified historical evidence", async () => {
        const restore = setCredentiallessSupport(true);
        const view = await mountCard(
            card({ state: "cancelled", appContentVerified: false }),
            1_004n,
        );
        try {
            await waitForResolution();
            await vi.waitFor(() =>
                expect(view.target.textContent).toContain("Directory binding only"),
            );

            expect(view.target.textContent).not.toContain("Verified terminal card");
            expect(view.target.textContent).toContain("Untrusted card text");
            expect(view.target.querySelector("iframe")).toBeNull();
            expect(buttonNamed(view.target, "Add")).toBeUndefined();
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

    it("ignores a late bridge message after iframe teardown and preserves exact frame checks after remount", async () => {
        const restore = setCredentiallessSupport(true);
        const addEventListener = vi.spyOn(window, "addEventListener");
        const first = await mountCard(card(), 1_008n);
        let firstPostMessage: ReturnType<typeof vi.spyOn> | undefined;
        let remounted:
            | Awaited<ReturnType<typeof mountCard>>
            | undefined;
        let remountedPostMessage: ReturnType<typeof vi.spyOn> | undefined;
        try {
            await waitForResolution();
            const firstReady = await completeCardReadyHandshake(first.target);
            firstPostMessage = firstReady.postMessage;
            const firstFrameWindow = firstReady.iframe.contentWindow;
            if (firstFrameWindow === null) throw new Error("first card frame is unavailable");
            const firstListener = latestWindowMessageListener(addEventListener);

            // A terminal transition collapses and removes the iframe while the card component and
            // its bridge listener are still alive. A queued message from that former WindowProxy is
            // untrusted noise, not an exception.
            first.contentStore.set(card({ state: "confirmed" }));
            await tick();
            expect(first.target.querySelector("iframe")).toBeNull();
            expect(() =>
                firstListener(
                    new MessageEvent("message", {
                        data: {
                            type: "oc:card:resize",
                            version: 2,
                            frameNonce: firstReady.frameNonce,
                            height: 777,
                        },
                        origin: "null",
                        source: firstFrameWindow,
                    }),
                ),
            ).not.toThrow();

            await first.cleanup();
            firstPostMessage.mockRestore();
            firstPostMessage = undefined;

            mocks.resolveActionAppForCard.mockClear();
            remounted = await mountCard(card(), 1_008n);
            await waitForResolution();
            const remountedReady = await completeCardReadyHandshake(remounted.target);
            remountedPostMessage = remountedReady.postMessage;
            const remountedFrameWindow = remountedReady.iframe.contentWindow;
            if (remountedFrameWindow === null)
                throw new Error("remounted card frame is unavailable");
            const remountedListener = latestWindowMessageListener(addEventListener);
            const initialHeight = remountedReady.iframe.style.height;

            // Even with the remounted frame's current nonce and required opaque origin, the former
            // WindowProxy cannot control it.
            remountedListener(
                new MessageEvent("message", {
                    data: {
                        type: "oc:card:resize",
                        version: 2,
                        frameNonce: remountedReady.frameNonce,
                        height: 777,
                    },
                    origin: "null",
                    source: firstFrameWindow,
                }),
            );
            await tick();
            expect(remountedReady.iframe.style.height).toBe(initialHeight);

            // The current WindowProxy is still insufficient without the exact opaque origin and
            // fresh nonce.
            for (const [origin, frameNonce] of [
                ["https://app.example", remountedReady.frameNonce],
                ["null", `${remountedReady.frameNonce}-stale`],
            ] as const) {
                remountedListener(
                    new MessageEvent("message", {
                        data: {
                            type: "oc:card:resize",
                            version: 2,
                            frameNonce,
                            height: 777,
                        },
                        origin,
                        source: remountedFrameWindow,
                    }),
                );
            }
            await tick();
            expect(remountedReady.iframe.style.height).toBe(initialHeight);

            remountedListener(
                new MessageEvent("message", {
                    data: {
                        type: "oc:card:resize",
                        version: 2,
                        frameNonce: remountedReady.frameNonce,
                        height: 777,
                    },
                    origin: "null",
                    source: remountedFrameWindow,
                }),
            );
            await tick();
            expect(remountedReady.iframe.style.height).toBe("777px");
        } finally {
            remountedPostMessage?.mockRestore();
            if (remounted !== undefined) await remounted.cleanup();
            firstPostMessage?.mockRestore();
            if (first.target.isConnected) await first.cleanup();
            addEventListener.mockRestore();
            restore();
        }
    });
});

describe("host-initiated one-click iframe confirmation", () => {
    beforeEach(() => {
        // Most confirmation mechanics are deliberately exercised on the public-only path. Paired
        // readiness has its own focused test below and must not make unrelated grant/retry tests
        // manufacture a private capability.
        mocks.resolveActionAppForCard.mockResolvedValue({
            ...RESOLVED_APP,
            hasPersistentUserPairing: false,
        });
    });

    it("keeps paired Add disabled until private capability restoration completes", async () => {
        const restore = setCredentiallessSupport(true);
        mocks.privateContextAvailable = true;
        mocks.resolveActionAppForCard.mockResolvedValue(RESOLVED_APP);
        type Capability = {
            capability: string;
            expiresAt: bigint;
            context: {
                contextVersion: number;
                appSubject: string;
                chatHandle: string;
                messageHandle: string;
                appId: number;
                appRevision: bigint;
                actionId: string;
            };
        };
        let resolveCapability: (capability: Capability) => void = () => undefined;
        mocks.createAiAppCardCapability.mockImplementationOnce(
            () =>
                new Promise<Capability>((resolve) => {
                    resolveCapability = resolve;
                }),
        );
        const view = await mountCard(card({ confirmPayload: undefined }), 1_210n);
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
            expect(buttonNamed(view.target, "Add")?.disabled).toBe(true);
            buttonNamed(view.target, "Add")?.click();
            expect(postedMessageOfType(postMessage, "oc:card:collect-confirm")).toBe(false);

            const recipientKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)))
                .replaceAll("+", "-")
                .replaceAll("/", "_")
                .replaceAll("=", "");
            dispatchFromCardFrame(ready.iframe, {
                type: "oc:card:private-context-ready",
                version: 2,
                frameNonce: ready.frameNonce,
                privateContext: {
                    recipientKeyScheme: "x25519-v1",
                    recipientPublicKey: recipientKey,
                },
            });
            await vi.waitFor(() => expect(mocks.createAiAppCardCapability).toHaveBeenCalledOnce());
            expect(buttonNamed(view.target, "Add")?.disabled).toBe(true);

            resolveCapability({
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
            await vi.waitFor(() =>
                expect(
                    postedCardMessages(postMessage!).some(
                        (message) =>
                            message.type === "oc:card:init" &&
                            (
                                message as PostedCardMessage & {
                                    context?: { privateContext?: { capability?: string } };
                                }
                            ).context?.privateContext?.capability === "opaque-capability",
                    ),
                ).toBe(true),
            );
            expect(buttonNamed(view.target, "Add")?.disabled).toBe(true);
            dispatchFromCardFrame(ready.iframe, {
                type: "oc:card:private-context-status",
                version: 2,
                frameNonce: ready.frameNonce,
                capability: "opaque-capability",
                status: "ready",
            });
            await vi.waitFor(() => expect(buttonNamed(view.target, "Add")?.disabled).toBe(false));
            buttonNamed(view.target, "Add")?.click();
            await vi.waitFor(() =>
                expect(
                    postedCardMessages(postMessage!).filter(
                        (message) => message.type === "oc:card:collect-confirm",
                    ),
                ).toHaveLength(1),
            );
        } finally {
            postMessage?.mockRestore();
            await view.cleanup();
            restore();
        }
    });

    it("keeps an unpaired card one-click confirmable without private sharing", async () => {
        const restore = setCredentiallessSupport(true);
        mocks.privateContextAvailable = true;
        const view = await mountCard(card({ confirmPayload: undefined }), 1_211n);
        let postMessage: ReturnType<typeof vi.spyOn> | undefined;
        try {
            await waitForResolution();
            const ready = await completeCardReadyHandshake(view.target);
            postMessage = ready.postMessage;
            await vi.waitFor(() => expect(buttonNamed(view.target, "Add")?.disabled).toBe(false));
            expect(postedMessageOfType(postMessage, "oc:card:private-context-request")).toBe(false);
            expect(buttonNamed(view.target, "Share app context")).toBeUndefined();

            buttonNamed(view.target, "Add")?.click();
            await vi.waitFor(() =>
                expect(
                    postedCardMessages(postMessage!).filter(
                        (message) => message.type === "oc:card:collect-confirm",
                    ),
                ).toHaveLength(1),
            );
        } finally {
            postMessage?.mockRestore();
            await view.cleanup();
            restore();
        }
    });

    it("fails closed with a clear status when a paired browser cannot restore private data", async () => {
        const restore = setCredentiallessSupport(true);
        mocks.privateContextAvailable = false;
        mocks.resolveActionAppForCard.mockResolvedValue(RESOLVED_APP);
        const view = await mountCard(card({ confirmPayload: undefined }), 1_212n);
        try {
            await waitForResolution();
            await completeCardReadyHandshake(view.target);
            await vi.waitFor(() => expect(buttonNamed(view.target, "Add")?.disabled).toBe(true));
            expect(view.target.textContent).toContain(
                "Saved app data is unavailable in this browser. Confirmation is disabled.",
            );
            expect(buttonNamed(view.target, "Restore app data")).toBeUndefined();
        } finally {
            await view.cleanup();
            restore();
        }
    });

    it("collects only after the host Add click, grants the exact bytes, and submits without a second approval", async () => {
        const restore = setCredentiallessSupport(true);
        const onRespond = vi.fn().mockResolvedValue(true);
        const messageId = 1_200n;
        const view = await mountCard(
            card({ confirmPayload: undefined }),
            messageId,
            GROUP,
            false,
            onRespond,
        );
        let postMessage: ReturnType<typeof vi.spyOn> | undefined;
        try {
            await waitForResolution();
            await vi.waitFor(() => expect(view.target.querySelector("iframe")).not.toBeNull());
            expect(buttonNamed(view.target, "Add")).toBeUndefined();

            const ready = await completeCardReadyHandshake(view.target);
            postMessage = ready.postMessage;
            await vi.waitFor(() => expect(buttonNamed(view.target, "Add")).toBeDefined());
            expect(view.target.textContent).not.toContain("The app requests confirmation");
            expect(buttonNamed(view.target, "Confirm request")).toBeUndefined();

            buttonNamed(view.target, "Add")?.click();
            await vi.waitFor(() =>
                expect(
                    postedCardMessages(postMessage!).some(
                        (message) => message.type === "oc:card:collect-confirm",
                    ),
                ).toBe(true),
            );
            const collect = postedCardMessages(postMessage!).find(
                (message) => message.type === "oc:card:collect-confirm",
            );
            expect(collect?.frameNonce).toBe(ready.frameNonce);
            expect(collect?.requestNonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(mocks.createAiAppCardConfirmationGrant).not.toHaveBeenCalled();

            const payload = { quantity: 25, opaque_ref: "opaque-private-reference" };
            dispatchFromCardFrame(ready.iframe, {
                type: "oc:card:confirm-collected",
                version: 2,
                frameNonce: ready.frameNonce,
                requestNonce: collect?.requestNonce,
                payload,
            });

            const exactBytes = new TextEncoder().encode(JSON.stringify(payload));
            await vi.waitFor(() =>
                expect(mocks.createAiAppCardConfirmationGrant).toHaveBeenCalledOnce(),
            );
            expect(mocks.createAiAppCardConfirmationGrant).toHaveBeenCalledWith(
                GROUP,
                undefined,
                messageId,
                exactBytes,
            );
            await vi.waitFor(() => expect(onRespond).toHaveBeenCalledOnce());
            expect(onRespond).toHaveBeenCalledWith(
                "confirm",
                exactBytes,
                new Uint8Array([7, 8, 9]),
            );
            expect(buttonNamed(view.target, "Confirm request")).toBeUndefined();
            await vi.waitFor(() => expect(buttonNamed(view.target, "Add")?.disabled).toBe(true));

            buttonNamed(view.target, "Add")?.click();
            await tick();
            expect(
                postedCardMessages(postMessage).filter(
                    (message) => message.type === "oc:card:collect-confirm",
                ),
            ).toHaveLength(1);

            // The host consumes the request before async grant minting; replaying an exact response
            // cannot mint or submit a second time.
            dispatchFromCardFrame(ready.iframe, {
                type: "oc:card:confirm-collected",
                version: 2,
                frameNonce: ready.frameNonce,
                requestNonce: collect?.requestNonce,
                payload,
            });
            await tick();
            expect(mocks.createAiAppCardConfirmationGrant).toHaveBeenCalledOnce();
            expect(onRespond).toHaveBeenCalledOnce();
        } finally {
            postMessage?.mockRestore();
            await view.cleanup();
            restore();
        }
    });

    it("ignores unsolicited, legacy, and wrong-challenge iframe confirms", async () => {
        const restore = setCredentiallessSupport(true);
        const onRespond = vi.fn();
        const view = await mountCard(
            card({ confirmPayload: undefined }),
            1_201n,
            GROUP,
            false,
            onRespond,
        );
        let postMessage: ReturnType<typeof vi.spyOn> | undefined;
        try {
            await waitForResolution();
            const ready = await completeCardReadyHandshake(view.target);
            postMessage = ready.postMessage;

            dispatchFromCardFrame(ready.iframe, {
                type: "oc:card:confirm",
                version: 2,
                frameNonce: ready.frameNonce,
                payload: { quantity: 999 },
            });
            dispatchFromCardFrame(ready.iframe, {
                type: "oc:card:confirm-collected",
                version: 2,
                frameNonce: ready.frameNonce,
                requestNonce: "A".repeat(43),
                payload: { quantity: 999 },
            });
            await tick();
            expect(mocks.createAiAppCardConfirmationGrant).not.toHaveBeenCalled();
            expect(onRespond).not.toHaveBeenCalled();

            buttonNamed(view.target, "Add")?.click();
            await vi.waitFor(() =>
                expect(
                    postedCardMessages(postMessage!).some(
                        (message) => message.type === "oc:card:collect-confirm",
                    ),
                ).toBe(true),
            );
            const collect = postedCardMessages(postMessage!).find(
                (message) => message.type === "oc:card:collect-confirm",
            );
            dispatchFromCardFrame(ready.iframe, {
                type: "oc:card:confirm-collected",
                version: 2,
                frameNonce: ready.frameNonce,
                requestNonce: `${collect?.requestNonce}wrong`,
                payload: { quantity: 999 },
            });
            await tick();
            expect(mocks.createAiAppCardConfirmationGrant).not.toHaveBeenCalled();
            expect(onRespond).not.toHaveBeenCalled();
        } finally {
            postMessage?.mockRestore();
            await view.cleanup();
            restore();
        }
    });

    it("unfreezes after a rejected exact grant and permits a fresh one-click retry", async () => {
        const restore = setCredentiallessSupport(true);
        mocks.createAiAppCardConfirmationGrant.mockRejectedValueOnce(new Error("network rejected"));
        const onRespond = vi.fn();
        const view = await mountCard(
            card({ confirmPayload: undefined }),
            1_202n,
            GROUP,
            false,
            onRespond,
        );
        let postMessage: ReturnType<typeof vi.spyOn> | undefined;
        try {
            await waitForResolution();
            const ready = await completeCardReadyHandshake(view.target);
            postMessage = ready.postMessage;

            buttonNamed(view.target, "Add")?.click();
            await vi.waitFor(() =>
                expect(
                    postedCardMessages(postMessage!).filter(
                        (message) => message.type === "oc:card:collect-confirm",
                    ),
                ).toHaveLength(1),
            );
            const first = postedCardMessages(postMessage).find(
                (message) => message.type === "oc:card:collect-confirm",
            )!;
            dispatchFromCardFrame(ready.iframe, {
                type: "oc:card:confirm-collected",
                version: 2,
                frameNonce: ready.frameNonce,
                requestNonce: first.requestNonce,
                payload: { quantity: 25 },
            });
            await vi.waitFor(() =>
                expect(view.target.textContent).toContain("Confirmation failed. Try again."),
            );
            await vi.waitFor(() => expect(buttonNamed(view.target, "Add")?.disabled).toBe(false));
            const busySignals = () =>
                postedCardMessages(postMessage!)
                    .filter((message) => message.type === "oc:card:busy")
                    .map((message) => message.busy);
            await vi.waitFor(() => expect(busySignals().slice(-2)).toEqual([true, false]));

            mocks.createAiAppCardConfirmationGrant.mockResolvedValueOnce({
                grant: new Uint8Array([4, 5, 6]),
                expiresAt: BigInt(Date.now() + 60_000),
            });
            buttonNamed(view.target, "Add")?.click();
            await vi.waitFor(() =>
                expect(
                    postedCardMessages(postMessage!).filter(
                        (message) => message.type === "oc:card:collect-confirm",
                    ),
                ).toHaveLength(2),
            );
            const requests = postedCardMessages(postMessage).filter(
                (message) => message.type === "oc:card:collect-confirm",
            );
            expect(requests[1].requestNonce).not.toBe(requests[0].requestNonce);
            dispatchFromCardFrame(ready.iframe, {
                type: "oc:card:confirm-collected",
                version: 2,
                frameNonce: ready.frameNonce,
                requestNonce: requests[1].requestNonce,
                payload: { quantity: 25 },
            });
            await vi.waitFor(() => expect(onRespond).toHaveBeenCalledOnce());
        } finally {
            postMessage?.mockRestore();
            await view.cleanup();
            restore();
        }
    });

    it("invalidates in-flight confirmation on frame reset or final card state and ignores late grants", async () => {
        const restore = setCredentiallessSupport(true);
        type Grant = {
            grant: Uint8Array;
            expiresAt: bigint;
        };
        let resolveOldGrant: (grant: Grant) => void = () => undefined;
        let resolveNewGrant: (grant: Grant) => void = () => undefined;
        mocks.createAiAppCardConfirmationGrant
            .mockImplementationOnce(
                () =>
                    new Promise<Grant>((resolve) => {
                        resolveOldGrant = resolve;
                    }),
            )
            .mockImplementationOnce(
                () =>
                    new Promise<Grant>((resolve) => {
                        resolveNewGrant = resolve;
                    }),
            );
        const onRespond = vi.fn();
        const view = await mountCard(
            card({ confirmPayload: undefined }),
            1_206n,
            GROUP,
            false,
            onRespond,
        );
        let postMessage: ReturnType<typeof vi.spyOn> | undefined;
        try {
            await waitForResolution();
            const ready = await completeCardReadyHandshake(view.target);
            postMessage = ready.postMessage;

            buttonNamed(view.target, "Add")?.click();
            await tick();
            const firstCollect = postedCardMessages(postMessage).find(
                (message) => message.type === "oc:card:collect-confirm",
            )!;
            dispatchFromCardFrame(ready.iframe, {
                type: "oc:card:confirm-collected",
                version: 2,
                frameNonce: ready.frameNonce,
                requestNonce: firstCollect.requestNonce,
                payload: { quantity: 25 },
            });
            await vi.waitFor(() =>
                expect(mocks.createAiAppCardConfirmationGrant).toHaveBeenCalledOnce(),
            );

            ready.iframe.dispatchEvent(new Event("load"));
            await vi.waitFor(() =>
                expect(
                    postedCardMessages(postMessage!).some(
                        (message) =>
                            message.type === "oc:card:bootstrap" &&
                            message.frameNonce !== ready.frameNonce,
                    ),
                ).toBe(true),
            );
            const nextFrameNonce = postedCardMessages(postMessage)
                .filter((message) => message.type === "oc:card:bootstrap")
                .at(-1)?.frameNonce;
            dispatchFromCardFrame(ready.iframe, {
                type: "oc:card:ready",
                version: 2,
                frameNonce: nextFrameNonce,
            });
            await vi.waitFor(() => expect(buttonNamed(view.target, "Add")?.disabled).toBe(false));

            resolveOldGrant({
                grant: new Uint8Array([1, 2, 3]),
                expiresAt: BigInt(Date.now() + 60_000),
            });
            await tick();
            expect(onRespond).not.toHaveBeenCalled();

            buttonNamed(view.target, "Add")?.click();
            await vi.waitFor(() =>
                expect(
                    postedCardMessages(postMessage!).filter(
                        (message) => message.type === "oc:card:collect-confirm",
                    ),
                ).toHaveLength(2),
            );
            const secondCollect = postedCardMessages(postMessage)
                .filter((message) => message.type === "oc:card:collect-confirm")
                .at(-1)!;
            dispatchFromCardFrame(ready.iframe, {
                type: "oc:card:confirm-collected",
                version: 2,
                frameNonce: nextFrameNonce,
                requestNonce: secondCollect.requestNonce,
                payload: { quantity: 30 },
            });
            await vi.waitFor(() =>
                expect(mocks.createAiAppCardConfirmationGrant).toHaveBeenCalledTimes(2),
            );

            view.contentStore.set(card({ confirmPayload: undefined, state: "cancelled" }));
            await tick();
            expect(view.target.textContent).toContain("cancelled");
            resolveNewGrant({
                grant: new Uint8Array([4, 5, 6]),
                expiresAt: BigInt(Date.now() + 60_000),
            });
            await tick();
            expect(onRespond).not.toHaveBeenCalled();
        } finally {
            postMessage?.mockRestore();
            await view.cleanup();
            restore();
        }
    });

    it("bounds a never-settling grant, unfreezes the frame, and allows a fresh retry", async () => {
        const restore = setCredentiallessSupport(true);
        mocks.createAiAppCardConfirmationGrant.mockImplementationOnce(
            () => new Promise(() => undefined),
        );
        const onRespond = vi.fn();
        const view = await mountCard(
            card({ confirmPayload: undefined }),
            1_204n,
            GROUP,
            false,
            onRespond,
        );
        let postMessage: ReturnType<typeof vi.spyOn> | undefined;
        try {
            await waitForResolution();
            const ready = await completeCardReadyHandshake(view.target);
            postMessage = ready.postMessage;
            vi.useFakeTimers();

            buttonNamed(view.target, "Add")?.click();
            await tick();
            const first = postedCardMessages(postMessage).find(
                (message) => message.type === "oc:card:collect-confirm",
            )!;
            dispatchFromCardFrame(ready.iframe, {
                type: "oc:card:confirm-collected",
                version: 2,
                frameNonce: ready.frameNonce,
                requestNonce: first.requestNonce,
                payload: { quantity: 25 },
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(mocks.createAiAppCardConfirmationGrant).toHaveBeenCalledOnce();

            await vi.advanceTimersByTimeAsync(30_000);
            await tick();
            expect(view.target.textContent).toContain("Confirmation failed. Try again.");
            expect(buttonNamed(view.target, "Add")?.disabled).toBe(false);
            expect(
                postedCardMessages(postMessage)
                    .filter((message) => message.type === "oc:card:busy")
                    .map((message) => message.busy)
                    .slice(-2),
            ).toEqual([true, false]);

            vi.useRealTimers();
            mocks.createAiAppCardConfirmationGrant.mockResolvedValueOnce({
                grant: new Uint8Array([4, 5, 6]),
                expiresAt: BigInt(Date.now() + 60_000),
            });
            buttonNamed(view.target, "Add")?.click();
            await vi.waitFor(() =>
                expect(
                    postedCardMessages(postMessage!).filter(
                        (message) => message.type === "oc:card:collect-confirm",
                    ),
                ).toHaveLength(2),
            );
            const requests = postedCardMessages(postMessage).filter(
                (message) => message.type === "oc:card:collect-confirm",
            );
            expect(requests[1].requestNonce).not.toBe(requests[0].requestNonce);
            dispatchFromCardFrame(ready.iframe, {
                type: "oc:card:confirm-collected",
                version: 2,
                frameNonce: ready.frameNonce,
                requestNonce: requests[1].requestNonce,
                payload: { quantity: 25 },
            });
            await vi.waitFor(() => expect(onRespond).toHaveBeenCalledOnce());
        } finally {
            vi.useRealTimers();
            postMessage?.mockRestore();
            await view.cleanup();
            restore();
        }
    });

    it("bounds a never-settling submission and permits a fresh host-owned retry", async () => {
        const restore = setCredentiallessSupport(true);
        const onRespond = vi
            .fn()
            .mockImplementationOnce(() => new Promise(() => undefined))
            .mockResolvedValueOnce(undefined);
        const view = await mountCard(
            card({ confirmPayload: undefined }),
            1_205n,
            GROUP,
            false,
            onRespond,
        );
        let postMessage: ReturnType<typeof vi.spyOn> | undefined;
        try {
            await waitForResolution();
            const ready = await completeCardReadyHandshake(view.target);
            postMessage = ready.postMessage;
            vi.useFakeTimers();

            buttonNamed(view.target, "Add")?.click();
            await tick();
            const first = postedCardMessages(postMessage).find(
                (message) => message.type === "oc:card:collect-confirm",
            )!;
            dispatchFromCardFrame(ready.iframe, {
                type: "oc:card:confirm-collected",
                version: 2,
                frameNonce: ready.frameNonce,
                requestNonce: first.requestNonce,
                payload: { quantity: 25 },
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(onRespond).toHaveBeenCalledOnce();

            await vi.advanceTimersByTimeAsync(30_000);
            await tick();
            expect(view.target.textContent).toContain("Confirmation failed. Try again.");
            expect(buttonNamed(view.target, "Add")?.disabled).toBe(false);

            vi.useRealTimers();
            buttonNamed(view.target, "Add")?.click();
            await vi.waitFor(() =>
                expect(
                    postedCardMessages(postMessage!).filter(
                        (message) => message.type === "oc:card:collect-confirm",
                    ),
                ).toHaveLength(2),
            );
            const requests = postedCardMessages(postMessage).filter(
                (message) => message.type === "oc:card:collect-confirm",
            );
            dispatchFromCardFrame(ready.iframe, {
                type: "oc:card:confirm-collected",
                version: 2,
                frameNonce: ready.frameNonce,
                requestNonce: requests[1].requestNonce,
                payload: { quantity: 25 },
            });
            await vi.waitFor(() => expect(onRespond).toHaveBeenCalledTimes(2));
        } finally {
            vi.useRealTimers();
            postMessage?.mockRestore();
            await view.cleanup();
            restore();
        }
    });

    it("unfreezes after a silent frame timeout and starts retry with a fresh challenge", async () => {
        const restoreCredentialless = setCredentiallessSupport(true);
        const view = await mountCard(card({ confirmPayload: undefined }), 1_203n);
        let postMessage: ReturnType<typeof vi.spyOn> | undefined;
        try {
            await waitForResolution();
            const ready = await completeCardReadyHandshake(view.target);
            postMessage = ready.postMessage;
            vi.useFakeTimers();

            buttonNamed(view.target, "Add")?.click();
            await tick();
            const firstRequests = postedCardMessages(postMessage).filter(
                (message) => message.type === "oc:card:collect-confirm",
            );
            expect(firstRequests).toHaveLength(1);
            expect(view.target.querySelector<HTMLButtonElement>("button.confirm")?.disabled).toBe(
                true,
            );

            vi.advanceTimersByTime(30_000);
            await tick();
            expect(view.target.textContent).toContain("The app did not return valid card values");
            expect(buttonNamed(view.target, "Add")?.disabled).toBe(false);
            const busySignals = postedCardMessages(postMessage)
                .filter((message) => message.type === "oc:card:busy")
                .map((message) => message.busy);
            expect(busySignals.slice(-2)).toEqual([true, false]);

            buttonNamed(view.target, "Add")?.click();
            await tick();
            const requests = postedCardMessages(postMessage).filter(
                (message) => message.type === "oc:card:collect-confirm",
            );
            expect(requests).toHaveLength(2);
            expect(requests[1].requestNonce).not.toBe(requests[0].requestNonce);
        } finally {
            vi.useRealTimers();
            postMessage?.mockRestore();
            await view.cleanup();
            restoreCredentialless();
        }
    });
});
