// @vitest-environment jsdom
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentUserIdStore, type OpenChat, type MessageContent } from "@client";
import type { Writable } from "svelte/store";
import LocalAppCards from "./LocalAppCards.svelte";
import { privateAppWorkspace as workspace } from "../utils/privateAppWorkspace";

const calls = vi.hoisted(() => ({
    extract: vi.fn(),
    deliver: vi.fn(),
    cancel: vi.fn(),
    navigate: vi.fn(),
}));
vi.mock("@client", async () => {
    const { writable } = await import("svelte/store");
    return {
        currentUserIdStore: writable("synthetic-account"),
        identityStateStore: writable({ kind: "logged_in" }),
    };
});
vi.mock("@shared", () => ({ ANON_USER_ID: "anonymous" }));
vi.mock("@utils/navigation", () => ({ navigate: calls.navigate }));
vi.mock("../utils/aiActionRunner", () => ({ extractPrivateAppAction: calls.extract }));
vi.mock("../utils/localAppSetupConnection", () => ({ connectLocalAppSetup: vi.fn() }));
vi.mock("../utils/isolatedAppProcessor", () => ({
    runIsolatedAppProcessor: vi.fn(),
    verifyImportedLocalProcessor: vi.fn(),
}));
// These mounted card tests exercise real workspace/UI behavior; durable storage is
// tested separately, and no browser account setup should be accessed by fixtures.
vi.mock("../utils/localAppSetupStore", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../utils/localAppSetupStore")>()),
    createBrowserLocalAppSetupStorage: () => ({
        read: vi.fn(async () => undefined),
        write: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
    }),
}));
vi.mock("../utils/localAppDraftPersistence", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../utils/localAppDraftPersistence")>()),
    // Card-editor tests isolate storage; encrypted recovery is exercised by dedicated suites.
    createBrowserLocalAppDraftStorage: () => undefined,
}));
vi.mock("../utils/localAppRelayDelivery", async () => ({
    deliverLocalAppViaRelay: calls.deliver,
    cancelLocalAppHandoffs: calls.cancel,
    localAppDeliveryStatus: (await import("svelte/store")).writable(undefined),
}));
vi.mock("../utils/nativeAppDelivery", async () => ({
    nativeAppPairing: (await import("svelte/store")).writable(undefined),
    nativeAppDelivery: { deliver: vi.fn(), cancelAll: vi.fn() },
    nativeDeliveryAllowed: () => false,
}));

const catalog = JSON.stringify({
    version: 1,
    apps: [
        {
            id: "synthetic",
            revision: "1",
            name: "Synthetic app",
            description: "Test only",
            destination: "https://example.test/import",
            deliveryEncryption: {
                version: 1,
                scheme: "p256-hkdf-sha256-aes-256-gcm-v1",
                keyId: "a".repeat(64),
                publicKeySpki: btoa("\0".repeat(91)).replace(/=+$/, ""),
                recipientContext: "AQ",
            },
            actions: [
                {
                    definition: {
                        name: "capture",
                        description: "Capture",
                        promptTemplate: "Extract the selected value",
                        responseSchema: { type: "object" },
                        card: {
                            title: "App-defined title",
                            rows: [{ label: "App-defined value", valueKey: "value" }],
                            disclosure: "App-defined explanation",
                            confirmLabel: "Preview only",
                            cancelLabel: "Keep sending",
                        },
                    },
                    draftSchema: {
                        type: "object",
                        properties: { value: { type: "number" }, extra: { type: "string" } },
                        required: ["value"],
                        additionalProperties: false,
                    },
                    handoff: { kind: "single" },
                },
            ],
        },
    ],
});

let mounted: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
let client: OpenChat;
const settle = async () => {
    await tick();
    flushSync();
};
const button = (label: string) =>
    [...target.querySelectorAll("button")].find(
        (node) => node.textContent === label || node.getAttribute("aria-label") === label,
    )!;
const preview = () => target.querySelector('[aria-label="App-declared draft preview"]')!;
const cardText = () =>
    [
        preview().textContent,
        ...preview().querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
            "input, textarea, select",
        ),
    ]
        .map((value) => (typeof value === "string" || value === null ? value : value.value))
        .join(" ");
const visibleText = () => target.textContent?.replace(/\s+/g, " ");
const editor = () =>
    target.querySelector<HTMLTextAreaElement>('textarea[aria-label="Complete payload (JSON)"]')!;
const confirmation = () =>
    [...target.querySelectorAll("label")]
        .find((node) => node.textContent?.includes("I reviewed every field and the destination"))!
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!;
const changeJson = async (json: string) => {
    editor().value = json;
    editor().dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
};
const propose = async () => {
    await workspace.propose(
        client,
        { kind: "text_content", text: "synthetic source" } as MessageContent,
        { stillCurrent: () => true },
    );
    await settle();
};
const approveAndSend = async () => {
    button("Review full request").click();
    await settle();
    confirmation().click();
    await settle();
    button("Send reviewed request").click();
    await settle();
};
const numericFields = () =>
    [...target.querySelectorAll<HTMLInputElement>("input[aria-label]")].filter((node) =>
        node.getAttribute("aria-label")?.includes("App-defined value"),
    );
const changeNumber = async (value: string, item = 0) => {
    const input = numericFields()[item];
    expect(input).toBeDefined();
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
};
const extraField = () =>
    target.querySelector<HTMLTextAreaElement>('textarea[aria-label="Item 1 — extra"]')!;
const changeExtra = async (value: string) => {
    extraField().value = value;
    extraField().dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
};
const categoryChoice = () =>
    target.querySelector<HTMLSelectElement>('select[aria-label="Item 1 — Saved category"]')!;
