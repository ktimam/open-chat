// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { MessageContent, OpenChat } from "@client";
import type { extractPrivateAppAction, PrivateAppExtractionResult } from "./aiActionRunner";
import { verifyImportedLocalProcessor, type runIsolatedAppProcessor } from "./isolatedAppProcessor";
import type { LocalDraftDelivery, LocalDraftSchema } from "./localAppDrafts";
import { PrivateAppWorkspace } from "./privateAppWorkspace";
import { parseLocalAppCatalog } from "./localAppCatalog";
import type {
    LocalAppSetupScope,
    LocalAppSetupSnapshot,
    LocalAppSetupStorage,
} from "./localAppSetupStore";

vi.mock("@client", () => ({
    currentUserIdStore: { value: "synthetic-account" },
}));
vi.mock("@shared", () => ({ ANON_USER_ID: "anonymous" }));
vi.mock("./aiActionRunner", () => ({ extractPrivateAppAction: vi.fn() }));
vi.mock("./isolatedAppProcessor", () => ({
    runIsolatedAppProcessor: vi.fn(),
    verifyImportedLocalProcessor: vi.fn(),
}));
vi.mock("./localAppRelayDelivery", async () => {
    const { writable } = await import("svelte/store");
    return {
        deliverLocalAppViaRelay: vi.fn(),
        cancelLocalAppHandoffs: vi.fn(),
        localAppDeliveryStatus: writable(undefined),
    };
});

const text = {
    kind: "text_content",
    text: "synthetic private source",
} as MessageContent;
const client = { clientOnlyApps: () => true } as OpenChat;
const app = (id: string, processor = false) => ({
    id,
    revision: "1",
    name: "Test app",
    description: "Synthetic test app",
    destination: `https://example.test/${id}`,
    recipientLabel: "Review account in app",
    ...(processor ? { processor: { sha256: "a".repeat(64), byteLength: 4 } } : {}),
    actions: [
        {
            definition: {
                name: "add",
                description: "Add test item",
                promptTemplate: "Read the selected message",
                responseSchema: { type: "object" },
                card: {
                    title: "Test",
                    rows: [{ label: "Value", valueKey: "value" }],
                    confirmLabel: "Send",
                    cancelLabel: "Cancel",
                },
            },
            draftSchema: {
                type: "object",
                properties: { value: { type: "number" } },
                required: ["value"],
                additionalProperties: false,
            },
            handoff: { kind: "single" },
            processorContext: { customLabels: ["user-defined"] },
        },
    ],
});
const catalog = (processor = false) =>
    JSON.stringify({ version: 1, apps: [app("one", processor), app("two")] });

function fixture(processor = false, setupStorage?: LocalAppSetupStorage) {
    const deps = {
        extract: vi.fn<typeof extractPrivateAppAction>(async () => ({
            kind: "extracted",
            candidates: [{ value: 42 }],
        })),
        runProcessor: vi.fn<typeof runIsolatedAppProcessor>(async () => ({
            kind: "candidates",
            candidates: [{ value: 42 }],
        })),
        verifyProcessor: vi.fn(async () => true),
        deliver: vi.fn<LocalDraftDelivery>(async () => ({ kind: "delivered" })),
        nativeDeliver: vi.fn<LocalDraftDelivery>(async () => ({ kind: "delivered" })),
        cancelDelivery: vi.fn(),
        deliverySaved: vi.fn(() => false),
        setupStorage,
    };
    const workspace = new PrivateAppWorkspace(deps);
    if (!setupStorage) {
        workspace.setAccount("test-account");
        workspace.importCatalog(catalog(processor));
        workspace.select("one", "add");
    }
    return { workspace, deps };
}
const propose = (workspace: PrivateAppWorkspace) =>
    workspace.propose(client, text, { stillCurrent: () => true });

