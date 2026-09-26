import { writable } from "svelte/store";
import {
  currentUserIdStore,
  type OpenChat,
  type MessageContent,
} from "@client";
import { ANON_USER_ID } from "@shared";
import {
  extractPrivateAppAction,
  type ProposalPhase,
  type ProposalPhaseListener,
} from "./aiActionRunner";
import {
  parseLocalAppCatalog,
  projectLocalAppPayload,
  type LocalAppCatalog,
  type LocalAppCatalogEntry,
  type LocalAppAction,
} from "./localAppCatalog";
import {
  runIsolatedAppProcessor,
  verifyImportedLocalProcessor,
  type ImportedLocalProcessor,
} from "./isolatedAppProcessor";
import {
  LocalAppDraftStore,
  type LocalDraftDelivery,
  type LocalDraftView,
} from "./localAppDrafts";
import {
  deliverLocalAppViaRelay,
  cancelLocalAppHandoffs,
} from "./localAppRelayDelivery";

export interface PrivateAppWorkspaceState {
  open: boolean;
  account?: string;
  catalog?: LocalAppCatalog;
  appId?: string;
  actionId?: string;
  processorReady: boolean;
  busy: boolean;
  phase?: ProposalPhase;
  message: string;
  draft?: LocalDraftView;
  editorJson: string;
  recipient: string;
}

type Dependencies = {
  extract: typeof extractPrivateAppAction;
  runProcessor: typeof runIsolatedAppProcessor;
  verifyProcessor: typeof verifyImportedLocalProcessor;
  deliver: LocalDraftDelivery;
  cancelDelivery: () => void;
};
export type PrivateAppProposalOptions = {
  stillCurrent: () => boolean;
  sourceTimestamp?: number;
  onPhase?: ProposalPhaseListener;
};

const initial = (): PrivateAppWorkspaceState => ({
  open: false,
  processorReady: false,
  busy: false,
  editorJson: "",
  recipient: "",
  message:
    "Import an app catalog and select an action. Setup and drafts stay in memory only.",
});

/** Owns only private local drafts. No chat send, app registry lookup or persistence is available. */
export class PrivateAppWorkspace {
  #state = initial();
  #account?: string;
  #epoch = 0;
  #processor?: ImportedLocalProcessor;
  #abort?: AbortController;
  readonly #drafts: LocalAppDraftStore;

  constructor(
    private readonly deps: Dependencies,
    private readonly onChange: (
      state: PrivateAppWorkspaceState,
    ) => void = () => {},
  ) {
    this.#drafts = new LocalAppDraftStore(deps.deliver);
  }

