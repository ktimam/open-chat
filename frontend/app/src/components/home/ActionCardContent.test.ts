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
    identity: { id: APP_ID, name: "Generic app" },
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
) {
    const target = document.createElement("div");
    document.body.append(target);
    const contentStore = writable(initialContent);
    const component = mount(ActionCardContentHarness, {
        target,
        props: {
            contentStore,
            readonly: false,
            chatId,
            messageId,
            viewerId: VIEWER,
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
    it("shows no trusted-recipient description outside closed security details", async () => {
        const restore = setCredentiallessSupport(true);
        const view = await mountCard(card({ confirmPayload: undefined }), 1_010n);
        try {
            await waitForResolution();
            await vi.waitFor(() => expect(buttonNamed(view.target, "Load app card")).toBeDefined());

            expect(view.target.querySelector(".app-name")?.textContent).toContain("Generic app");
            expect(view.target.querySelector(".title")?.textContent).toBe("Add entry");
            expect(view.target.querySelector(".card-load-summary")).toBeNull();
            const gate = view.target.querySelector(".card-load-gate");
            expect(Array.from(gate?.children ?? []).map((child) => child.tagName)).toEqual([
                "DETAILS",
                "BUTTON",
            ]);

            const details = view.target.querySelector<HTMLDetailsElement>(".card-security-details");
            expect(details?.open).toBe(false);
            expect(details?.querySelector("summary")?.textContent?.trim()).toBe("Security details");
            const technical = (details?.textContent ?? "").replace(/\s+/g, " ");
            expect(technical).toContain("https://app.example");
            expect(technical).toContain("IP address");
            expect(technical).toContain("shares this card plus its chat and message identifiers");
            expect(technical).toContain("Private app context stays hidden");
            expect(technical).toContain("App ID");
            expect(technical).toContain(CARD_URL);
            expect(technical).toContain("generic.entry.add");
            expect(technical).toContain("opaque sandbox");
            expect(technical).toContain("aaaaa-aa");
            expect(technical).toContain("1010");
            expect(technical).not.toContain("stable OpenChat user ID");
            expect(technical).not.toContain("recipient public key");
        } finally {
            await view.cleanup();
            restore();
        }
    });

    it("keeps direct-chat identifiers only inside closed security details", async () => {
        const restore = setCredentiallessSupport(true);
        const direct = await mountCard(card({ confirmPayload: undefined }), 1_011n, DIRECT);
        try {
            await waitForResolution();
            await vi.waitFor(() =>
                expect(buttonNamed(direct.target, "Load app card")).toBeDefined(),
            );
            expect(direct.target.querySelector(".card-load-summary")).toBeNull();
            const directDetails =
                direct.target.querySelector(".card-security-details")?.textContent;
            expect(directDetails).toContain("both participant IDs");
            expect(directDetails).toContain(VIEWER);
            expect(directDetails).toContain(DIRECT.userId);
            expect(directDetails).toContain("1011");
        } finally {
            await direct.cleanup();
        }

        mocks.resolveActionAppForCard.mockClear();
        const group = await mountCard(card({ confirmPayload: undefined }), 1_012n);
        try {
            await waitForResolution();
            await vi.waitFor(() =>
                expect(buttonNamed(group.target, "Load app card")).toBeDefined(),
            );
            expect(group.target.querySelector(".card-load-summary")).toBeNull();
            const groupDetails =
                group.target.querySelector(".card-security-details")?.textContent ?? "";
            expect(groupDetails).not.toContain("both participant IDs");
            expect(groupDetails).toContain("aaaaa-aa");
            expect(groupDetails).toContain("1012");
            expect(groupDetails).not.toContain(VIEWER);
            expect(groupDetails).not.toContain(DIRECT.userId);
        } finally {
            await group.cleanup();
            restore();
        }
    });

    it("keeps private context behind a separate post-load consent", async () => {
        const restore = setCredentiallessSupport(true);
        mocks.privateContextAvailable = true;
        const view = await mountCard(card({ confirmPayload: undefined }), 1_013n);
        let postMessage: ReturnType<typeof vi.spyOn> | undefined;
        try {
            await waitForResolution();
            await vi.waitFor(() => expect(buttonNamed(view.target, "Load app card")).toBeDefined());

            expect(view.target.querySelector("iframe")).toBeNull();
            expect(view.target.querySelector(".private-context-consent")).toBeNull();
            expect(mocks.createAiAppCardCapability).not.toHaveBeenCalled();

            buttonNamed(view.target, "Load app card")?.click();
            await vi.waitFor(() => expect(view.target.querySelector("iframe")).not.toBeNull());
            expect(view.target.querySelector(".private-context-consent")).toBeNull();
            expect(mocks.createAiAppCardCapability).not.toHaveBeenCalled();

            const ready = await completeCardReadyHandshake(view.target);
            postMessage = ready.postMessage;
            await vi.waitFor(() =>
                expect(view.target.querySelector(".private-context-consent")).not.toBeNull(),
            );
            const consent = view.target.querySelector(".private-context-consent");
            expect(Array.from(consent?.children ?? []).map((child) => child.tagName)).toEqual([
                "STRONG",
                "DETAILS",
                "BUTTON",
            ]);
            const privateDetails = consent?.querySelector<HTMLDetailsElement>(
                ".private-context-details",
            );
            expect(privateDetails?.open).toBe(false);
            expect(privateDetails?.textContent?.replace(/\s+/g, " ")).toContain(
                "recipient-key scheme and public key",
            );
            expect(mocks.createAiAppCardCapability).not.toHaveBeenCalled();
            expect(postedMessageOfType(postMessage, "oc:card:private-context-request")).toBe(false);

            buttonNamed(view.target, "Share private context")?.click();
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
            expect(view.target.textContent).toContain("External app content (isolated)");
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
                expect(view.target.textContent).toContain("Directory entry: Generic app"),
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

    it("keeps recipient and historical cards gated until their viewer clicks Load", async () => {
        const restore = setCredentiallessSupport(true);
        const view = await mountCard(card({ confirmPayload: undefined }), 1_002n);
        try {
            await waitForResolution();
            await vi.waitFor(() => expect(buttonNamed(view.target, "Load app card")).toBeDefined());
            expect(view.target.querySelector("iframe")).toBeNull();

            buttonNamed(view.target, "Load app card")?.click();
            await vi.waitFor(() => expect(view.target.querySelectorAll("iframe")).toHaveLength(1));
        } finally {
            await view.cleanup();
            restore();
        }
    });

    it("never auto-loads without credentialless iframe support", async () => {
        const restore = setCredentiallessSupport(false);
        const view = await mountCard(card(), 1_003n);
        try {
            await waitForResolution();
            await vi.waitFor(() => expect(buttonNamed(view.target, "Load app card")).toBeDefined());
            expect(view.target.querySelector("iframe")).toBeNull();
            expect(buttonNamed(view.target, "Load app card")?.disabled).toBe(true);
            expect(view.target.textContent).toContain(
                "Secure embedded loading is unavailable in this browser.",
            );
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

    it("auto-loads when the sender-only payload arrives after backend trust", async () => {
        const restore = setCredentiallessSupport(true);
        const view = await mountCard(card({ confirmPayload: undefined }), 1_005n);
        try {
            await waitForResolution();
            await vi.waitFor(() => expect(buttonNamed(view.target, "Load app card")).toBeDefined());
            expect(view.target.querySelector("iframe")).toBeNull();

            view.contentStore.set(card());
            await tick();
            await vi.waitFor(() => expect(view.target.querySelectorAll("iframe")).toHaveLength(1));
        } finally {
            await view.cleanup();
            restore();
        }
    });

    it("does not reset a manually loaded card when the sender-only payload arrives late", async () => {
        const restore = setCredentiallessSupport(true);
        const view = await mountCard(card({ confirmPayload: undefined }), 1_007n);
        let postMessage: ReturnType<typeof vi.spyOn> | undefined;
        try {
            await waitForResolution();
            await vi.waitFor(() => expect(buttonNamed(view.target, "Load app card")).toBeDefined());

            buttonNamed(view.target, "Load app card")?.click();
            await tick();
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

    it("uses fresh-proposal consent only once per exact card in this tab", async () => {
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
                expect(buttonNamed(remounted.target, "Load app card")).toBeDefined(),
            );
            expect(remounted.target.querySelector("iframe")).toBeNull();
        } finally {
            await remounted.cleanup();
            restore();
        }
    });
});