describe("private app workspace boundaries", () => {
    it("imports and extracts locally with no delivery until a separate review and confirmation", async () => {
        const { workspace, deps } = fixture();
        expect(deps.extract).not.toHaveBeenCalled();
        await expect(propose(workspace)).resolves.toBe("drafted");
        expect(deps.deliver).not.toHaveBeenCalled();
        expect(workspace.state.draft?.payload).toEqual({ value: 42 });
        expect(workspace.review()).toBe(true);
        expect(deps.deliver).not.toHaveBeenCalled();
        const approval = workspace.state.draft!.approval!;
        expect(approval.summary).toContain("https://example.test/one");
        expect(approval.summary).toContain('"value": 42');
        await workspace.confirm(approval.approvalId);
        expect(deps.deliver).toHaveBeenCalledExactlyOnceWith(
            approval.request,
            expect.any(AbortSignal),
        );
        expect(workspace.state.message).toContain("not proof");
    });

    it("does not retain or transmit original source data in the draft", async () => {
        const { workspace, deps } = fixture();
        await propose(workspace);
        expect(JSON.stringify(workspace.state)).not.toContain("synthetic private source");
        workspace.review();
        await workspace.confirm(workspace.state.draft!.approval!.approvalId);
        expect(JSON.stringify(deps.deliver.mock.calls)).not.toContain("synthetic private source");
    });

    it("invalidates approval even while edits contain invalid JSON", async () => {
        const { workspace, deps } = fixture();
        await propose(workspace);
        workspace.review();
        const old = workspace.state.draft!.approval!.approvalId;
        workspace.edit("{invalid", "test recipient");
        expect(workspace.state.draft?.approval).toBeUndefined();
        expect(workspace.review()).toBe(false);
        await workspace.confirm(old);
        expect(deps.deliver).not.toHaveBeenCalled();
        workspace.edit('{"value":44}', "new review label");
        workspace.review();
        const updated = workspace.state.draft!.approval!;
        expect(updated.request.recipient).toBe("new review label");
        expect(updated.request.payload).toEqual({ value: 44 });
    });

    it("keeps destination pinned to the selected catalog and blocks silent retargeting", async () => {
        const { workspace } = fixture();
        await propose(workspace);
        expect(workspace.select("two", "add")).toBe(false);
        expect(workspace.importCatalog(catalog())).toBe(false);
        expect(workspace.state.draft?.target.destination).toBe("https://example.test/one");
        workspace.discard();
        expect(workspace.chooseApp("two")).toBe(true);
        expect(workspace.selection()).toBeUndefined();
        expect(workspace.select("two", "add")).toBe(true);
    });

    it("clears old action/processor immediately when another app is selected", async () => {
        const { workspace, deps } = fixture(true);
        await workspace.importProcessor("test");
        workspace.chooseApp("two");
        expect(workspace.state.processorReady).toBe(false);
        expect(workspace.state.actionId).toBeUndefined();
        await expect(propose(workspace)).resolves.toBe("retryable");
        expect(deps.extract).not.toHaveBeenCalled();
    });

    it("explains setup without fetching any catalog or starting inference", async () => {
        const { workspace, deps } = fixture();
        workspace.clear();
        await expect(propose(workspace)).resolves.toBe("retryable");
        expect(workspace.state.open).toBe(true);
        expect(workspace.state.message).toContain("Nothing is fetched automatically");
        expect(deps.extract).not.toHaveBeenCalled();
        expect(deps.deliver).not.toHaveBeenCalled();
    });

    it("requires a hash-matching processor before data is supplied to app code", async () => {
        const { workspace, deps } = fixture(true);
        await propose(workspace);
        expect(deps.extract).not.toHaveBeenCalled();
        deps.verifyProcessor.mockResolvedValueOnce(false);
        expect(await workspace.importProcessor("wrong")).toBe(false);
        await propose(workspace);
        expect(deps.runProcessor).not.toHaveBeenCalled();
        expect(await workspace.importProcessor("test")).toBe(true);
        await propose(workspace);
        expect(deps.extract).toHaveBeenCalledOnce();
    });

    it("passes only explicit input and app-owned context to the isolated processor", async () => {
        const { workspace, deps } = fixture(true);
        await workspace.importProcessor("test");
        deps.extract.mockImplementationOnce(
            async (
                ...args: Parameters<typeof import("./aiActionRunner").extractPrivateAppAction>
            ) => {
                const processor = args[3].processor!;
                await processor(
                    "add",
                    { operation: "extract", modality: "text", text: "synthetic source" },
                    () => true,
                );
                return { kind: "extracted", candidates: [{ value: 42 }] };
            },
        );
        await propose(workspace);
        expect(deps.runProcessor).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ source: "test", sha256: "a".repeat(64) }),
            "add",
            JSON.stringify({
                operation: "extract",
                modality: "text",
                text: "synthetic source",
            }),
            {
                signal: expect.any(AbortSignal),
                contextJson: JSON.stringify({ customLabels: ["user-defined"] }),
            },
        );
    });

    it("retains setup and draft on same-account reconnect, clears all on account change", async () => {
        const { workspace } = fixture(true);
        await workspace.importProcessor("test");
        await propose(workspace);
        const id = workspace.state.draft!.id;
        workspace.setAccount("test-account");
        expect(workspace.state.draft!.id).toBe(id);
        expect(workspace.state.processorReady).toBe(true);
        workspace.setAccount("different-account");
        expect(workspace.state.catalog).toBeUndefined();
        expect(workspace.state.draft).toBeUndefined();
        expect(workspace.state.processorReady).toBe(false);
        expect(workspace.state.editorJson).toBe("");
    });

    it("does not resurrect a result after account change or source change", async () => {
        const { workspace, deps } = fixture();
        let finish!: (value: PrivateAppExtractionResult) => void;
        deps.extract.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const pending = propose(workspace);
        workspace.setAccount(undefined);
        finish({ kind: "extracted", candidates: [{ value: 42 }] });
        expect(await pending).toBe("retryable");
        expect(workspace.state.draft).toBeUndefined();
        expect(deps.deliver).not.toHaveBeenCalled();
    });

    it("does not keep a hash verification result after logout", async () => {
        const { workspace, deps } = fixture(true);
        let finish!: (valid: boolean) => void;
        deps.verifyProcessor.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const pending = workspace.importProcessor("test");
        workspace.setAccount(undefined);
        finish(true);
        expect(await pending).toBe(false);
        expect(workspace.state.processorReady).toBe(false);
        expect(workspace.state.catalog).toBeUndefined();
    });

    it("discards a proposal after the source context changes without sending or showing stale values", async () => {
        const { workspace, deps } = fixture();
        let current = true;
        let finish!: (value: PrivateAppExtractionResult) => void;
        deps.extract.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const pending = workspace.propose(client, text, {
            stillCurrent: () => current,
        });
        current = false;
        finish({ kind: "extracted", candidates: [{ value: 42 }] });
        expect(await pending).toBe("retryable");
        expect(workspace.state.draft).toBeUndefined();
        expect(workspace.state.busy).toBe(false);
        expect(deps.deliver).not.toHaveBeenCalled();
    });

    it("prevents duplicate confirmation and does not retry unknown delivery on reconnect", async () => {
        const { workspace, deps } = fixture();
        await propose(workspace);
        workspace.review();
        deps.deliver.mockRejectedValueOnce(new Error("private-provider-data"));
        const approval = workspace.state.draft!.approval!.approvalId;
        await Promise.all([workspace.confirm(approval), workspace.confirm(approval)]);
        workspace.setAccount("test-account");
        await workspace.confirm(approval);
        expect(deps.deliver).toHaveBeenCalledOnce();
        expect(workspace.state.draft?.status).toBe("uncertain");
        expect(JSON.stringify(workspace.state)).not.toContain("private-provider-data");
        workspace.discard();
        expect(workspace.state.message).toContain("may already have occurred");
    });

    it("never displays raw model/provider output on an extraction failure", async () => {
        const { workspace, deps } = fixture();
        deps.extract.mockResolvedValueOnce({
            kind: "no_extraction",
            raw: "private model content",
        });
        await propose(workspace);
        expect(JSON.stringify(workspace.state)).not.toContain("private model content");
        expect(deps.deliver).not.toHaveBeenCalled();
    });

    it("retries uncertainty only on an explicit choice with the exact same immutable approval and import ID", async () => {
        const { workspace, deps } = fixture();
        await propose(workspace);
        workspace.review();
        const approval = workspace.state.draft!.approval!;
        deps.deliver.mockResolvedValueOnce({ kind: "uncertain" });
        await workspace.confirm(approval.approvalId);
        workspace.setAccount("test-account");
        expect(deps.deliver).toHaveBeenCalledOnce();
        await workspace.retryUncertain("incorrect");
        expect(deps.deliver).toHaveBeenCalledOnce();
        await Promise.all([
            workspace.retryUncertain(approval.approvalId),
            workspace.retryUncertain(approval.approvalId),
        ]);
        expect(deps.deliver).toHaveBeenCalledTimes(2);
        expect(deps.deliver.mock.calls[0][0]).toBe(deps.deliver.mock.calls[1][0]);
        expect(workspace.state.draft!.approval).toBe(approval);
        expect(workspace.state.draft!.status).toBe("delivered");
    });

    it.each([false, true])(
        "reopens a received handoff without re-extraction or changing the request (native=%s)",
        async (native) => {
            const { workspace, deps } = fixture();
            const runtimeClient = {
                clientOnlyApps: () => true,
                isNativeApp: () => native,
            } as OpenChat;
            await workspace.propose(runtimeClient, text, { stillCurrent: () => true });
            workspace.review();
            const approval = workspace.state.draft!.approval!;
            const transport = native ? deps.nativeDeliver : deps.deliver;
            await workspace.confirm(approval.approvalId);
            workspace.close();
            workspace.open();
            workspace.setAccount("test-account");
            expect(transport).toHaveBeenCalledOnce();
            await workspace.confirm(approval.approvalId);
            await workspace.retryUncertain(approval.approvalId);
            await workspace.reopenDelivered("wrong");
            expect(transport).toHaveBeenCalledOnce();
            await Promise.all([
                workspace.reopenDelivered(approval.approvalId),
                workspace.reopenDelivered(approval.approvalId),
            ]);
            expect(transport).toHaveBeenCalledTimes(2);
            expect(transport.mock.calls[1][0]).toBe(approval.request);
            expect(workspace.state.draft!.approval).toBe(approval);
            expect(deps.deliverySaved).toHaveBeenCalledExactlyOnceWith(
                approval.request.idempotencyKey,
            );
            expect(deps.extract).toHaveBeenCalledOnce();
            expect(native ? deps.deliver : deps.nativeDeliver).not.toHaveBeenCalled();
        },
    );

    it("checks the app's save report again before reopening an acknowledged handoff", async () => {
        const { workspace, deps } = fixture();
        await propose(workspace);
        workspace.review();
        const approval = workspace.state.draft!.approval!;
        await workspace.confirm(approval.approvalId);
        deps.deliverySaved.mockReturnValue(true);
        await workspace.reopenDelivered(approval.approvalId);
        expect(deps.deliverySaved).toHaveBeenCalledExactlyOnceWith(approval.request.idempotencyKey);
        expect(deps.deliver).toHaveBeenCalledOnce();
        expect(deps.extract).toHaveBeenCalledOnce();
        expect(workspace.state.draft!.status).toBe("delivered");
    });

    it("rechecks native profile authority on reopen without falling back or re-inferring", async () => {
        const { workspace, deps } = fixture();
        let allowed = true;
        const runtimeClient = {
            clientOnlyApps: () => allowed,
            isNativeApp: () => true,
        } as OpenChat;
        await workspace.propose(runtimeClient, text, { stillCurrent: () => true });
        workspace.review();
        const approval = workspace.state.draft!.approval!.approvalId;
        await workspace.confirm(approval);
        allowed = false;
        await workspace.reopenDelivered(approval);
        expect(deps.nativeDeliver).toHaveBeenCalledOnce();
        expect(deps.deliver).not.toHaveBeenCalled();
        expect(deps.extract).toHaveBeenCalledOnce();
        expect(workspace.state.draft!.status).toBe("uncertain");
    });

    it("does not revive a reopened workspace after account change", async () => {
        const { workspace, deps } = fixture();
        await propose(workspace);
        workspace.review();
        const approval = workspace.state.draft!.approval!.approvalId;
        await workspace.confirm(approval);
        let finish!: (result: { kind: "delivered" }) => void;
        deps.deliver.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const reopened = workspace.reopenDelivered(approval);
        workspace.setAccount("different-account");
        finish({ kind: "delivered" });
        await reopened;
        expect(workspace.state.draft).toBeUndefined();
        expect(workspace.state.busy).toBe(false);
        expect(deps.extract).toHaveBeenCalledOnce();
        expect(deps.deliver).toHaveBeenCalledTimes(2);
    });

    it("uses the native adapter only for a native local-test profile and never falls back after native failure", async () => {
        const { workspace, deps } = fixture();
        const nativeClient = {
            clientOnlyApps: () => true,
            isNativeApp: () => true,
        } as OpenChat;
        await workspace.propose(nativeClient, text, { stillCurrent: () => true });
        workspace.review();
        deps.nativeDeliver.mockRejectedValueOnce(new Error("unavailable native bridge"));
        await workspace.confirm(workspace.state.draft!.approval!.approvalId);
        expect(deps.nativeDeliver).toHaveBeenCalledOnce();
        expect(deps.deliver).not.toHaveBeenCalled();
        expect(workspace.state.draft!.status).toBe("uncertain");
    });

    it("rechecks native authorization at confirmation and explicit retry", async () => {
        const { workspace, deps } = fixture();
        let allowed = true;
        const nativeClient = {
            clientOnlyApps: () => allowed,
            isNativeApp: () => true,
        } as OpenChat;
        await workspace.propose(nativeClient, text, { stillCurrent: () => true });
        workspace.review();
        const approval = workspace.state.draft!.approval!.approvalId;
        allowed = false;
        await workspace.confirm(approval);
        expect(deps.nativeDeliver).not.toHaveBeenCalled();
        expect(deps.deliver).not.toHaveBeenCalled();
        allowed = true;
        await workspace.retryUncertain(approval);
        expect(deps.nativeDeliver).toHaveBeenCalledOnce();
        expect(deps.deliver).not.toHaveBeenCalled();
    });

    it("never retargets a native draft to the browser if its runtime gate disappears", async () => {
        const { workspace, deps } = fixture();
        let native = true;
        const nativeClient = {
            clientOnlyApps: () => true,
            isNativeApp: () => native,
        } as OpenChat;
        await workspace.propose(nativeClient, text, { stillCurrent: () => true });
        workspace.review();
        native = false;
        await workspace.confirm(workspace.state.draft!.approval!.approvalId);
        expect(deps.nativeDeliver).not.toHaveBeenCalled();
        expect(deps.deliver).not.toHaveBeenCalled();
        expect(workspace.state.draft!.status).toBe("uncertain");
    });

    it("blocks unofficial-only processing in an ordinary client", async () => {
        const { workspace, deps } = fixture();
        await workspace.propose({ clientOnlyApps: () => false } as OpenChat, text, {
            stillCurrent: () => true,
        });
        expect(deps.extract).not.toHaveBeenCalled();
    });
});