  get state(): PrivateAppWorkspaceState {
    return { ...this.#state };
  }
  get contextVersion(): number {
    return this.#epoch;
  }
  #set(patch: Partial<PrivateAppWorkspaceState>) {
    this.#state = { ...this.#state, ...patch };
    this.onChange(this.state);
  }
  setAccount(account: string | undefined): void {
    if (account === this.#account) return;
    this.clear();
    this.#account = account;
    this.#drafts.setAccount(account);
    this.#set({ account });
  }
  clear(): void {
    ++this.#epoch;
    this.#abort?.abort();
    this.#abort = undefined;
    this.#processor = undefined;
    this.#drafts.clear();
    this.deps.cancelDelivery();
    this.#state = { ...initial(), account: this.#account };
    this.onChange(this.state);
  }
  open(): void {
    this.#set({ open: true });
  }
  close(): void {
    this.#set({ open: false });
  }
  reportImportFailure(): void {
    this.#set({ message: "Could not import this file. No app was contacted." });
  }

  #setupAllowed(): boolean {
    if (!this.#account) {
      this.#set({
        message:
          "Sign in to an existing account before importing private app setup.",
      });
      return false;
    }
    if (this.#state.busy || this.#state.draft) {
      this.#set({
        message:
          "Discard the current draft or cancel processing before changing app setup.",
      });
      return false;
    }
    return true;
  }

  importCatalog(json: string): boolean {
    if (!this.#setupAllowed()) return false;
    try {
      const catalog = parseLocalAppCatalog(json);
      ++this.#epoch;
      this.#processor = undefined;
      this.#set({
        catalog,
        appId: undefined,
        actionId: undefined,
        processorReady: false,
        message:
          "Catalog imported locally. Choose an app and action; no app connection has been opened.",
      });
      return true;
    } catch {
      this.reportImportFailure();
      return false;
    }
  }

  selection():
    | { app: LocalAppCatalogEntry; action: LocalAppAction }
    | undefined {
    const app = this.#state.catalog?.apps.find(
      (app) => app.id === this.#state.appId,
    );
    const action = app?.actions.find(
      (action) => action.definition.name === this.#state.actionId,
    );
    return app && action ? { app, action } : undefined;
  }

  chooseApp(appId: string): boolean {
    if (!this.#setupAllowed()) return false;
    if (appId && !this.#state.catalog?.apps.some((app) => app.id === appId))
      return false;
    ++this.#epoch;
    this.#processor = undefined;
    this.#set({
      appId: appId || undefined,
      actionId: undefined,
      processorReady: false,
      message: "Choose this app's action before proposing a message.",
    });
    return true;
  }

  select(appId: string, actionId: string): boolean {
    if (!this.#setupAllowed()) return false;
    const app = this.#state.catalog?.apps.find((app) => app.id === appId);
    const action = app?.actions.find(
      (action) => action.definition.name === actionId,
    );
    if (!app || !action) return false;
    ++this.#epoch;
    this.#processor = undefined;
    this.#set({
      appId,
      actionId,
      processorReady: app.processor === undefined,
      message: app.processor
        ? "Import this app's matching local processor file before proposing a message."
        : "Ready. Use Propose on one message to prepare a private draft.",
    });
    return true;
  }

  async importProcessor(source: string): Promise<boolean> {
    if (!this.#setupAllowed()) return false;
    const selection = this.selection();
    const descriptor = selection?.app.processor;
    if (!descriptor) {
      this.reportImportFailure();
      return false;
    }
    const epoch = this.#epoch;
    const artifact = Object.freeze({ ...descriptor, source });
    this.#set({
      busy: true,
      message: "Checking the imported processor's exact file hash…",
    });
    try {
      const valid = await this.deps.verifyProcessor(artifact);
      if (epoch !== this.#epoch) return false;
      if (!valid) {
        this.#processor = undefined;
        this.#set({
          processorReady: false,
          message:
            "This processor file does not match the imported catalog. No code was run.",
        });
        return false;
      }
      this.#processor = artifact;
      this.#set({
        processorReady: true,
        message:
          "Matching processor imported. It runs only in an isolated local worker when you propose a message.",
      });
      return true;
    } catch {
      if (epoch === this.#epoch) this.reportImportFailure();
      return false;
    } finally {
      if (epoch === this.#epoch) this.#set({ busy: false });
    }
  }

  async propose(
    client: OpenChat,
    content: MessageContent,
    options: PrivateAppProposalOptions,
  ): Promise<"drafted" | "retryable"> {
    this.open();
    if (!this.#account || client.clientOnlyApps?.() !== true) {
      this.#set({
        message: "Private app drafts require a signed-in unofficial client.",
      });
      return "retryable";
    }
    if (!this.#setupAllowed()) return "retryable";
    const selection = this.selection();
    if (!selection) {
      this.#set({
        message:
          "Import an app catalog, select its action, then press Propose on this message again. Nothing is fetched automatically.",
      });
      return "retryable";
    }
    const { app, action } = selection;
    const artifact = this.#processor;
    if (app.processor && (!artifact || !this.#state.processorReady)) {
      this.#set({
        message:
          "Import the processor file matching this app's catalog, then propose the message again.",
      });
      return "retryable";
    }
    const epoch = this.#epoch;
    const abort = new AbortController();
    this.#abort = abort;
    const stillCurrent = () =>
      epoch === this.#epoch && !abort.signal.aborted && options.stillCurrent();
    this.#set({
      busy: true,
      phase: "preparing",
      message:
        "Preparing a private draft locally. No app handoff has been requested.",
    });
    try {
      const result = await this.deps.extract(
        action.definition,
        content,
        client,
        {
          sourceTimestamp: options.sourceTimestamp,
          stillCurrent,
          onPhase: (phase) => {
            if (!stillCurrent()) return;
            this.#set({ phase });
            options.onPhase?.(phase);
          },
          processor:
            artifact === undefined
              ? undefined
              : async (actionId, input, current) => {
                  if (
                    actionId !== action.definition.name ||
                    !current() ||
                    !stillCurrent()
                  )
                    return { kind: "error", error: "Proposal context changed" };
                  return this.deps.runProcessor(
                    artifact,
                    actionId,
                    JSON.stringify(input),
                    {
                      signal: abort.signal,
                      contextJson:
                        action.processorContext === undefined
                          ? undefined
                          : JSON.stringify(action.processorContext),
                    },
                  );
                },
        },
      );
      if (!stillCurrent()) return "retryable";
      if (result.kind !== "extracted") {
        // Do not expose raw model output, private provider errors or registry recovery paths.
        const message =
          result.kind === "unavailable"
            ? "The selected local model is not ready. Open model settings and finish its download or select an available model."
            : result.kind === "image_unsupported"
              ? "The selected model does not support images. Choose an image-capable model."
              : result.kind === "image_not_accepted"
                ? "This app action does not accept image messages."
                : result.kind === "unsupported_content"
                  ? "This message type is not supported for this action."
                  : result.kind === "incomplete_extraction"
                    ? "The local result is missing required fields. No draft or external handoff was created."
                    : "The local processor or model could not prepare a complete action. No external handoff was requested.";
        this.#set({ message });
        return "retryable";
      }
      const draft = this.#drafts.create({
        target: {
          appId: app.id,
          actionId: action.definition.name,
          destination: app.destination,
          recipient:
            app.recipientLabel ?? "Choose the receiving account in the app",
        },
        schema: action.draftSchema,
        payload: projectLocalAppPayload(action, result.candidates),
      });
      this.#set({
        draft,
        editorJson: JSON.stringify(draft.payload, null, 2),
        recipient: draft.target.recipient,
        message:
          "Private draft ready. Edit and review every field before choosing to send it outside OpenChat.",
      });
      return "drafted";
    } catch {
      if (stillCurrent())
        this.#set({
          message:
            "The private draft could not be prepared. No external handoff was requested.",
        });
      return "retryable";
    } finally {
      if (epoch === this.#epoch) {
        this.#abort = undefined;
        this.#set({ busy: false, phase: undefined });
      }
    }
  }

  edit(editorJson: string, recipient: string): void {
    const draft = this.#state.draft;
    if (!draft || !["draft", "reviewed"].includes(draft.status)) return;
    // Revoke approval even while the editor temporarily contains invalid JSON.
    this.#set({
      draft: this.#drafts.edit(draft.id, {}),
      editorJson,
      recipient,
      message: "Draft changed. Review the full request again before sending.",
    });
  }

  review(): boolean {
    const draft = this.#state.draft;
    if (
      !draft ||
      this.#state.busy ||
      !["draft", "reviewed"].includes(draft.status)
    )
      return false;
    try {
      this.#drafts.edit(draft.id, {
        payload: JSON.parse(this.#state.editorJson),
        target: { ...draft.target, recipient: this.#state.recipient.trim() },
      });
      this.#drafts.review(draft.id);
      this.#set({
        draft: this.#drafts.get(draft.id),
        message:
          "Review the entire request below. Sending requires a separate explicit confirmation.",
      });
      return true;
    } catch {
      this.#set({
        draft: this.#drafts.get(draft.id),
        message:
          "The edited JSON or recipient does not meet this app's schema. Correct it before review; nothing was sent.",
      });
      return false;
    }
  }

  async confirm(approvalId: string): Promise<void> {
    const draft = this.#state.draft;
    if (
      !draft ||
      this.#state.busy ||
      draft.status !== "reviewed" ||
      draft.approval?.approvalId !== approvalId
    )
      return;
    const epoch = this.#epoch;
    // confirm invokes the delivery adapter synchronously, keeping the user's popup gesture.
    const pending = this.#drafts.confirm(draft.id, approvalId);
    this.#set({
      busy: true,
      draft: this.#drafts.get(draft.id),
      message:
        "Sending the exact reviewed request. This does not mean the app has saved it.",
    });
    await pending;
    if (epoch !== this.#epoch) return;
    const current = this.#drafts.get(draft.id);
    this.#set({
      busy: false,
      draft: current,
      message:
        current?.status === "delivered"
          ? "The app received the handoff. Review and save it in the app; delivery is not proof that it was saved."
          : "The handoff outcome is unknown. Check the receiving app before starting another draft. No automatic retry will occur.",
    });
  }

  discard(): void {
    ++this.#epoch;
    this.#abort?.abort();
    this.#abort = undefined;
    const dispatched = this.#state.draft
      ? this.#drafts.cancel(this.#state.draft.id).deliveryMayHaveOccurred
      : false;
    this.deps.cancelDelivery();
    this.#set({
      draft: undefined,
      editorJson: "",
      recipient: "",
      busy: false,
      phase: undefined,
      message: dispatched
        ? "Local draft discarded. A remote handoff may already have occurred; check the app before sending again."
        : "Local draft or processing discarded. Nothing was sent to the app.",
    });
  }
}

export const privateAppWorkspaceState =
  writable<PrivateAppWorkspaceState>(initial());
export const privateAppWorkspace = new PrivateAppWorkspace(
  {
    extract: extractPrivateAppAction,
    runProcessor: runIsolatedAppProcessor,
    verifyProcessor: verifyImportedLocalProcessor,
    deliver: deliverLocalAppViaRelay,
    cancelDelivery: cancelLocalAppHandoffs,
  },
  (state) => privateAppWorkspaceState.set(state),
);

export async function proposePrivateAppMessage(
  client: OpenChat,
  content: MessageContent,
  options: PrivateAppProposalOptions,
): Promise<"drafted" | "retryable"> {
  const account = currentUserIdStore.value;
  privateAppWorkspace.setAccount(
    account === ANON_USER_ID ? undefined : account,
  );
  return privateAppWorkspace.propose(client, content, options);
}
