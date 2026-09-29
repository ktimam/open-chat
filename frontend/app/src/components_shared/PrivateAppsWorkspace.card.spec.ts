// @vitest-environment jsdom
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentUserIdStore, type OpenChat, type MessageContent } from "@client";
import type { Writable } from "svelte/store";
import PrivateAppsWorkspace from "./PrivateAppsWorkspace.svelte";
import { privateAppWorkspace as workspace } from "../utils/privateAppWorkspace";

const calls = vi.hoisted(() => ({ extract: vi.fn(), deliver: vi.fn(), cancel: vi.fn() }));
vi.mock("@client", async () => {
    const { writable } = await import("svelte/store");
    return {
        currentUserIdStore: writable("synthetic-account"),
        identityStateStore: writable({ kind: "logged_in" }),
    };
});
vi.mock("@shared", () => ({ ANON_USER_ID: "anonymous" }));
vi.mock("../utils/aiActionRunner", () => ({ extractPrivateAppAction: calls.extract }));
vi.mock("../utils/isolatedAppProcessor", () => ({
    runIsolatedAppProcessor: vi.fn(),
    verifyImportedLocalProcessor: vi.fn(),
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
    [...target.querySelectorAll("button")].find((node) => node.textContent === label)!;
const preview = () => target.querySelector('[aria-label="App-declared draft preview"]')!;
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

beforeEach(async () => {
    vi.clearAllMocks();
    (currentUserIdStore as unknown as Writable<string>).set("synthetic-account");
    workspace.clear();
    workspace.setAccount("synthetic-account");
    calls.extract.mockResolvedValue({
        kind: "extracted",
        candidates: [{ value: 42, extra: "Also sent" }],
    });
    calls.deliver.mockResolvedValue({ kind: "delivered" });
    workspace.importCatalog(catalog);
    workspace.select("synthetic", "capture");
    target = document.createElement("div");
    document.body.append(target);
    client = {
        clientOnlyApps: () => true,
        isNativeApp: () => false,
        existingAccountOnly: () => true,
        onLogout: vi.fn(),
    } as unknown as OpenChat;
    mounted = mount(PrivateAppsWorkspace, { target, props: { client } });
    flushSync();
    await settle();
    await propose();
});
afterEach(async () => {
    if (mounted) await unmount(mounted);
    mounted = undefined;
    document.body.replaceChildren();
});

describe("private workspace declarative card and authoritative review", () => {
    it("starts proposals with setup and advanced JSON collapsed without hiding the complete review", async () => {
        const setup = target.querySelector<HTMLDetailsElement>("details.setup-disclosure")!;
        const advanced = target.querySelector<HTMLDetailsElement>("details.advanced-editor")!;
        expect(setup.open).toBe(false);
        expect(advanced.open).toBe(false);
        expect(setup.querySelector("summary")?.textContent).toContain("App setup");
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
        expect(review.closest("details")).toBeNull();
        expect(setup.open).toBe(false);
        expect(advanced.open).toBe(false);
        expect(calls.deliver).not.toHaveBeenCalled();
    });

    it("shows declared labels and additional fields without replacing explicit host sharing consent", async () => {
        expect(preview().textContent).toContain("App-defined title");
        expect(preview().textContent).toContain("App-defined value");
        expect(preview().textContent).toContain("Also sent");
        expect(editor().value).toContain('"extra": "Also sent"');
        expect(calls.deliver).not.toHaveBeenCalled();
        expect(visibleText()).not.toContain("Preview only");
        expect(visibleText()).not.toContain("Keep sending");
        button("Review full request").click();
        await settle();
        expect(button("Send reviewed request").disabled).toBe(true);
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
        expect(preview().textContent).toContain("43");
        expect(preview().textContent).toContain("Edited payload");
        expect(preview().textContent).not.toContain("Also sent");
        expect(workspace.state.draft!.approval).toBeUndefined();
        expect(button("Send reviewed request")).toBeUndefined();
        await workspace.confirm(firstApproval);
        expect(calls.deliver).not.toHaveBeenCalled();
        await changeJson('{"value":');
        expect(preview().textContent).toContain("Preview unavailable");
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
            expect(preview().textContent).toContain("FIRST ITEM MUST REMAIN");
            expect(preview().textContent).toContain("SECOND ITEM EXTRA");
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
            expect(preview().textContent).toContain("Recovered extra");
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
        expect(preview().textContent).toContain("Also sent");
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
        expect(
            target.querySelector<HTMLElement>('[aria-label="Private app workspace"]')!.hidden,
        ).toBe(true);
        expect(extraField().value).toBe(oversized);
        expect(workspace.state.draft!.approval).toBeUndefined();
        await workspace.confirm(firstApproval);
        expect(calls.deliver).not.toHaveBeenCalled();
        workspace.open();
        await settle();
        expect(
            target.querySelector<HTMLElement>('[aria-label="Private app workspace"]')!.hidden,
        ).toBe(false);
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
                expect(target.querySelector('[aria-label="Private app workspace"]')).toBeNull();
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