function choiceFixture(
    rows = [{ preset: "a", label: "untrusted", side: "original", category: "unchanged" }],
) {
    const { workspace, deps } = fixture();
    const itemSchema: LocalDraftSchema = {
        type: "object",
        additionalProperties: false,
        properties: {
            preset: { type: "string" },
            label: { type: "string" },
            side: { type: "string" },
            category: { type: "string" },
            note: { type: "string" },
        },
    };
    const source = app("choices");
    const action = {
        ...source.actions[0],
        handoff: { kind: "list" },
        draftSchema: { type: "array", items: itemSchema },
        draftEditor: {
            version: 1,
            choices: [
                {
                    field: "preset",
                    label: "Saved preset",
                    noneLabel: "No preset",
                    options: ["a", "b"].map((value) => ({
                        value,
                        label: `Preset ${value}`,
                        assign: [{ field: "label", value: `Label ${value}` }],
                        defaults: [{ field: "side", value }],
                    })),
                },
            ],
        },
    };
    expect(
        workspace.importCatalog(
            JSON.stringify({ version: 1, apps: [{ ...source, actions: [action] }] }),
        ),
    ).toBe(true);
    expect(workspace.select("choices", "add")).toBe(true);
    deps.extract.mockResolvedValue({ kind: "extracted", candidates: rows });
    return { workspace, deps };
}
const choiceRows = (workspace: PrivateAppWorkspace) => JSON.parse(workspace.state.editorJson);

