// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { MessageContent, OpenChat } from "@client";
import type {
  extractPrivateAppAction,
  PrivateAppExtractionResult,
} from "./aiActionRunner";
import type { runIsolatedAppProcessor } from "./isolatedAppProcessor";
import type { LocalDraftDelivery } from "./localAppDrafts";
import { PrivateAppWorkspace } from "./privateAppWorkspace";

vi.mock("@client", () => ({
  currentUserIdStore: { value: "synthetic-account" },
}));
vi.mock("@shared", () => ({ ANON_USER_ID: "anonymous" }));
vi.mock("./aiActionRunner", () => ({ extractPrivateAppAction: vi.fn() }));
vi.mock("./isolatedAppProcessor", () => ({
  runIsolatedAppProcessor: vi.fn(),
  verifyImportedLocalProcessor: vi.fn(),
}));
vi.mock("./localAppRelayDelivery", () => ({
  deliverLocalAppViaRelay: vi.fn(),
  cancelLocalAppHandoffs: vi.fn(),
}));

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
  ...(processor
    ? { processor: { sha256: "a".repeat(64), byteLength: 4 } }
    : {}),
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

function fixture(processor = false) {
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
  };
  const workspace = new PrivateAppWorkspace(deps);
  workspace.setAccount("test-account");
  workspace.importCatalog(catalog(processor));
  workspace.select("one", "add");
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
    expect(JSON.stringify(workspace.state)).not.toContain(
      "synthetic private source",
    );
    workspace.review();
    await workspace.confirm(workspace.state.draft!.approval!.approvalId);
    expect(JSON.stringify(deps.deliver.mock.calls)).not.toContain(
      "synthetic private source",
    );
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
    expect(workspace.state.draft?.target.destination).toBe(
      "https://example.test/one",
    );
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
    expect(workspace.state.message).toContain(
      "Nothing is fetched automatically",
    );
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
        ...args: Parameters<
          typeof import("./aiActionRunner").extractPrivateAppAction
        >
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
    await Promise.all([
      workspace.confirm(approval),
      workspace.confirm(approval),
    ]);
    workspace.setAccount("test-account");
    await workspace.confirm(approval);
    expect(deps.deliver).toHaveBeenCalledOnce();
    expect(workspace.state.draft?.status).toBe("uncertain");
    expect(JSON.stringify(workspace.state)).not.toContain(
      "private-provider-data",
    );
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
    expect(JSON.stringify(workspace.state)).not.toContain(
      "private model content",
    );
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it("retries uncertainty only on an explicit choice with the exact same immutable approval and import ID", async () => {
    const { workspace, deps } = fixture();
    await propose(workspace); workspace.review();
    const approval = workspace.state.draft!.approval!;
    deps.deliver.mockResolvedValueOnce({ kind: "uncertain" });
    await workspace.confirm(approval.approvalId);
    workspace.setAccount("test-account");
    expect(deps.deliver).toHaveBeenCalledOnce();
    await workspace.retryUncertain("incorrect"); expect(deps.deliver).toHaveBeenCalledOnce();
    await Promise.all([workspace.retryUncertain(approval.approvalId), workspace.retryUncertain(approval.approvalId)]);
    expect(deps.deliver).toHaveBeenCalledTimes(2);
    expect(deps.deliver.mock.calls[0][0]).toBe(deps.deliver.mock.calls[1][0]);
    expect(workspace.state.draft!.approval).toBe(approval);
    expect(workspace.state.draft!.status).toBe("delivered");
  });

  it("uses the native adapter only for a native local-test profile and never falls back after native failure", async () => {
    const { workspace, deps } = fixture();
    const nativeClient = { clientOnlyApps: () => true, isNativeApp: () => true, existingAccountOnly: () => true } as OpenChat;
    await workspace.propose(nativeClient, text, { stillCurrent: () => true }); workspace.review();
    deps.nativeDeliver.mockRejectedValueOnce(new Error("unavailable native bridge"));
    await workspace.confirm(workspace.state.draft!.approval!.approvalId);
    expect(deps.nativeDeliver).toHaveBeenCalledOnce(); expect(deps.deliver).not.toHaveBeenCalled();
    expect(workspace.state.draft!.status).toBe("uncertain");
  });

  it("rechecks native authorization at confirmation and explicit retry", async () => {
    const { workspace, deps } = fixture();
    let allowed = false;
    const nativeClient = { clientOnlyApps: () => true, isNativeApp: () => true, existingAccountOnly: () => allowed } as OpenChat;
    await workspace.propose(nativeClient, text, { stillCurrent: () => true }); workspace.review();
    const approval = workspace.state.draft!.approval!.approvalId;
    await workspace.confirm(approval);
    expect(deps.nativeDeliver).not.toHaveBeenCalled(); expect(deps.deliver).not.toHaveBeenCalled();
    allowed = true; await workspace.retryUncertain(approval);
    expect(deps.nativeDeliver).toHaveBeenCalledOnce(); expect(deps.deliver).not.toHaveBeenCalled();
  });

  it("never retargets a native draft to the browser if its runtime gate disappears", async () => {
    const { workspace, deps } = fixture();
    let native = true;
    const nativeClient = { clientOnlyApps: () => true, isNativeApp: () => native, existingAccountOnly: () => true } as OpenChat;
    await workspace.propose(nativeClient, text, { stillCurrent: () => true }); workspace.review();
    native = false;
    await workspace.confirm(workspace.state.draft!.approval!.approvalId);
    expect(deps.nativeDeliver).not.toHaveBeenCalled(); expect(deps.deliver).not.toHaveBeenCalled();
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