const selectCategory = async (value: string) => {
    categoryChoice().value = value;
    categoryChoice().dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
};
const proposeNamed = async (
    payload: Record<string, unknown> = { value: 42, extra: "Also sent", categoryId: "category-a" },
) => {
    const declaration = JSON.parse(catalog);
    const action = declaration.apps[0].actions[0];
    action.draftSchema.properties.categoryId = { type: "string" };
    action.draftSchema.properties.categoryLabel = { type: "string" };
    action.draftEditor = {
        version: 1,
        choices: [
            {
                field: "categoryId",
                label: "Saved category",
                noneLabel: "None — keep extracted values",
                options: [
                    {
                        value: "category-a",
                        label: "Friendly Alpha",
                        assign: [{ field: "categoryLabel", value: "Assigned Alpha" }],
                        defaults: [{ field: "value", value: 10 }],
                    },
                    {
                        value: "category-b",
                        label: "Friendly Beta",
                        assign: [{ field: "categoryLabel", value: "Assigned Beta" }],
                        defaults: [{ field: "value", value: 20 }],
                    },
                ],
            },
        ],
    };
    workspace.discard();
    expect(workspace.importCatalog(JSON.stringify(declaration))).toBe(true);
    expect(workspace.select("synthetic", "capture")).toBe(true);
    calls.extract.mockClear();
    calls.extract.mockResolvedValue({ kind: "extracted", candidates: [payload] });
    await propose();
};

beforeEach(async () => {
    vi.clearAllMocks();
    (currentUserIdStore as unknown as Writable<string>).set("synthetic-account");
    workspace.clear();
    workspace.setAccount("synthetic-account", "synthetic-backend");
    await vi.waitFor(() => expect(workspace.state.setupLoading).toBe(false));
    calls.extract.mockResolvedValue({
        kind: "extracted",
        candidates: [{ value: 42, extra: "Also sent" }],
    });
    calls.deliver.mockResolvedValue({ kind: "delivered" });
    expect(workspace.importCatalog(catalog)).toBe(true);
    expect(workspace.select("synthetic", "capture")).toBe(true);
    target = document.createElement("div");
    document.body.append(target);
    client = {
        clientOnlyApps: () => true,
        privateAppStorageBackend: () => "synthetic-backend",
        isNativeApp: () => false,
        existingAccountOnly: () => true,
        onLogout: vi.fn(),
    } as unknown as OpenChat;
    mounted = mount(LocalAppCards, { target, props: { client } });
    flushSync();
    await settle();
    await propose();
});
afterEach(async () => {
    if (mounted) await unmount(mounted);
    mounted = undefined;
    document.body.replaceChildren();
});