describe("workspace-owned named choice review", () => {
    it("initializes once and retains the original baseline across close, reconnect, recipient edits and review", async () => {
        const { workspace, deps } = choiceFixture();
        await expect(propose(workspace)).resolves.toBe("drafted");
        expect(choiceRows(workspace)).toEqual([
            { preset: "a", label: "Label a", side: "a", category: "unchanged" },
        ]);
        expect(workspace.review()).toBe(true);
        const old = workspace.state.draft!.approval!.approvalId;
        workspace.close();
        workspace.open();
        workspace.setAccount("test-account");
        workspace.editRecipient("new recipient");
        expect(workspace.state.draft?.approval).toBeUndefined();
        workspace.selectDraftChoice(0, "preset", "b");
        expect(choiceRows(workspace)[0]).toMatchObject({ side: "b", category: "unchanged" });
        workspace.selectDraftChoice(0, "preset", undefined);
        expect(choiceRows(workspace)).toEqual([{ side: "original", category: "unchanged" }]);
        expect(workspace.state.draftManualValues).toBe(false);
        await workspace.confirm(old);
        expect(deps.deliver).not.toHaveBeenCalled();
        expect(workspace.review()).toBe(true);
        await workspace.confirm(workspace.state.draft!.approval!.approvalId);
        expect(deps.deliver.mock.calls[0][0].payload).toEqual([
            { side: "original", category: "unchanged" },
        ]);
        expect(deps.extract).toHaveBeenCalledOnce();
        expect(deps.runProcessor).not.toHaveBeenCalled();
    });

    it.each([false, true])(
        "retains a same-value manual edit made before/after selection (before=%s)",
        async (before) => {
            const { workspace } = choiceFixture();
            await propose(workspace);
            if (before) workspace.selectDraftChoice(0, "preset", undefined);
            const manual = choiceRows(workspace)[0].side;
            workspace.editDraftField(0, "side", manual);
            workspace.selectDraftChoice(0, "preset", "b");
            workspace.selectDraftChoice(0, "preset", undefined);
            expect(choiceRows(workspace)).toEqual([{ side: manual, category: "unchanged" }]);
            expect(workspace.review()).toBe(true);
        },
    );

    it("isolates per-row history without changing unrelated fields", async () => {
        const { workspace } = choiceFixture([
            { preset: "a", label: "Label a", side: "left", category: "first" },
            { preset: "a", label: "Label a", side: "right", category: "second" },
        ]);
        await propose(workspace);
        workspace.editDraftField(0, "side", "manual");
        workspace.selectDraftChoice(0, "preset", "b");
        workspace.selectDraftChoice(1, "preset", "b");
        workspace.selectDraftChoice(0, "preset", undefined);
        workspace.selectDraftChoice(1, "preset", undefined);
        expect(choiceRows(workspace)).toEqual([
            { side: "manual", category: "first" },
            { side: "right", category: "second" },
        ]);
    });

    it("treats advanced JSON recovery and reordered rows as authoritative, never reapplying defaults", async () => {
        const { workspace } = choiceFixture();
        await propose(workspace);
        workspace.review();
        workspace.edit("{invalid", "recipient");
        expect(workspace.review()).toBe(false);
        expect(workspace.state.draft?.approval).toBeUndefined();
        workspace.edit(
            JSON.stringify([
                { category: "new", side: "explicit" },
                { category: "original", side: "a", preset: "a", label: "Label a" },
            ]),
            "recipient",
        );
        workspace.selectDraftChoice(0, "preset", "b");
        workspace.selectDraftChoice(1, "preset", "b");
        expect(choiceRows(workspace).map((row: { side: string }) => row.side)).toEqual([
            "explicit",
            "a",
        ]);
        workspace.selectDraftChoice(0, "preset", undefined);
        expect(choiceRows(workspace)[0]).toEqual({ category: "new", side: "explicit" });
        expect(workspace.state.draftManualValues).toBe(true);
        expect(workspace.review()).toBe(true);
    });

    it.each([
        { preset: "missing", label: "Label a" },
        { preset: "a", label: "wrong" },
        { label: "orphan" },
    ])("blocks inconsistent manually supplied app choices: %j", async (row) => {
        const { workspace, deps } = choiceFixture();
        await propose(workspace);
        workspace.review();
        const approval = workspace.state.draft!.approval!.approvalId;
        workspace.edit(JSON.stringify([row]), "recipient");
        expect(workspace.review()).toBe(false);
        await workspace.confirm(approval);
        expect(deps.deliver).not.toHaveBeenCalled();
        workspace.selectDraftChoice(0, "preset", "b");
        expect(workspace.review()).toBe(true);
    });

    it("revokes approval on a failed atomic field edit and does not unblock it through recipient changes", async () => {
        const { workspace, deps } = choiceFixture();
        await propose(workspace);
        workspace.review();
        const old = workspace.state.draft!.approval!.approvalId;
        const json = workspace.state.editorJson;
        expect(() => workspace.editDraftField(0, "note", "x".repeat(70_000))).toThrow();
        expect(workspace.state.editorJson).toBe(json);
        expect(workspace.state.draft?.approval).toBeUndefined();
        workspace.editRecipient("new recipient");
        workspace.invalidateReview();
        expect(workspace.review()).toBe(false);
        await workspace.confirm(old);
        expect(deps.deliver).not.toHaveBeenCalled();
        workspace.editDraftField(0, "note", "fixed");
        expect(workspace.review()).toBe(true);
    });

    it("rejects direct selector and companion field edits without silently changing the draft", async () => {
        const { workspace } = choiceFixture();
        await propose(workspace);
        const json = workspace.state.editorJson;
        expect(() => workspace.editDraftField(0, "preset", "b")).toThrow();
        expect(() => workspace.editDraftField(0, "label", "forged")).toThrow();
        expect(workspace.state.editorJson).toBe(json);
        expect(workspace.review()).toBe(false);
        workspace.selectDraftChoice(0, "preset", "b");
        expect(workspace.review()).toBe(true);
    });

    it.each(["delivered", "uncertain"] as const)(
        "keeps sending and %s drafts immutable",
        async (status) => {
            const { workspace, deps } = choiceFixture();
            await propose(workspace);
            workspace.review();
            const old = workspace.state.editorJson;
            const pending = deferred<{ kind: "delivered" | "uncertain" }>();
            deps.deliver.mockReturnValueOnce(pending.promise);
            const sending = workspace.confirm(workspace.state.draft!.approval!.approvalId);
            expect(workspace.state.draft?.status).toBe("sending");
            expect(() => workspace.selectDraftChoice(0, "preset", "b")).toThrow();
            workspace.edit("[]", "changed");
            workspace.editRecipient("changed");
            expect(workspace.state.editorJson).toBe(old);
            pending.resolve({ kind: status });
            await sending;
            expect(workspace.state.draft?.status).toBe(status);
            expect(() => workspace.editDraftField(0, "side", "changed")).toThrow();
            workspace.edit("[]", "changed");
            expect(workspace.state.editorJson).toBe(old);
        },
    );

    it("discards manual history before another proposal and never exposes it in state or delivery", async () => {
        const { workspace, deps } = choiceFixture();
        await propose(workspace);
        workspace.editDraftField(0, "side", "private previous value");
        workspace.discard();
        expect(workspace.state.draftManualValues).toBe(false);
        await propose(workspace);
        workspace.selectDraftChoice(0, "preset", undefined);
        expect(choiceRows(workspace)[0].side).toBe("original");
        workspace.review();
        await workspace.confirm(workspace.state.draft!.approval!.approvalId);
        expect(JSON.stringify([workspace.state, deps.deliver.mock.calls])).not.toContain(
            "private previous value",
        );
        expect(deps.deliver.mock.calls[0][0].payload).toEqual([
            { category: "unchanged", side: "original" },
        ]);
        workspace.clear();
        expect(workspace.state.draft).toBeUndefined();
        expect(workspace.state.draftManualValues).toBe(false);
        expect(() => workspace.selectDraftChoice(0, "preset", "b")).toThrow();
    });
});

const scopeKey = (scope: LocalAppSetupScope) => JSON.stringify([scope.account, scope.backend]);
const savedSetup = (): LocalAppSetupSnapshot => ({
    catalog: parseLocalAppCatalog(catalog()),
    appId: "one",
    actionId: "add",
    enabledChats: [{ chatKey: "synthetic-chat", appIds: ["one"] }],
});
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((finish) => {
        resolve = finish;
    });
    return { promise, resolve };
};
function memorySetupStorage() {
    const entries = new Map<string, LocalAppSetupSnapshot>();
    const storage = {
        read: vi.fn(async (scope: LocalAppSetupScope) => entries.get(scopeKey(scope))),
        write: vi.fn(async (scope: LocalAppSetupScope, snapshot: LocalAppSetupSnapshot) => {
            entries.set(scopeKey(scope), snapshot);
        }),
        remove: vi.fn(async (scope: LocalAppSetupScope) => {
            entries.delete(scopeKey(scope));
        }),
    };
    return { entries, storage };
}
async function connect(
    workspace: PrivateAppWorkspace,
    account = "account-a",
    backend = "backend-a",
) {
    workspace.setAccount(account, backend);
    await vi.waitFor(() => expect(workspace.state.setupLoading).toBe(false));
}
const saved = (workspace: PrivateAppWorkspace) =>
    vi.waitFor(() => expect(workspace.state.setupStatus).toContain("App setup saved"));