describe("local app card modal and authoritative review", () => {
    it("stays headless without an opened card and renders only status for an empty opened action", async () => {
        workspace.discard();
        workspace.close();
        await settle();
        expect(target.textContent).toBe("");
        expect(workspace.state.account).toBe("synthetic-account");
        expect(workspace.state.catalog).toBeDefined();

        workspace.open();
        await settle();
        expect(target.querySelector('[role="dialog"]')).not.toBeNull();
        expect(target.querySelector('[role="status"]')).not.toBeNull();
        expect(preview()).toBeNull();
        expect(target.querySelector("input, select, textarea")).toBeNull();
        expect(button("Connect")).toBeUndefined();
        expect(button("Refresh available apps")).toBeUndefined();
        expect(calls.extract).toHaveBeenCalledOnce();
        expect(calls.deliver).not.toHaveBeenCalled();
    });

    it("clears visible consent when the card modal closes and reopens", async () => {
        button("Review full request").click();
        await settle();
        confirmation().click();
        await settle();
        expect(button("Send reviewed request").disabled).toBe(false);
        const id = workspace.state.draft!.id;
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        await settle();
        expect(workspace.state.open).toBe(false);
        workspace.open();
        await settle();
        expect(workspace.state.draft!.id).toBe(id);
        expect(confirmation().checked).toBe(false);
        expect(button("Send reviewed request").disabled).toBe(true);
        expect(calls.extract).toHaveBeenCalledOnce();
        expect(calls.deliver).not.toHaveBeenCalled();
    });

    it("returns to the exact source without losing edits, delivering, or rerunning inference", async () => {
        await workspace.propose(
            client,
            { kind: "text_content", text: "Synthetic source with no app access" } as MessageContent,
            {
                stillCurrent: () => true,
                source: {
                    chatKey: "rrkah-fqaaa-aaaaa-aaaaq-cai",
                    chatKind: "direct_chat",
                    messageId: "18446744073709551615",
                    messageIndex: 0,
                },
            },
        );
        await settle();
        const draftId = workspace.state.draft!.id;
        const inferenceCount = calls.extract.mock.calls.length;
        await changeNumber("57");
        button("Review full request").click();
        await settle();
        confirmation().click();
        await settle();
        expect(workspace.state.draft!.approval).toBeDefined();
        expect(target.querySelector('[aria-label="Selected card source"]')?.textContent).toContain(
            "rrkah-fqaaa-aaaaa-aaaaq-cai",
        );
        button("View source message").click();
        await settle();
        expect(calls.navigate).toHaveBeenCalledExactlyOnceWith(
            "/chats/user/rrkah-fqaaa-aaaaa-aaaaq-cai/0",
        );
        expect(workspace.state.open).toBe(false);
        expect(workspace.state.cards).toHaveLength(2);
        expect(workspace.state.draft!.id).toBe(draftId);
        expect(workspace.state.draft!.approval).toBeUndefined();
        workspace.open();
        await settle();
        expect(numericFields()[0].value).toBe("57");
        expect(calls.extract).toHaveBeenCalledTimes(inferenceCount);
        expect(calls.deliver).not.toHaveBeenCalled();
    });

    it.each(["delivered", "uncertain"] as const)(
        "requires a fresh recovery review after leaving a %s card for its source",
        async (kind) => {
            await workspace.propose(
                client,
                { kind: "text_content", text: "Synthetic recovery source" } as MessageContent,
                {
                    stillCurrent: () => true,
                    source: {
                        chatKey: "rrkah-fqaaa-aaaaa-aaaaq-cai",
                        chatKind: "group_chat",
                        messageId: "900",
                        messageIndex: 4,
                    },
                },
            );
            await settle();
            calls.deliver.mockResolvedValue({ kind });
            await approveAndSend();
            expect(workspace.state.draft!.status).toBe(kind);
            const draftId = workspace.state.draft!.id;
            const request = workspace.state.draft!.approval!.request;
            const inferenceCount = calls.extract.mock.calls.length;
            expect(workspace.selectCard(draftId)).toBe(true);
            await settle();
            button("Review recovered request before retrying").click();
            await settle();
            const oldApprovalId = workspace.state.draft!.approval!.approvalId;
            expect(workspace.state.draft!.approval!.request).toEqual(request);
            button("View source message").click();
            await settle();
            expect(calls.navigate).toHaveBeenCalledExactlyOnceWith(
                "/chats/group/rrkah-fqaaa-aaaaa-aaaaq-cai/4",
            );
            expect(workspace.state.draft!.status).toBe(kind);
            expect(workspace.state.draft!.approval).toBeUndefined();
            expect(workspace.state.open).toBe(false);
            workspace.open();
            await settle();
            expect(button("Review recovered request before retrying")).toBeDefined();
            if (kind === "uncertain") await workspace.retryUncertain(oldApprovalId);
            else await workspace.reopenDelivered(oldApprovalId);
            expect(calls.deliver).toHaveBeenCalledOnce();
            button("Review recovered request before retrying").click();
            await settle();
            expect(workspace.state.draft!.approval!.approvalId).not.toBe(oldApprovalId);
            expect(workspace.state.draft!.approval!.request).toEqual(request);
            expect(workspace.state.draft!.id).toBe(draftId);
            expect(calls.extract).toHaveBeenCalledTimes(inferenceCount);
            expect(calls.deliver).toHaveBeenCalledOnce();
        },
    );

    it("uses the selected card's source and gives legacy cards an honest thread fallback", async () => {
        const captured = { kind: "text_content", text: "Synthetic" } as MessageContent;
        await workspace.propose(client, captured, {
            stillCurrent: () => true,
            source: {
                chatKey: "rrkah-fqaaa-aaaaa-aaaaq-cai",
                chatKind: "group_chat",
                messageId: "99",
                messageIndex: 3,
            },
        });
        const groupCard = workspace.state.draft!.id;
        await workspace.propose(client, captured, {
            stillCurrent: () => true,
            source: {
                chatKey: "rrkah-fqaaa-aaaaa-aaaaq-cai_8",
                chatKind: "channel",
                messageId: "99",
                threadRootMessageIndex: 4,
            },
        });
        await settle();
        expect(button("View source message")).toBeUndefined();
        button("Open source thread").click();
        await settle();
        expect(calls.navigate).toHaveBeenLastCalledWith(
            "/community/rrkah-fqaaa-aaaaa-aaaaq-cai/channel/8/4?open=true",
        );
        workspace.open();
        workspace.selectCard(groupCard);
        await settle();
        expect(button("Open source thread")).toBeUndefined();
        button("View source message").click();
        await settle();
        expect(calls.navigate).toHaveBeenLastCalledWith(
            "/chats/group/rrkah-fqaaa-aaaaa-aaaaq-cai/3",
        );
        expect(workspace.state.cards).toHaveLength(3);
        expect(calls.extract).toHaveBeenCalledTimes(3);
        expect(calls.deliver).not.toHaveBeenCalled();
    });

    it("blocks source navigation while an unrepresentable edit would be hidden", async () => {
        await workspace.propose(
            client,
            { kind: "text_content", text: "Synthetic" } as MessageContent,
            {
                stillCurrent: () => true,
                source: {
                    chatKey: "rrkah-fqaaa-aaaaa-aaaaq-cai",
                    chatKind: "direct_chat",
                    messageId: "8",
                    messageIndex: 7,
                },
            },
        );
        await settle();
        await changeExtra("x".repeat(70000));
        const sourceButton = button("View source message");
        expect(sourceButton.disabled).toBe(true);
        sourceButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle();
        expect(calls.navigate).not.toHaveBeenCalled();
        expect(workspace.state.open).toBe(true);
        expect(extraField().value).toHaveLength(70000);
        expect(calls.deliver).not.toHaveBeenCalled();
    });

    it("never turns malformed stored source references or app payload fields into links", async () => {
        calls.extract.mockResolvedValue({
            kind: "extracted",
            candidates: [{ value: 42, extra: "https://outside.example/source" }],
        });
        await workspace.propose(
            client,
            { kind: "text_content", text: "Synthetic" } as MessageContent,
            {
                stillCurrent: () => true,
                source: { chatKey: "d|https://outside.example", messageId: "8", messageIndex: 7 },
            },
        );
        await settle();
        expect(target.querySelector('[aria-label="Selected card source"]')).toBeNull();
        expect(button("View source message")).toBeUndefined();
        expect(button("Open source chat")).toBeUndefined();
        expect(calls.navigate).not.toHaveBeenCalled();
        expect(calls.deliver).not.toHaveBeenCalled();
    });

    it("does not guess the chat kind for old bare-principal references", async () => {
        await workspace.propose(
            client,
            { kind: "text_content", text: "Synthetic" } as MessageContent,
            {
                stillCurrent: () => true,
                source: { chatKey: "rrkah-fqaaa-aaaaa-aaaaq-cai", messageId: "8" },
            },
        );
        await settle();
        expect(target.querySelector('[aria-label="Selected card source"]')).toBeNull();
        expect(visibleText()).toContain(
            "Propose again from the original message to restore its link",
        );
        expect(button("View source message")).toBeUndefined();
        expect(button("Open source chat")).toBeUndefined();
        expect(calls.navigate).not.toHaveBeenCalled();
        expect(calls.deliver).not.toHaveBeenCalled();
    });

    it("never exposes setup, file import, directory or all-card deletion in the card modal", async () => {
        await propose();
        expect(workspace.state.cards).toHaveLength(2);
        expect(target.querySelector('input[type="file"]')).toBeNull();
        expect(target.querySelector(".setup-disclosure")).toBeNull();
        expect(target.querySelector(".privacy-disclosure")).toBeNull();
        expect(visibleText()).not.toContain("Forget");
        expect(visibleText()).not.toContain("Refresh available apps");
        expect(target.querySelector('[role="dialog"]')).not.toBeNull();
        expect(workspace.state.catalog).toBeDefined();
        expect(calls.deliver).not.toHaveBeenCalled();
    });

    it("selects retained local cards without re-inference and requires fresh consent", async () => {
        await changeNumber("43");
        button("Review full request").click();
        await settle();
        confirmation().click();
        await settle();
        const first = workspace.state.draft!.id;
        const approval = workspace.state.draft!.approval!.approvalId;
        await propose();
        const second = workspace.state.draft!.id;
        expect(second).not.toBe(first);
        const selector = target.querySelector(
            'nav[aria-label="Saved private cards on this device"]',
        )!;
        expect(selector.textContent).toContain("not posted in chat");
        expect(selector.querySelectorAll("button")).toHaveLength(2);
        const inferences = calls.extract.mock.calls.length;
        selector.querySelector<HTMLButtonElement>("button")!.click();
        await settle();
        expect(workspace.state.draft?.id).toBe(first);
        expect(numericFields()[0].value).toBe("43");
        expect(workspace.state.draft?.approval).toBeUndefined();
        await workspace.confirm(approval);
        expect(calls.deliver).not.toHaveBeenCalled();
        button("Review full request").click();
        await settle();
        expect(confirmation().checked).toBe(false);
        expect(calls.extract).toHaveBeenCalledTimes(inferences);
        expect(workspace.state.cards).toHaveLength(2);
    });

    it("keeps a pending unrepresentable edit visible and blocks card switching", async () => {
        await propose();
        await changeExtra("x".repeat(70000));
        const current = workspace.state.draft!.id;
        const selector = target.querySelector(
            'nav[aria-label="Saved private cards on this device"]',
        )!;
        expect(
            [...selector.querySelectorAll<HTMLButtonElement>("button")].every(
                (node) => node.disabled,
            ),
        ).toBe(true);
        expect(workspace.selectCard(workspace.state.cards[0].id)).toBe(false);
        expect(workspace.state.draft?.id).toBe(current);
        expect(extraField().value).toHaveLength(70000);
        expect(calls.deliver).not.toHaveBeenCalled();
        await changeExtra("corrected");
        expect(workspace.selectCard(workspace.state.cards[0].id)).toBe(true);
        await settle();
        expect(workspace.state.cards).toHaveLength(2);
    });

    it("keeps invalid supplied dates visible and blocks stale approval until exact correction", async () => {
        const declaration = JSON.parse(catalog);
        const action = declaration.apps[0].actions[0];
        action.draftSchema.properties.date = { type: "string" };
        action.draftPresentation = {
            version: 1,
            enumLabels: [],
            controls: [{ field: "date", kind: "date" }],
        };
        workspace.discard();
        expect(workspace.importCatalog(JSON.stringify(declaration))).toBe(true);
        expect(workspace.select("synthetic", "capture")).toBe(true);
        calls.extract.mockResolvedValue({
            kind: "extracted",
            candidates: [{ value: 42, date: "2026-02-30" }],
        });
        await propose();
        const date = () =>
            target.querySelector<HTMLInputElement>('input[aria-label="Item 1 — date"]')!;
        expect(date().type).toBe("text");
        expect(date().value).toBe("2026-02-30");
        expect(JSON.parse(editor().value).date).toBe("2026-02-30");
        expect(button("Review full request").disabled).toBe(true);
        expect(workspace.state.draft!.approval).toBeUndefined();
        date().value = "2026-02-28";
        date().dispatchEvent(new Event("input", { bubbles: true }));
        await settle();
        expect(date().type).toBe("date");
        expect(button("Review full request").disabled).toBe(false);
        button("Review full request").click();
        await settle();
        const staleApproval = workspace.state.draft!.approval!.approvalId;
        confirmation().click();
        await settle();
        await changeJson(JSON.stringify({ value: 42, date: "" }));
        expect(date().type).toBe("text");
        expect(date().value).toBe("");
        expect(JSON.parse(editor().value)).toEqual({ value: 42, date: "" });
        expect(button("Review full request").disabled).toBe(true);
        expect(workspace.state.draft!.approval).toBeUndefined();
        await workspace.confirm(staleApproval);
        expect(calls.deliver).not.toHaveBeenCalled();
        date().value = "2026-03-01";
        date().dispatchEvent(new Event("input", { bubbles: true }));
        await settle();
        button("Review full request").click();
        await settle();
        expect(confirmation().checked).toBe(false);
        expect(button("Send reviewed request").disabled).toBe(true);
        confirmation().click();
        await settle();
        button("Send reviewed request").click();
        await settle();
        expect(calls.deliver).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ payload: { value: 42, date: "2026-03-01" } }),
            expect.any(AbortSignal),
        );
    });

    it("wires named labels to exact values, preserves manual edits, and revokes consent synchronously", async () => {
        await proposeNamed();
        expect(categoryChoice().value).toBe("option-0");
        expect(categoryChoice().selectedOptions[0].textContent).toBe("Friendly Alpha");
        expect(JSON.parse(editor().value)).toEqual({
            value: 10,
            extra: "Also sent",
            categoryId: "category-a",
            categoryLabel: "Assigned Alpha",
        });
        expect(
            target.querySelector('output[aria-label="Item 1 — categoryLabel"]')?.textContent,
        ).toContain('"Assigned Alpha"');
        expect(
            target.querySelector(
                'input[aria-label="Item 1 — categoryLabel"], textarea[aria-label="Item 1 — categoryLabel"], select[aria-label="Item 1 — categoryLabel"]',
            ),
        ).toBeNull();
        await changeNumber("55.5");
        button("Review full request").click();
        await settle();
        const staleApproval = workspace.state.draft!.approval!.approvalId;
        confirmation().click();
        await settle();
        categoryChoice().value = "option-1";
        categoryChoice().dispatchEvent(new Event("change", { bubbles: true }));
        expect(workspace.state.draft!.approval).toBeUndefined();
        await settle();
        const expected = {
            value: 55.5,
            extra: "Also sent",
            categoryId: "category-b",
            categoryLabel: "Assigned Beta",
        };
        expect(JSON.parse(editor().value)).toEqual(expected);
        expect(button("Send reviewed request")).toBeUndefined();
        await workspace.confirm(staleApproval);
        expect(calls.deliver).not.toHaveBeenCalled();
        await approveAndSend();
        expect(calls.deliver).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ payload: expected }),
            expect.any(AbortSignal),
        );
        expect(categoryChoice().disabled).toBe(true);
        const deliveredJson = editor().value;
        await selectCategory("option-0");
        expect(editor().value).toBe(deliveredJson);
        expect(calls.extract).toHaveBeenCalledOnce();
    });

    it("sends None without choice or companion keys and restores the untouched extracted value", async () => {
        await proposeNamed();
        expect(JSON.parse(editor().value).value).toBe(10);
        button("Review full request").click();
        await settle();
        const staleApproval = workspace.state.draft!.approval!.approvalId;
        await selectCategory("absent");
        const expected = { value: 42, extra: "Also sent" };
        expect(categoryChoice().selectedOptions[0].textContent).toBe(
            "None — keep extracted values",
        );
        expect(JSON.parse(editor().value)).toEqual(expected);
        expect(
            target.querySelector('output[aria-label="Item 1 — categoryLabel"]')?.textContent,
        ).toContain("Not supplied");
        expect(workspace.state.draft!.approval).toBeUndefined();
        await workspace.confirm(staleApproval);
        expect(calls.deliver).not.toHaveBeenCalled();
        await approveAndSend();
        expect(calls.deliver).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ payload: expected }),
            expect.any(AbortSignal),
        );
        expect(calls.extract).toHaveBeenCalledOnce();
    });

    it("does not approve or coerce unknown extracted choices and permits explicit None repair", async () => {
        const payload = {
            value: 42,
            extra: "Also sent",
            categoryId: "unknown-id",
            categoryLabel: "Unknown companion",
        };
        await proposeNamed(payload);
        expect(categoryChoice().value).toBe("invalid");
        expect(categoryChoice().getAttribute("aria-invalid")).toBe("true");
        expect(categoryChoice().selectedOptions[0].textContent).toBe("Unknown supplied choice");
        expect(visibleText()).toContain("unknown-id");
        expect(JSON.parse(editor().value)).toEqual(payload);
        button("Review full request").click();
        await settle();
        expect(workspace.state.draft!.approval).toBeUndefined();
        expect(button("Send reviewed request")).toBeUndefined();
        expect(calls.deliver).not.toHaveBeenCalled();
        await selectCategory("absent");
        expect(JSON.parse(editor().value)).toEqual({ value: 42, extra: "Also sent" });
        await approveAndSend();
        expect(calls.deliver).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ payload: { value: 42, extra: "Also sent" } }),
            expect.any(AbortSignal),
        );
        expect(calls.extract).toHaveBeenCalledOnce();
    });

    it("keeps advanced JSON authoritative, blocks mismatched companions, and never reapplies defaults on repair", async () => {
        await proposeNamed();
        button("Review full request").click();
        await settle();
        const staleApproval = workspace.state.draft!.approval!.approvalId;
        const manual = {
            value: 99,
            extra: "Manual payload",
            categoryId: "category-a",
            categoryLabel: "Mismatched companion",
        };
        await changeJson(JSON.stringify(manual));
        expect(JSON.parse(editor().value)).toEqual(manual);
        expect(visibleText()).toContain("Advanced JSON keeps your explicit field values");
        expect(workspace.state.draft!.approval).toBeUndefined();
        button("Review full request").click();
        await settle();
        expect(workspace.state.draft!.approval).toBeUndefined();
        await workspace.confirm(staleApproval);
        expect(calls.deliver).not.toHaveBeenCalled();
        await selectCategory("option-1");
        expect(JSON.parse(editor().value)).toEqual({
            ...manual,
            categoryId: "category-b",
            categoryLabel: "Assigned Beta",
        });
        await selectCategory("absent");
        const expected = { value: 99, extra: "Manual payload" };
        expect(JSON.parse(editor().value)).toEqual(expected);
        await approveAndSend();
        expect(calls.deliver).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ payload: expected }),
            expect.any(AbortSignal),
        );
        expect(calls.extract).toHaveBeenCalledOnce();
    });

    it("starts proposals with no management page and advanced JSON collapsed without hiding the complete review", async () => {
        const advanced = target.querySelector<HTMLDetailsElement>("details.advanced-editor")!;
        expect(target.querySelector("details.setup-disclosure")).toBeNull();
        expect(advanced.open).toBe(false);
        expect(advanced.querySelector("summary")?.textContent).toContain("complete payload");
        expect(numericFields()[0].value).toBe("42");
        expect(JSON.parse(editor().value)).toEqual({ value: 42, extra: "Also sent" });
        button("Review full request").click();
        await settle();
        const summary = workspace.state.draft!.approval!.summary;
        expect(summary).toContain("Also sent");
        expect(summary).toContain("https://example.test/import");
        const review = [...target.querySelectorAll("pre")].find(
            (node) => node.textContent === summary,
        )!;
        expect(review).toBeDefined();
        expect(review.closest("details")?.classList.contains("request-details")).toBe(true);
        expect(review.closest("details")?.open).toBe(false);
        expect(cardText()).toContain("42");
        expect(cardText()).toContain("Also sent");
        expect(preview().closest("details")).toBeNull();
        expect(target.querySelector(".privacy-disclosure")).toBeNull();
        expect(advanced.open).toBe(false);
        expect(calls.deliver).not.toHaveBeenCalled();
    });

    it("shows declared labels and additional fields without replacing explicit host sharing consent", async () => {
        expect(target.querySelector("h2")?.textContent).toBe("App-defined title");
        expect(
            [...target.querySelectorAll("h2, h3")].filter(
                (node) => node.textContent === "App-defined title",
            ),
        ).toHaveLength(1);
        expect(target.querySelector(".privacy-disclosure")).toBeNull();
        expect(target.querySelector(".setup-disclosure")).toBeNull();
        expect(preview().textContent).toContain("App-defined value");
        expect(cardText()).toContain("Also sent");
        expect(editor().value).toContain('"extra": "Also sent"');
        expect(calls.deliver).not.toHaveBeenCalled();
        expect(visibleText()).not.toContain("Preview only");
        expect(visibleText()).not.toContain("Keep sending");
        button("Review full request").click();
        await settle();
        expect(button("Send reviewed request").disabled).toBe(true);
        expect(button("Send reviewed request").textContent).toContain("Preview only");
        expect(button("Send reviewed request").textContent).toContain("Send reviewed request");
        expect(visibleText()).toContain("Send exactly this request outside OpenChat.");
        button("Send reviewed request").click();
        await settle();
        expect(calls.deliver).not.toHaveBeenCalled();
        confirmation().click();
        await settle();
        expect(button("Send reviewed request").disabled).toBe(false);
        button("Send reviewed request").click();
        await settle();
        expect(calls.deliver).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                destination: "https://example.test/import",
                payload: { value: 42, extra: "Also sent" },
            }),
            expect.any(AbortSignal),
        );
    });

    it("updates from edited JSON, revokes prior approval, and hides old values on invalid edits", async () => {
        button("Review full request").click();
        await settle();
        const firstApproval = workspace.state.draft!.approval!.approvalId;
        confirmation().click();
        await settle();
        await changeJson('{"value":43,"extra":"Edited payload"}');
        expect(cardText()).toContain("43");
        expect(cardText()).toContain("Edited payload");
        expect(cardText()).not.toContain("Also sent");
        expect(workspace.state.draft!.approval).toBeUndefined();
        expect(button("Send reviewed request")).toBeUndefined();
        await workspace.confirm(firstApproval);
        expect(calls.deliver).not.toHaveBeenCalled();
        await changeJson('{"value":');
        expect(preview().textContent).toContain("Field editing is unavailable");
        expect(preview().textContent).not.toContain("Edited payload");
        expect(preview().querySelector("dl")).toBeNull();
        button("Review full request").click();
        await settle();
        expect(workspace.state.draft!.approval).toBeUndefined();
        expect(calls.deliver).not.toHaveBeenCalled();
        expect(calls.extract).toHaveBeenCalledOnce();
    });

    it("edits a declared field, revokes consent and sends only the newly reviewed payload", async () => {
        button("Review full request").click();
        await settle();
        const firstApproval = workspace.state.draft!.approval!.approvalId;
        confirmation().click();
        await settle();
        await changeNumber("43.5");
        expect(JSON.parse(editor().value)).toEqual({ value: 43.5, extra: "Also sent" });
        expect(workspace.state.draft!.approval).toBeUndefined();
        expect(button("Send reviewed request")).toBeUndefined();
        await workspace.confirm(firstApproval);
        expect(calls.deliver).not.toHaveBeenCalled();
        button("Review full request").click();
        await settle();
        expect(confirmation().checked).toBe(false);
        expect(button("Send reviewed request").disabled).toBe(true);
        confirmation().click();
        await settle();
        button("Send reviewed request").click();
        await settle();
        expect(calls.deliver).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ payload: { value: 43.5, extra: "Also sent" } }),
            expect.any(AbortSignal),
        );
        expect(calls.extract).toHaveBeenCalledOnce();
    });

    it.each(["", "-", "1e", "12junk"])(
        "keeps an invalid numeric edit (%j) unapproved, then recovers without re-inference",
        async (invalid) => {
            button("Review full request").click();
            await settle();
            const firstApproval = workspace.state.draft!.approval!.approvalId;
            confirmation().click();
            await settle();
            await changeNumber(invalid);
            expect(numericFields()[0].value).toBe(invalid);
            expect(workspace.state.draft!.approval).toBeUndefined();
            button("Review full request").click();
            await settle();
            expect(workspace.state.draft!.approval).toBeUndefined();
            await workspace.confirm(firstApproval);
            expect(calls.deliver).not.toHaveBeenCalled();
            expect(button("Send reviewed request")).toBeUndefined();
            await changeNumber("44.25");
            expect(JSON.parse(editor().value)).toEqual({ value: 44.25, extra: "Also sent" });
            await approveAndSend();
            expect(calls.deliver).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({ payload: { value: 44.25, extra: "Also sent" } }),
                expect.any(AbortSignal),
            );
            expect(calls.extract).toHaveBeenCalledOnce();
        },
    );

    it.each(["list", "wrapped-list"] as const)(
        "edits only the second %s item and preserves all additional values in the exact handoff",
        async (kind) => {
            const declaration = JSON.parse(catalog);
            const action = declaration.apps[0].actions[0];
            const items = {
                type: "array",
                minItems: 1,
                maxItems: 32,
                items: action.draftSchema,
            };
            action.handoff = kind === "list" ? { kind } : { kind, field: "customRecords" };
            action.draftSchema =
                kind === "list"
                    ? items
                    : {
                          type: "object",
                          additionalProperties: false,
                          required: ["customRecords"],
                          properties: {
                              customRecords: items,
                              envelopeNote: { type: "string" },
                          },
                      };
            workspace.discard();
            expect(workspace.importCatalog(JSON.stringify(declaration))).toBe(true);
            expect(workspace.select("synthetic", "capture")).toBe(true);
            const records = [
                { value: 42, extra: "FIRST ITEM MUST REMAIN" },
                { value: 84, extra: "SECOND ITEM EXTRA" },
            ];
            calls.extract.mockClear();
            calls.extract.mockResolvedValue({ kind: "extracted", candidates: records });
            await propose();
            if (kind === "wrapped-list") {
                await changeJson(
                    JSON.stringify({
                        customRecords: records,
                        envelopeNote: "ENVELOPE MUST REMAIN",
                    }),
                );
            }
            button("Review full request").click();
            await settle();
            const firstApproval = workspace.state.draft!.approval!.approvalId;
            expect(numericFields()).toHaveLength(2);
            await changeNumber("99.5", 1);
            const editedRecords = [records[0], { value: 99.5, extra: "SECOND ITEM EXTRA" }];
            const expected =
                kind === "list"
                    ? editedRecords
                    : { customRecords: editedRecords, envelopeNote: "ENVELOPE MUST REMAIN" };
            expect(JSON.parse(editor().value)).toEqual(expected);
            expect(cardText()).toContain("FIRST ITEM MUST REMAIN");
            expect(cardText()).toContain("SECOND ITEM EXTRA");
            if (kind === "wrapped-list")
                expect(preview().textContent).toContain("ENVELOPE MUST REMAIN");
            await workspace.confirm(firstApproval);
            expect(calls.deliver).not.toHaveBeenCalled();
            await approveAndSend();
            expect(calls.deliver).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({ payload: expected }),
                expect.any(AbortSignal),
            );
            expect(calls.extract).toHaveBeenCalledOnce();
        },
    );

    it.each(["delivered", "uncertain"] as const)(
        "disables both field and JSON editing after a %s outcome",
        async (kind) => {
            calls.deliver.mockResolvedValue({ kind });
            await approveAndSend();
            expect(workspace.state.draft!.status).toBe(kind);
            expect(numericFields()[0].disabled).toBe(true);
            expect(editor().disabled).toBe(true);
            expect(button("Review full request")).toBeUndefined();
            const unchanged = workspace.state.editorJson;
            await changeNumber("99");
            expect(workspace.state.editorJson).toBe(unchanged);
            expect(calls.deliver).toHaveBeenCalledOnce();
        },
    );

    it("locks field editing while the reviewed handoff is in flight", async () => {
        let finish!: (outcome: { kind: "delivered" }) => void;
        calls.deliver.mockImplementation(
            () =>
                new Promise<{ kind: "delivered" }>((resolve) => {
                    finish = resolve;
                }),
        );
        await approveAndSend();
        expect(workspace.state.draft!.status).toBe("sending");
        expect(workspace.state.busy).toBe(true);
        expect(numericFields()[0].disabled).toBe(true);
        expect(editor().disabled).toBe(true);
        const unchanged = workspace.state.editorJson;
        await changeNumber("99");
        expect(workspace.state.editorJson).toBe(unchanged);
        finish({ kind: "delivered" });
        await settle();
        expect(workspace.state.draft!.status).toBe("delivered");
        expect(calls.deliver).toHaveBeenCalledOnce();
    });

    it.each(["field", "advanced JSON"] as const)(
        "keeps an over-limit edit blocked across revision updates and recovers through %s",
        async (recovery) => {
            button("Review full request").click();
            await settle();
            const firstApproval = workspace.state.draft!.approval!.approvalId;
            const originalJson = workspace.state.editorJson;
            const oversized = "x".repeat(65536);
            await changeExtra(oversized);
            expect(extraField().value).toBe(oversized);
            expect(extraField().getAttribute("aria-invalid")).toBe("true");
            expect(workspace.state.editorJson).toBe(originalJson);
            expect(workspace.state.draft!.approval).toBeUndefined();
            expect(preview()).toBeNull();
            expect(button("Review full request").disabled).toBe(true);
            const blockedRevision = workspace.state.draft!.revision;
            workspace.edit(originalJson, "Changed recipient review label");
            await settle();
            expect(workspace.state.draft!.revision).toBeGreaterThan(blockedRevision);
            expect(button("Review full request").disabled).toBe(true);
            expect(preview()).toBeNull();
            button("Review full request").click();
            await settle();
            await workspace.confirm(firstApproval);
            expect(workspace.state.draft!.approval).toBeUndefined();
            expect(calls.deliver).not.toHaveBeenCalled();
            if (recovery === "field") await changeExtra("Recovered extra");
            else await changeJson(JSON.stringify({ value: 42, extra: "Recovered extra" }));
            expect(extraField().value).toBe("Recovered extra");
            expect(visibleText()).not.toContain(
                "The pending field edit cannot be reviewed or sent",
            );
            expect(cardText()).toContain("Recovered extra");
            expect(button("Review full request").disabled).toBe(false);
            await approveAndSend();
            expect(calls.deliver).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({ payload: { value: 42, extra: "Recovered extra" } }),
                expect.any(AbortSignal),
            );
            expect(calls.extract).toHaveBeenCalledOnce();
        },
    );

    it("clears a pending oversized field when the user explicitly restores identical canonical JSON", async () => {
        const originalJson = workspace.state.editorJson;
        await changeExtra("x".repeat(65536));
        expect(button("Review full request").disabled).toBe(true);
        await changeJson(originalJson);
        expect(extraField().value).toBe("Also sent");
        expect(visibleText()).not.toContain("The pending field edit cannot be reviewed or sent");
        expect(button("Review full request").disabled).toBe(false);
        expect(cardText()).toContain("Also sent");
        expect(calls.deliver).not.toHaveBeenCalled();
    });

    it("preserves an oversized pending edit across Close and reopen without approving old values", async () => {
        button("Review full request").click();
        await settle();
        const firstApproval = workspace.state.draft!.approval!.approvalId;
        const oversized = "x".repeat(65536);
        await changeExtra(oversized);
        button("Close").click();
        await settle();
        expect(workspace.state.open).toBe(false);
        expect(target.querySelector<HTMLElement>('[aria-label="Local app cards"]')!.hidden).toBe(
            true,
        );
        expect(extraField().value).toBe(oversized);
        expect(workspace.state.draft!.approval).toBeUndefined();
        await workspace.confirm(firstApproval);
        expect(calls.deliver).not.toHaveBeenCalled();
        workspace.open();
        await settle();
        expect(target.querySelector<HTMLElement>('[aria-label="Local app cards"]')!.hidden).toBe(
            false,
        );
        expect(extraField().value).toBe(oversized);
        expect(button("Review full request").disabled).toBe(true);
        expect(preview()).toBeNull();
        await changeExtra("Recovered after reopening");
        await approveAndSend();
        expect(calls.deliver).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ payload: { value: 42, extra: "Recovered after reopening" } }),
            expect.any(AbortSignal),
        );
        expect(calls.extract).toHaveBeenCalledOnce();
    });

    it.each(["draft", "account"] as const)(
        "does not retain blocked edits or approvals after replacing the %s",
        async (replacement) => {
            button("Review full request").click();
            await settle();
            const firstApproval = workspace.state.draft!.approval!.approvalId;
            const firstDraft = workspace.state.draft!.id;
            await changeExtra("x".repeat(65536));
            expect(button("Review full request").disabled).toBe(true);
            if (replacement === "account") {
                (currentUserIdStore as unknown as Writable<string>).set(
                    "another-synthetic-account",
                );
                await settle();
                expect(workspace.state.account).toBe("another-synthetic-account");
                expect(workspace.state.draft).toBeUndefined();
                expect(target.querySelector('[aria-label="Local app cards"]')).toBeNull();
                await vi.waitFor(() => expect(workspace.state.setupLoading).toBe(false));
                expect(workspace.importCatalog(catalog)).toBe(true);
                expect(workspace.select("synthetic", "capture")).toBe(true);
            } else {
                workspace.discard();
                await settle();
                expect(workspace.state.draft).toBeUndefined();
            }
            calls.extract.mockResolvedValue({
                kind: "extracted",
                candidates: [{ value: 73, extra: "Fresh draft" }],
            });
            await propose();
            expect(workspace.state.draft!.id).not.toBe(firstDraft);
            expect(workspace.state.draft!.approval).toBeUndefined();
            expect(extraField().value).toBe("Fresh draft");
            expect(numericFields()[0].disabled).toBe(false);
            expect(button("Review full request").disabled).toBe(false);
            expect(visibleText()).not.toContain(
                "The pending field edit cannot be reviewed or sent",
            );
            await workspace.confirm(firstApproval);
            expect(calls.deliver).not.toHaveBeenCalled();
            await approveAndSend();
            expect(calls.deliver).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({ payload: { value: 73, extra: "Fresh draft" } }),
                expect.any(AbortSignal),
            );
            expect(calls.extract).toHaveBeenCalledTimes(2);
        },
    );
});