describe("private app setup-only persistence", () => {
    it("restores validated setup and opt-ins without creating drafts or running app code", async () => {
        const { storage, entries } = memorySetupStorage();
        entries.set(scopeKey({ account: "account-a", backend: "backend-a" }), savedSetup());
        const { workspace, deps } = fixture(false, storage);
        await connect(workspace);
        expect(workspace.selection()?.app.id).toBe("one");
        expect(workspace.state.processorReady).toBe(true);
        expect(workspace.enabledChatsSnapshot()).toEqual(savedSetup().enabledChats);
        expect(workspace.state.draft).toBeUndefined();
        expect(workspace.state.editorJson).toBe("");
        expect(workspace.state.recipient).toBe("");
        expect(storage.write).not.toHaveBeenCalled();
        expect(deps.extract).not.toHaveBeenCalled();
        expect(deps.runProcessor).not.toHaveBeenCalled();
        expect(deps.deliver).not.toHaveBeenCalled();
        expect(workspace.state.setupStatus).toContain("restored");
        expect(Object.isFrozen(workspace.state.enabledChats)).toBe(true);
    });

    it("blocks setup and propose while loading and never falls back to a shared backend namespace", async () => {
        const { storage } = memorySetupStorage();
        const pending = deferred<LocalAppSetupSnapshot | undefined>();
        storage.read.mockReturnValueOnce(pending.promise);
        const { workspace, deps } = fixture(false, storage);
        workspace.setAccount("account-a");
        expect(workspace.importCatalog(catalog())).toBe(false);
        await expect(propose(workspace)).resolves.toBe("retryable");
        expect(storage.read).not.toHaveBeenCalled();
        workspace.setAccount("account-a", "backend-a");
        expect(workspace.state.setupLoading).toBe(true);
        expect(workspace.importCatalog(catalog())).toBe(false);
        expect(workspace.select("one", "add")).toBe(false);
        expect(workspace.chooseApp("one")).toBe(false);
        await expect(workspace.importProcessor("test")).resolves.toBe(false);
        await expect(propose(workspace)).resolves.toBe("retryable");
        expect(deps.extract).not.toHaveBeenCalled();
        pending.resolve(savedSetup());
        await vi.waitFor(() => expect(workspace.state.setupLoading).toBe(false));
        expect(workspace.state.appId).toBe("one");
    });

    it("persists only explicit setup changes and never drafts, edits, approvals or deliveries", async () => {
        const { storage } = memorySetupStorage();
        const { workspace, deps } = fixture(false, storage);
        await connect(workspace);
        workspace.importCatalog(catalog());
        workspace.chooseApp("two");
        workspace.select("one", "add");
        const catalogRef = workspace.state.catalog!;
        expect(
            workspace.replaceEnabledChats("account-a", catalogRef, [
                { chatKey: "chat", appIds: ["one"] },
            ]),
        ).toBe(true);
        await saved(workspace);
        const writes = storage.write.mock.calls.length;
        expect(writes).toBe(4);
        const setupGeneration = workspace.state.setupGeneration;
        const optIns = workspace.state.enabledChats;
        workspace.open();
        workspace.close();
        await propose(workspace);
        workspace.edit('{"value":43}', "private recipient");
        workspace.review();
        await workspace.confirm(workspace.state.draft!.approval!.approvalId);
        workspace.discard();
        await Promise.resolve();
        expect(storage.write).toHaveBeenCalledTimes(writes);
        expect(workspace.state.setupGeneration).toBe(setupGeneration);
        expect(workspace.state.enabledChats).toBe(optIns);
        for (const [, snapshot] of storage.write.mock.calls) {
            expect(Object.keys(snapshot).sort()).toEqual([
                "actionId",
                "appId",
                "catalog",
                "disabledAppIds",
                "enabledChats",
                "installations",
                "processor",
                "processors",
            ]);
            expect(JSON.stringify(snapshot)).not.toMatch(
                /synthetic private source|private recipient|approvalId|idempotencyKey|editorJson/,
            );
        }
        expect(deps.extract).toHaveBeenCalledOnce();
        expect(deps.deliver).toHaveBeenCalledOnce();
    });

    it("persists explicit processor import and revalidates it on restore without executing it", async () => {
        const { storage } = memorySetupStorage();
        const { workspace, deps } = fixture(false, storage);
        await connect(workspace);
        workspace.importCatalog(catalog(true));
        workspace.select("one", "add");
        await workspace.importProcessor("test");
        await saved(workspace);
        expect(storage.write.mock.calls.at(-1)![1].processor).toEqual({
            source: "test",
            byteLength: 4,
            sha256: "a".repeat(64),
        });
        vi.mocked(verifyImportedLocalProcessor).mockResolvedValueOnce(true);
        workspace.setAccount(undefined);
        await connect(workspace);
        expect(workspace.state.processorReady).toBe(true);
        expect(verifyImportedLocalProcessor).toHaveBeenCalledWith({
            source: "test",
            byteLength: 4,
            sha256: "a".repeat(64),
        });
        expect(deps.extract).not.toHaveBeenCalled();
        expect(deps.runProcessor).not.toHaveBeenCalled();

        deps.verifyProcessor.mockResolvedValueOnce(false);
        await workspace.importProcessor("wrong");
        await saved(workspace);
        expect(storage.write.mock.calls.at(-1)![1].processor).toBeUndefined();
        workspace.setAccount(undefined);
        await connect(workspace);
        expect(workspace.state.processorReady).toBe(false);
    });

    it("clears opt-ins on catalog replacement and rejects stale or invalid chat updates", async () => {
        const { storage } = memorySetupStorage();
        const { workspace } = fixture(false, storage);
        await connect(workspace);
        workspace.importCatalog(catalog());
        const previous = workspace.state.catalog!;
        expect(
            workspace.replaceEnabledChats("account-a", previous, [
                { chatKey: "chat", appIds: ["one"] },
            ]),
        ).toBe(true);
        const generation = workspace.state.setupGeneration;
        workspace.importCatalog(catalog());
        expect(workspace.state.enabledChats).toEqual([]);
        expect(workspace.state.setupGeneration).toBeGreaterThan(generation);
        expect(
            workspace.replaceEnabledChats("account-a", previous, [
                { chatKey: "chat", appIds: ["one"] },
            ]),
        ).toBe(false);
        expect(
            workspace.replaceEnabledChats("other-account", workspace.state.catalog!, [
                { chatKey: "chat", appIds: ["one"] },
            ]),
        ).toBe(false);
        expect(
            workspace.replaceEnabledChats("account-a", workspace.state.catalog!, [
                { chatKey: "chat", appIds: ["unknown"] },
            ]),
        ).toBe(false);
        await saved(workspace);
        expect(storage.write.mock.calls.at(-1)![1].enabledChats).toEqual([]);
    });

    it("clears without loading during disposal, then restores on an explicit same-scope remount", async () => {
        const { storage, entries } = memorySetupStorage();
        entries.set(scopeKey({ account: "account-a", backend: "backend-a" }), savedSetup());
        const { workspace } = fixture(false, storage);
        await connect(workspace);
        await propose(workspace);
        workspace.clear();
        expect(workspace.state.catalog).toBeUndefined();
        expect(workspace.state.draft).toBeUndefined();
        expect(workspace.state.setupLoading).toBe(false);
        await Promise.resolve();
        expect(storage.read).toHaveBeenCalledOnce();
        await connect(workspace);
        expect(workspace.state.appId).toBe("one");
        expect(workspace.state.draft).toBeUndefined();
        expect(storage.read).toHaveBeenCalledTimes(2);
        expect(storage.write).not.toHaveBeenCalled();
    });

    it("rejects chat opt-in changes during processing or a draft without persisting them", async () => {
        const { storage, entries } = memorySetupStorage();
        entries.set(scopeKey({ account: "account-a", backend: "backend-a" }), savedSetup());
        const { workspace, deps } = fixture(false, storage);
        await connect(workspace);
        const pending = deferred<PrivateAppExtractionResult>();
        deps.extract.mockReturnValueOnce(pending.promise);
        const proposal = propose(workspace);
        const catalogRef = workspace.state.catalog!;
        expect(workspace.replaceEnabledChats("account-a", catalogRef, [])).toBe(false);
        expect(workspace.state.enabledChats).toEqual(savedSetup().enabledChats);
        pending.resolve({ kind: "extracted", candidates: [{ value: 42 }] });
        await proposal;
        expect(workspace.replaceEnabledChats("account-a", catalogRef, [])).toBe(false);
        expect(storage.write).not.toHaveBeenCalled();
        workspace.discard();
        expect(workspace.replaceEnabledChats("account-a", catalogRef, [])).toBe(true);
        await saved(workspace);
        expect(storage.write).toHaveBeenCalledOnce();
    });

    it("keeps account/backend A-B-A restoration races isolated", async () => {
        const { storage } = memorySetupStorage();
        const firstA = deferred<LocalAppSetupSnapshot | undefined>();
        storage.read.mockImplementationOnce(() => firstA.promise);
        storage.read.mockResolvedValueOnce({ ...savedSetup(), appId: "two", actionId: "add" });
        storage.read.mockResolvedValueOnce(savedSetup());
        const { workspace } = fixture(false, storage);
        workspace.setAccount("account-a", "backend-a");
        await vi.waitFor(() => expect(storage.read).toHaveBeenCalledTimes(1));
        await connect(workspace, "account-a", "backend-b");
        expect(workspace.state.appId).toBe("two");
        workspace.setAccount("account-a", "backend-a");
        expect(workspace.state.catalog).toBeUndefined();
        firstA.resolve({ ...savedSetup(), appId: "two", actionId: "add" });
        await vi.waitFor(() => expect(workspace.state.setupLoading).toBe(false));
        expect(workspace.state.appId).toBe("one");
        expect(storage.read.mock.calls.map(([scope]) => scope.backend)).toEqual([
            "backend-a",
            "backend-b",
            "backend-a",
        ]);
        workspace.setAccount("account-b", "backend-a");
        expect(workspace.state.catalog).toBeUndefined();
        await vi.waitFor(() => expect(workspace.state.setupLoading).toBe(false));
        expect(workspace.state.catalog).toBeUndefined();
    });

    it("clears sensitive draft state synchronously on backend change or logout and rejects stale restoration", async () => {
        const { storage } = memorySetupStorage();
        storage.read.mockResolvedValueOnce(savedSetup());
        const later = deferred<LocalAppSetupSnapshot | undefined>();
        storage.read.mockReturnValueOnce(later.promise);
        const { workspace } = fixture(false, storage);
        await connect(workspace);
        await propose(workspace);
        workspace.review();
        workspace.setAccount("account-a", "backend-b");
        expect(workspace.state.draft).toBeUndefined();
        expect(workspace.state.editorJson).toBe("");
        expect(workspace.state.recipient).toBe("");
        expect(workspace.state.catalog).toBeUndefined();
        workspace.setAccount(undefined);
        later.resolve(savedSetup());
        await Promise.resolve();
        await Promise.resolve();
        expect(workspace.state.account).toBeUndefined();
        expect(workspace.state.catalog).toBeUndefined();
        expect(workspace.state.setupLoading).toBe(false);
        expect(storage.write).not.toHaveBeenCalled();
    });

    it("surfaces storage failures separately without exposing error details or claiming a save", async () => {
        const { storage } = memorySetupStorage();
        storage.read.mockRejectedValueOnce(new Error("secret storage detail"));
        storage.write.mockRejectedValueOnce(new Error("secret quota detail"));
        const { workspace } = fixture(false, storage);
        await connect(workspace);
        expect(workspace.state.setupStatus).toContain("could not be restored");
        workspace.importCatalog(catalog());
        const proposalMessage = workspace.state.message;
        await vi.waitFor(() => expect(workspace.state.setupStatus).toContain("could not be saved"));
        expect(workspace.state.catalog).toBeDefined();
        expect(workspace.state.message).toBe(proposalMessage);
        expect(JSON.stringify(workspace.state)).not.toContain("secret");
        storage.remove.mockRejectedValueOnce(new Error("secret remove detail"));
        await expect(workspace.forgetSetup()).resolves.toBe(false);
        expect(workspace.state.catalog).toBeUndefined();
        expect(workspace.state.setupStatus).toContain("could not be removed");
        await expect(workspace.forgetSetup()).resolves.toBe(true);
    });

    it("forgets after pending writes, blocks mutations meanwhile, and cannot resurrect setup", async () => {
        const { storage, entries } = memorySetupStorage();
        const write = deferred<void>();
        storage.write.mockImplementationOnce(async (scope, snapshot) => {
            await write.promise;
            entries.set(scopeKey(scope), snapshot);
        });
        const { workspace } = fixture(false, storage);
        await connect(workspace);
        workspace.importCatalog(catalog());
        await vi.waitFor(() => expect(storage.write).toHaveBeenCalledOnce());
        const forgotten = workspace.forgetSetup();
        expect(workspace.state.catalog).toBeUndefined();
        expect(workspace.state.setupLoading).toBe(true);
        expect(workspace.importCatalog(catalog())).toBe(false);
        await expect(propose(workspace)).resolves.toBe("retryable");
        expect(storage.remove).not.toHaveBeenCalled();
        write.resolve();
        await expect(forgotten).resolves.toBe(true);
        expect(entries.size).toBe(0);
        workspace.setAccount(undefined);
        await connect(workspace);
        expect(workspace.state.catalog).toBeUndefined();
        expect(storage.write).toHaveBeenCalledOnce();
    });

    it("rejects malformed restored snapshots without restoring or executing them", async () => {
        const { storage } = memorySetupStorage();
        storage.read.mockResolvedValueOnce({
            ...savedSetup(),
            draft: { payload: "private" },
        } as LocalAppSetupSnapshot);
        const { workspace, deps } = fixture(false, storage);
        await connect(workspace);
        expect(workspace.state.catalog).toBeUndefined();
        expect(workspace.state.setupStatus).toContain("could not be restored");
        expect(deps.extract).not.toHaveBeenCalled();
        expect(deps.runProcessor).not.toHaveBeenCalled();
        expect(storage.write).not.toHaveBeenCalled();
    });
});
