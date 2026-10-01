import { get, writable } from "svelte/store";
import { currentUserIdStore, type OpenChat, type MessageContent } from "@client";
import { ANON_USER_ID } from "@shared";
import {
    extractPrivateAppAction,
    type PrivateAppExtractionResult,
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
    snapshotLocalDraftJson,
    type LocalDraftDelivery,
    type LocalDraftView,
} from "./localAppDrafts";
import {
    createBrowserLocalAppDraftStorage,
    snapshotSavedLocalAppDraft,
    type LocalAppDraftStorage,
} from "./localAppDraftPersistence";
import {
    initializeLocalAppDraftChoices,
    selectLocalAppDraftChoice,
    editLocalAppDraftScalar,
    resetLocalAppDraftChoices,
    assertLocalAppDraftChoiceConsistency,
    type LocalAppDraftChoiceSession,
} from "./localAppDraftChoices";
import type { LocalAppDraftScalar } from "./localAppDraftFields";
import { APP_SETUP_TIMEOUT_MS } from "./localAppSetupPopup";
import {
    deliverLocalAppViaRelay,
    cancelLocalAppHandoffs,
    localAppDeliveryStatus,
} from "./localAppRelayDelivery";
import { nativeAppDelivery, nativeDeliveryAllowed } from "./nativeAppDelivery";
import {
    createBrowserLocalAppSetupStorage,
    validateLocalAppSetupSnapshot,
    validateLocalAppEnabledChats,
    type LocalAppSetupScope,
    type LocalAppSetupSnapshot,
    type LocalAppSetupStorage,
} from "./localAppSetupStore";
import {
    localAppDirectorySource,
    loadLocalAppDirectory,
    loadLocalAppPublicPackage,
    bindConnectedLocalApp,
    sameLocalAppPublisher,
    localAppHasPrivateSetup,
    type LocalAppDirectory,
    type LocalAppDirectoryDescriptor,
    type LocalAppInstallation,
} from "./localAppDirectory";

export type ConnectLocalAppSetup = (
    descriptor: LocalAppDirectoryDescriptor,
    signal: AbortSignal,
) => Promise<string>;

export interface PrivateAppWorkspaceState {
    open: boolean;
    account?: string;
    backend?: string;
    setupLoading: boolean;
    setupStatus: string;
    setupGeneration: number;
    draftLoading: boolean;
    draftStorageStatus: string;
    enabledChats: LocalAppSetupSnapshot["enabledChats"];
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
    draftManualValues: boolean;
    directory?: LocalAppDirectory;
    directorySource?: string;
    directoryLoading: boolean;
    directoryStatus: string;
    appUpdates: Readonly<Record<string, string>>;
    disabledAppIds: readonly string[];
}

type Dependencies = {
    extract: typeof extractPrivateAppAction;
    runProcessor: typeof runIsolatedAppProcessor;
    verifyProcessor: typeof verifyImportedLocalProcessor;
    deliver: LocalDraftDelivery;
    nativeDeliver?: LocalDraftDelivery;
    cancelDelivery: () => void;
    deliverySaved: (importId: string) => boolean;
    setupStorage?: LocalAppSetupStorage;
    draftStorage?: LocalAppDraftStorage;
    connectAppSetup?: ConnectLocalAppSetup;
    loadDirectory?: typeof loadLocalAppDirectory;
    loadPublicPackage?: typeof loadLocalAppPublicPackage;
};
export type PrivateAppProposalOptions = {
    stillCurrent: () => boolean;
    sourceTimestamp?: number;
    onPhase?: ProposalPhaseListener;
};

type PrivateProcessorOutcome = Awaited<ReturnType<typeof runIsolatedAppProcessor>>["kind"];

/** Only fixed host diagnostics cross this boundary, never provider text or app/model data. */
function privateExtractionFailureMessage(
    result: PrivateAppExtractionResult,
    processorOutcome?: PrivateProcessorOutcome,
): string {
    let message: string;
    if (result.kind === "no_extraction") {
        message =
            processorOutcome === "none" || processorOutcome === "ambiguous"
                ? "[PRIVATE-ACTION/APP_NO_MATCH] The app's local processor did not identify an action from the result."
                : "[PRIVATE-ACTION/MODEL_NO_ACTION] The model result did not yield a complete action.";
    } else if (result.kind === "local_no_extraction") {
        message =
            "[PRIVATE-ACTION/LOCAL_NO_MATCH] The local reader or processor did not identify an action.";
    } else if (result.kind === "error") {
        // Exact equality with host-authored messages only. Substrings, appended provider details,
        // raw JSON and app-supplied error strings must never be copied into the UI.
        switch (result.error) {
            case "The model reached its output token limit before completing the response. No partial result was returned.":
                message =
                    "[PRIVATE-ACTION/MODEL_OUTPUT_LIMIT] The model reached its output token limit before completing the response. No partial result was accepted.";
                break;
            case "The model stopped without a completion EOS token. No partial result was returned.":
                message =
                    "[PRIVATE-ACTION/MODEL_OUTPUT_INCOMPLETE] The model stopped before completing the response. No partial result was accepted.";
                break;
            case "browser model returned no text":
                message = "[PRIVATE-ACTION/MODEL_OUTPUT_EMPTY] The model returned no text.";
                break;
            case "The app could not normalize the complete model result. No action was prepared.":
                message =
                    "[PRIVATE-ACTION/APP_RESULT_INVALID] The app's local processor could not return a valid action from the complete model result.";
                break;
            default:
                message =
                    processorOutcome === "error"
                        ? "[PRIVATE-ACTION/APP_PROCESSOR_FAILED] The app's isolated local processor could not complete."
                        : "[PRIVATE-ACTION/PREPARATION_FAILED] The local processor or model could not prepare a complete action.";
        }
    } else {
        message =
            "[PRIVATE-ACTION/PREPARATION_FAILED] The local processor or model could not prepare a complete action.";
    }
    return `${message} No external handoff was requested.`;
}

const initial = (): PrivateAppWorkspaceState => ({
    open: false,
    processorReady: false,
    busy: false,
    setupLoading: false,
    setupStatus: "Setup stays in memory for this session.",
    setupGeneration: 0,
    draftLoading: false,
    draftStorageStatus: "",
    enabledChats: Object.freeze([]),
    editorJson: "",
    recipient: "",
    draftManualValues: false,
    directoryLoading: false,
    directoryStatus: "",
    appUpdates: Object.freeze({}),
    disabledAppIds: Object.freeze([]),
    message:
        "Connect an available app and select its action. Private cards are saved only on this device.",
});

/** Private cards are device-local, never chat messages; restored cards never restore consent. */
export class PrivateAppWorkspace {
    #state = initial();
    #account?: string;
    #backend?: string;
    #setupEpoch = 0;
    #setupGeneration = 0;
    #saveRevision = 0;
    #setupNeedsRestore = false;
    readonly #setupQueues = new Map<string, Promise<void>>();
    #epoch = 0;
    #processor?: ImportedLocalProcessor;
    readonly #processors = new Map<string, ImportedLocalProcessor>();
    readonly #installations = new Map<string, LocalAppInstallation>();
    #directorySource?: string;
    #directoryAbort?: AbortController;
    #refreshDeferred = false;
    #connectAppSetup?: ConnectLocalAppSetup;
    #abort?: AbortController;
    #deliveryClient?: OpenChat;
    #nativeDelivery = false;
    #choiceSession?: LocalAppDraftChoiceSession;
    #fieldEditBlocked = false;
    #draftSaveRevision = 0;
    #restoredTargetMatches = true;
    readonly #drafts: LocalAppDraftStore;

    constructor(
        private readonly deps: Dependencies,
        private readonly onChange: (state: PrivateAppWorkspaceState) => void = () => {},
    ) {
        this.#connectAppSetup = deps.connectAppSetup;
        this.#drafts = new LocalAppDraftStore((request, signal) => {
            // Write-ahead: a restart must know this exact request MAY have been sent, with its
            // original import ID. A failed save is not permission to send an unrecorded request.
            const beforeDelivery = this.deps.draftStorage ? this.#persistDraft() : undefined;
            // The adapter opens its empty handoff window synchronously; it MUST await this
            // gate before putting encrypted fields into any native or browser transport.
            void beforeDelivery?.catch(() => {});
            if (this.#nativeDelivery) {
                // A native client must never fall back to a browser BroadcastChannel or app backend.
                return nativeDeliveryAllowed(this.#deliveryClient) && deps.nativeDeliver
                    ? beforeDelivery
                        ? deps.nativeDeliver(request, signal, beforeDelivery)
                        : deps.nativeDeliver(request, signal)
                    : Promise.resolve({ kind: "uncertain" });
            }
            return beforeDelivery
                ? deps.deliver(request, signal, beforeDelivery)
                : deps.deliver(request, signal);
        });
    }

    get state(): PrivateAppWorkspaceState {
        return { ...this.#state };
    }
    get contextVersion(): number {
        return this.#epoch;
    }
    setClient(client: OpenChat): void {
        this.#deliveryClient = client;
        this.#nativeDelivery = client.isNativeApp?.() === true;
    }
    #set(patch: Partial<PrivateAppWorkspaceState>) {
        this.#state = { ...this.#state, ...patch };
        this.onChange(this.state);
    }
    setAccount(account: string | undefined, backend?: string): void {
        if (account === this.#account && backend === this.#backend && !this.#setupNeedsRestore)
            return;
        this.clear();
        this.#setupNeedsRestore = false;
        this.#account = account;
        this.#backend = backend;
        this.#drafts.setAccount(account);
        const scope = this.#setupScope();
        const loading = this.deps.setupStorage !== undefined && scope !== undefined;
        this.#set({
            account,
            backend,
            setupLoading: loading,
            setupStatus: !this.deps.setupStorage
                ? "Setup stays in memory for this session."
                : !account
                  ? "Sign in to restore this account's saved app setup."
                  : !scope
                    ? "App setup is unavailable until this client's backend identity is known."
                    : "Restoring saved app setup on this device…",
        });
        if (scope && this.deps.draftStorage)
            this.#set({
                draftLoading: true,
                draftStorageStatus: "Restoring this account's private card…",
            });
        if (loading && scope) void this.#restoreSetup(scope, this.#setupEpoch);
        else if (scope) void this.#restoreDraft(scope, this.#setupEpoch);
    }
    clear(): void {
        ++this.#epoch;
        ++this.#setupEpoch;
        ++this.#setupGeneration;
        this.#setupNeedsRestore = this.deps.setupStorage !== undefined;
        this.#abort?.abort();
        this.#abort = undefined;
        this.#processor = undefined;
        this.#processors.clear();
        this.#installations.clear();
        this.#directoryAbort?.abort();
        this.#directoryAbort = undefined;
        this.#refreshDeferred = false;
        this.#deliveryClient = undefined;
        this.#nativeDelivery = false;
        this.#choiceSession = undefined;
        this.#fieldEditBlocked = false;
        this.#restoredTargetMatches = true;
        this.#drafts.clear();
        this.deps.cancelDelivery();
        this.#state = {
            ...initial(),
            account: this.#account,
            backend: this.#backend,
            directorySource: this.#directorySource,
            setupGeneration: this.#setupGeneration,
            setupStatus: this.deps.setupStorage
                ? "Workspace cleared from memory. Saved setup and private cards remain on this device."
                : "Setup stays in memory for this session.",
        };
        this.onChange(this.state);
    }

    #setupScope(): LocalAppSetupScope | undefined {
        return this.#account && this.#backend
            ? Object.freeze({ account: this.#account, backend: this.#backend })
            : undefined;
    }

    #queueSetup<T>(scope: LocalAppSetupScope, operation: () => Promise<T>): Promise<T> {
        const key = JSON.stringify([scope.account, scope.backend]);
        const previous = this.#setupQueues.get(key) ?? Promise.resolve();
        const pending = previous.then(operation);
        const settled = pending.then(
            () => {},
            () => {},
        );
        this.#setupQueues.set(key, settled);
        void settled.then(() => {
            if (this.#setupQueues.get(key) === settled) this.#setupQueues.delete(key);
        });
        return pending;
    }

    async #restoreSetup(scope: LocalAppSetupScope, epoch: number): Promise<void> {
        try {
            const stored = await this.#queueSetup(scope, () => this.deps.setupStorage!.read(scope));
            if (epoch !== this.#setupEpoch) return;
            const setup =
                stored === undefined ? undefined : await validateLocalAppSetupSnapshot(stored);
            if (epoch !== this.#setupEpoch) return;
            this.#processor = setup?.processor;
            this.#processors.clear();
            for (const row of setup?.processors ?? [])
                this.#processors.set(row.appId, row.artifact);
            if (setup?.processor && setup.appId) this.#processors.set(setup.appId, setup.processor);
            this.#installations.clear();
            for (const entry of setup?.installations ?? [])
                this.#installations.set(entry.appId, entry);
            this.#processor = setup?.appId ? this.#processors.get(setup.appId) : undefined;
            ++this.#setupGeneration;
            const app = setup?.catalog.apps.find((app) => app.id === setup.appId);
            this.#set({
                catalog: setup?.catalog,
                appId: setup?.appId,
                actionId: setup?.actionId,
                enabledChats: setup?.enabledChats ?? Object.freeze([]),
                disabledAppIds: setup?.disabledAppIds ?? Object.freeze([]),
                processorReady:
                    !!setup?.actionId &&
                    !setup?.disabledAppIds?.includes(setup.appId!) &&
                    (!app?.processor || !!this.#processor),
                setupGeneration: this.#setupGeneration,
                setupLoading: false,
                setupStatus: setup
                    ? "App setup restored on this device. No message or approval was restored."
                    : "No saved app setup for this account and backend. Connect an available app to begin.",
            });
        } catch {
            if (epoch === this.#setupEpoch)
                this.#set({
                    setupLoading: false,
                    setupStatus:
                        "Saved app setup could not be restored. Import it again; nothing was run or sent.",
                });
        } finally {
            if (epoch === this.#setupEpoch) await this.#restoreDraft(scope, epoch);
        }
    }

    async #restoreDraft(scope: LocalAppSetupScope, epoch: number): Promise<void> {
        if (!this.deps.draftStorage) return;
        try {
            const raw = await this.deps.draftStorage.read(scope);
            if (epoch !== this.#setupEpoch) return;
            if (!raw) {
                this.#set({
                    draftLoading: false,
                    draftStorageStatus: "No saved private card for this account and backend.",
                });
                return;
            }
            const saved = snapshotSavedLocalAppDraft(raw);
            const app = this.#state.catalog?.apps.find(
                (app) => app.id === saved.draft.target.appId,
            );
            const action = app?.actions.find(
                (action) => action.definition.name === saved.draft.target.actionId,
            );
            this.#restoredTargetMatches =
                !!app &&
                !!action &&
                app.destination === saved.draft.target.destination &&
                app.revision === saved.draft.target.appRevision &&
                JSON.stringify(snapshotLocalDraftJson(app.deliveryEncryption ?? null)) ===
                    JSON.stringify(
                        snapshotLocalDraftJson(saved.draft.target.deliveryEncryption ?? null),
                    ) &&
                JSON.stringify(snapshotLocalDraftJson(action.draftSchema)) ===
                    JSON.stringify(saved.draft.schema);
            const draft = this.#drafts.restore(saved.draft);
            if (action && this.#restoredTargetMatches) {
                // Original default/choice history is not a permission to recompute fields.
                // Treat every recovered value as manual; default selection cannot overwrite it.
                const session = initializeLocalAppDraftChoices(
                    action,
                    JSON.stringify(draft.payload),
                );
                this.#choiceSession = resetLocalAppDraftChoices(session, saved.editorJson);
            }
            this.#processor = this.#processors.get(draft.target.appId);
            this.#set({
                draft,
                appId: draft.target.appId,
                actionId: draft.target.actionId,
                editorJson: saved.editorJson,
                recipient: saved.recipient,
                draftManualValues: true,
                draftLoading: false,
                draftStorageStatus:
                    "Private card restored from encrypted storage on this device. No approval or handoff session was restored.",
                message: !this.#restoredTargetMatches
                    ? "This saved card's app configuration changed or is unavailable. Inspect or discard it; it cannot be sent to a changed destination."
                    : saved.draft.attempted
                      ? "This request may already have reached the app. Check the app, then review the unchanged request before explicitly retrying with the same import ID."
                      : "Private card restored. Review every field again before sending; no consent was restored.",
            });
        } catch {
            if (epoch === this.#setupEpoch)
                this.#set({
                    draftLoading: false,
                    draftStorageStatus:
                        "The saved private card could not be restored. Nothing was sent. Use Forget to remove unavailable saved data.",
                });
        }
    }

    async #persistDraft(): Promise<void> {
        const scope = this.#setupScope();
        const storage = this.deps.draftStorage;
        const draft = this.#state.draft;
        if (!storage || !draft) return;
        const epoch = this.#setupEpoch,
            revision = ++this.#draftSaveRevision;
        this.#set({ draftStorageStatus: "Saving this private card on this device…" });
        try {
            if (!scope)
                throw new Error("Private card storage requires a signed-in account and backend");
            const snapshot = this.#drafts.snapshot(draft.id);
            const saved = snapshotSavedLocalAppDraft({
                version: 1,
                draft: snapshot,
                editorJson: snapshot.attempted
                    ? JSON.stringify(snapshot.payload, null, 2)
                    : this.#state.editorJson,
                recipient: snapshot.attempted ? snapshot.target.recipient : this.#state.recipient,
            });
            await storage.write(scope, saved);
            if (epoch === this.#setupEpoch && revision === this.#draftSaveRevision)
                this.#set({
                    draftStorageStatus:
                        "Private card saved in encrypted storage on this device. It is not chat-synced.",
                });
        } catch {
            if (epoch === this.#setupEpoch && revision === this.#draftSaveRevision)
                this.#set({
                    draftStorageStatus:
                        "Private card could not be saved. Recent changes are only in memory; sending is blocked until storage works.",
                });
            throw new Error("Private card storage is unavailable");
        }
    }

    #saveDraft(): void {
        void this.#persistDraft().catch(() => {});
    }

    #saveSetup(): void {
        const storage = this.deps.setupStorage;
        const scope = this.#setupScope();
        const catalog = this.#state.catalog;
        if (!storage || !scope || !catalog) return;
        // Capture only setup at the explicit user mutation. Never serialize workspace state.
        const snapshot: LocalAppSetupSnapshot = {
            catalog,
            appId: this.#state.appId,
            actionId: this.#state.actionId,
            processor: this.#processor,
            processors: Object.freeze(
                [...this.#processors].map(([appId, artifact]) =>
                    Object.freeze({ appId, artifact }),
                ),
            ),
            installations: Object.freeze([...this.#installations.values()]),
            disabledAppIds: this.#state.disabledAppIds,
            enabledChats: this.#state.enabledChats,
        };
        const epoch = this.#setupEpoch;
        const revision = ++this.#saveRevision;
        this.#set({ setupStatus: "Saving app setup on this device…" });
        void this.#queueSetup(scope, () => storage.write(scope, snapshot)).then(
            () => {
                if (epoch === this.#setupEpoch && revision === this.#saveRevision)
                    this.#set({
                        setupStatus:
                            "App setup saved on this device. Private cards use separate encrypted local storage.",
                    });
            },
            () => {
                if (epoch === this.#setupEpoch && revision === this.#saveRevision)
                    this.#set({
                        setupStatus:
                            "App setup could not be saved. It remains available only in this session.",
                    });
            },
        );
    }

    enabledChatsSnapshot(): LocalAppSetupSnapshot["enabledChats"] {
        return this.#state.enabledChats;
    }

    replaceEnabledChats(
        account: string,
        catalog: LocalAppCatalog,
        rows: LocalAppSetupSnapshot["enabledChats"],
    ): boolean {
        if (account !== this.#account || catalog !== this.#state.catalog || !this.#setupAllowed())
            return false;
        try {
            const enabledChats = validateLocalAppEnabledChats(rows, catalog);
            if (
                enabledChats.some((row) =>
                    row.appIds.some((id) => this.#state.disabledAppIds.includes(id)),
                )
            )
                return false;
            if (JSON.stringify(enabledChats) === JSON.stringify(this.#state.enabledChats))
                return true;
            this.#set({ enabledChats });
            this.#saveSetup();
            return true;
        } catch {
            this.#set({ setupStatus: "The chat app choices are invalid and were not saved." });
            return false;
        }
    }

    async forgetSetup(): Promise<boolean> {
        if (this.#state.setupLoading || this.#state.draftLoading || !this.#account) return false;
        const scope = this.#setupScope();
        if (this.deps.setupStorage && !scope) return false;
        this.clear();
        // Forget is itself the new empty setup, not a request to rehydrate on remount.
        this.#setupNeedsRestore = false;
        if ((!this.deps.setupStorage && !this.deps.draftStorage) || !scope) return true;
        const epoch = this.#setupEpoch;
        this.#set({
            setupLoading: true,
            setupStatus: "Removing saved app setup from this device…",
        });
        try {
            // Removal follows earlier captured writes. They cannot resurrect a forgotten setup.
            if (this.deps.setupStorage)
                await this.#queueSetup(scope, () => this.deps.setupStorage!.remove(scope));
            if (this.deps.draftStorage) await this.deps.draftStorage.remove(scope);
            if (epoch === this.#setupEpoch)
                this.#set({
                    setupLoading: false,
                    setupStatus: "Saved app setup and private card removed from this device.",
                    draftStorageStatus: "Saved private card and its encryption key were removed.",
                });
            return true;
        } catch {
            if (epoch === this.#setupEpoch)
                this.#set({
                    setupLoading: false,
                    setupStatus:
                        "Local workspace cleared, but saved setup could not be removed. Try Forget again before leaving this device.",
                });
            return false;
        }
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

    setConnectAppSetup(connect: ConnectLocalAppSetup): void {
        this.#connectAppSetup = connect;
    }

    configureDirectory(source?: string): void {
        let next: string | undefined;
        try {
            next = source ? localAppDirectorySource(source) : undefined;
        } catch {
            this.#directoryAbort?.abort();
            this.#directorySource = undefined;
            this.#set({
                directorySource: undefined,
                directory: undefined,
                directoryLoading: false,
                directoryStatus: "The configured app directory address is invalid.",
            });
            return;
        }
        if (next === this.#directorySource && this.#state.directorySource === next) return;
        this.#directoryAbort?.abort();
        this.#directorySource = next;
        this.#set({
            directorySource: next,
            directory: undefined,
            directoryLoading: false,
            directoryStatus: next
                ? "Refresh available apps to check the configured publisher."
                : "No app directory is configured for this client.",
        });
    }

    async refreshDirectory(): Promise<boolean> {
        if (!this.#directorySource || !this.#account || this.#state.setupLoading) return false;
        if (this.#state.busy || this.#state.draft) {
            this.#refreshDeferred = true;
            this.#set({
                directoryStatus:
                    "App updates are deferred until the current draft or processing is finished.",
            });
            return false;
        }
        if (this.#state.directoryLoading) return false;
        const source = this.#directorySource;
        const epoch = this.#setupEpoch;
        const abort = new AbortController();
        this.#directoryAbort = abort;
        const timer = setTimeout(() => abort.abort(), 30_000);
        this.#set({
            directoryLoading: true,
            directoryStatus: "Checking available apps. No chat content is sent.",
        });
        try {
            const directory = await (this.deps.loadDirectory ?? loadLocalAppDirectory)(
                source,
                abort.signal,
            );
            if (
                epoch !== this.#setupEpoch ||
                source !== this.#directorySource ||
                abort.signal.aborted
            )
                return false;
            const updates: Record<string, string> = {};
            this.#set({ directory });
            if (this.#state.busy || this.#state.draft) {
                this.#refreshDeferred = true;
                this.#set({
                    directoryStatus:
                        "App list checked; installation changes are deferred until processing or the draft is discarded.",
                });
                return false;
            }
            const disabled = new Set(this.#state.disabledAppIds);
            for (const installed of this.#installations.values()) {
                if (
                    installed.sourceUrl === source &&
                    !directory.apps.some((app) => app.id === installed.appId)
                )
                    disabled.add(installed.appId);
            }
            if (disabled.size !== this.#state.disabledAppIds.length) {
                const disabledAppIds = Object.freeze([...disabled]);
                const enabledChats = Object.freeze(
                    this.#state.enabledChats
                        .map((row) =>
                            Object.freeze({
                                ...row,
                                appIds: Object.freeze(row.appIds.filter((id) => !disabled.has(id))),
                            }),
                        )
                        .filter((row) => row.appIds.length),
                );
                this.#set({
                    disabledAppIds,
                    enabledChats,
                    processorReady:
                        !disabled.has(this.#state.appId ?? "") && this.#state.processorReady,
                });
                this.#saveSetup();
            }
            for (const installed of this.#installations.values()) {
                if (installed.sourceUrl !== source) {
                    updates[installed.appId] = "Connect to approve this publisher.";
                    continue;
                }
                const descriptor = directory.apps.find((app) => app.id === installed.appId);
                if (!descriptor) {
                    updates[installed.appId] =
                        "No longer listed by this publisher. Disabled in chats and for proposals; setup is retained for recovery.";
                    continue;
                }
                if (JSON.stringify(descriptor) === JSON.stringify(installed.descriptor)) continue;
                if (!sameLocalAppPublisher(installed, descriptor, source)) {
                    updates[installed.appId] = "Connect to approve changed publisher addresses.";
                    continue;
                }
                const app = this.#state.catalog?.apps.find((app) => app.id === installed.appId);
                if (!app) continue;
                // Never reinterpret opaque private setup against a newly published recipe.
                if (localAppHasPrivateSetup(app, installed.publicCatalogJson)) {
                    updates[app.id] = "Connect again to refresh private app setup for this update.";
                    continue;
                }
                const pkg = await (this.deps.loadPublicPackage ?? loadLocalAppPublicPackage)(
                    descriptor,
                    abort.signal,
                );
                if (
                    epoch !== this.#setupEpoch ||
                    source !== this.#directorySource ||
                    abort.signal.aborted
                )
                    return false;
                if (this.#state.busy || this.#state.draft) {
                    this.#refreshDeferred = true;
                    break;
                }
                if (pkg.catalog.apps[0].destination !== app.destination) {
                    updates[app.id] = "Connect to approve the changed destination.";
                    continue;
                }
                this.#installApp(
                    pkg.catalog.apps[0],
                    pkg.processor,
                    {
                        appId: app.id,
                        sourceUrl: source,
                        descriptor,
                        publicCatalogJson: pkg.catalogJson,
                    },
                    false,
                );
            }
            this.#set({
                appUpdates: Object.freeze(updates),
                directoryStatus:
                    "App list updated. New apps are not enabled in any chat. Connect approves this publisher's compatible future recipe updates.",
            });
            return true;
        } catch {
            if (epoch === this.#setupEpoch && source === this.#directorySource)
                this.#set({
                    directoryStatus:
                        "The app directory or update could not be verified. Previously verified apps remain available; an unverified update was not installed.",
                });
            return false;
        } finally {
            clearTimeout(timer);
            if (this.#directoryAbort === abort) {
                this.#directoryAbort = undefined;
                this.#set({ directoryLoading: false });
            }
        }
    }

    async connectApp(appId: string): Promise<boolean> {
        if (!this.#setupAllowed() || this.#state.directoryLoading || !this.#connectAppSetup)
            return false;
        const descriptor = this.#state.directory?.apps.find((app) => app.id === appId);
        const source = this.#directorySource;
        if (!descriptor || !source) return false;
        const epoch = this.#epoch;
        const abort = new AbortController();
        this.#abort = abort;
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        this.#set({
            busy: true,
            message:
                "Checking the app recipe and opening its account connection. No chat content is sent.",
        });
        try {
            // The transport may finish before the public downloads. Bound the complete atomic
            // operation even when a download stalls or ignores its cancellation signal.
            const deadline = new Promise<never>((_resolve, reject) => {
                deadlineTimer = setTimeout(() => {
                    abort.abort();
                    reject(new Error("App connection deadline exceeded"));
                }, APP_SETUP_TIMEOUT_MS);
            });
            // The explicit Connect gesture opens the exact directory setup URL before awaiting
            // downloads. Neither result is adopted until both are verified as one package.
            const connection = this.#connectAppSetup(descriptor, abort.signal);
            const [pkg, json] = await Promise.race([
                Promise.all([
                    (this.deps.loadPublicPackage ?? loadLocalAppPublicPackage)(
                        descriptor,
                        abort.signal,
                    ),
                    connection,
                ]),
                deadline,
            ]);
            const app = bindConnectedLocalApp(json, pkg.catalog);
            if (epoch !== this.#epoch || source !== this.#directorySource || abort.signal.aborted)
                return false;
            this.#installApp(
                app,
                pkg.processor,
                { appId, sourceUrl: source, descriptor, publicCatalogJson: pkg.catalogJson },
                true,
            );
            this.#set({
                message:
                    "App connected. Enable it in a chat before proposing a message. No chat content was sent.",
            });
            return true;
        } catch {
            abort.abort();
            if (epoch === this.#epoch)
                this.#set({
                    message:
                        "The app connection could not be verified. Previously installed setup is unchanged; retry Connect explicitly.",
                });
            return false;
        } finally {
            clearTimeout(deadlineTimer);
            if (this.#abort === abort) {
                this.#abort = undefined;
                this.#set({ busy: false });
            }
        }
    }

    #installApp(
        app: LocalAppCatalogEntry,
        processor: ImportedLocalProcessor,
        installation: LocalAppInstallation,
        select: boolean,
    ): void {
        const previous = this.#state.catalog?.apps.find((entry) => entry.id === app.id);
        const oldInstallation = this.#installations.get(app.id);
        const preservePermission =
            previous?.destination === app.destination &&
            oldInstallation !== undefined &&
            sameLocalAppPublisher(oldInstallation, installation.descriptor, installation.sourceUrl);
        const apps = [
            ...(this.#state.catalog?.apps ?? []).filter((entry) => entry.id !== app.id),
            app,
        ];
        const catalog = parseLocalAppCatalog(JSON.stringify({ version: 1, apps }));
        ++this.#epoch;
        const enabledChats = Object.freeze(
            this.#state.enabledChats
                .map((row) =>
                    Object.freeze({
                        ...row,
                        appIds: Object.freeze(
                            row.appIds.filter((id) => id !== app.id || preservePermission),
                        ),
                    }),
                )
                .filter((row) => row.appIds.length),
        );
        this.#processors.set(app.id, processor);
        this.#installations.set(app.id, Object.freeze(installation));
        const appId = select ? app.id : this.#state.appId;
        const oldAction = this.#state.actionId;
        const selected = catalog.apps.find((entry) => entry.id === appId);
        const actionId = select
            ? app.actions.length === 1
                ? app.actions[0].definition.name
                : undefined
            : selected?.actions.find((action) => action.definition.name === oldAction)?.definition
                  .name;
        this.#processor = appId ? this.#processors.get(appId) : undefined;
        const disabledAppIds = select
            ? Object.freeze(this.#state.disabledAppIds.filter((id) => id !== app.id))
            : this.#state.disabledAppIds;
        const updates = { ...this.#state.appUpdates };
        delete updates[app.id];
        this.#set({
            catalog,
            enabledChats,
            appId,
            actionId,
            processorReady:
                !!actionId &&
                !disabledAppIds.includes(appId ?? "") &&
                (!selected?.processor || !!this.#processor),
            disabledAppIds,
            appUpdates: Object.freeze(updates),
            setupGeneration: ++this.#setupGeneration,
        });
        this.#saveSetup();
    }

    #setupAllowed(): boolean {
        if (
            this.#state.setupLoading ||
            this.#state.draftLoading ||
            ((this.deps.setupStorage || this.deps.draftStorage) && !this.#setupScope())
        ) {
            this.#set({
                setupStatus:
                    this.#state.setupLoading || this.#state.draftLoading
                        ? "Wait for app setup restoration or removal to finish before continuing."
                        : "App setup is unavailable until the signed-in account and backend identity are known.",
            });
            return false;
        }
        if (!this.#account) {
            this.#set({
                message: "Sign in to an existing account before importing private app setup.",
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
            ++this.#setupGeneration;
            this.#processor = undefined;
            this.#processors.clear();
            this.#installations.clear();
            this.#set({
                catalog,
                setupGeneration: this.#setupGeneration,
                enabledChats: Object.freeze([]),
                disabledAppIds: Object.freeze([]),
                appId: undefined,
                actionId: undefined,
                processorReady: false,
                message:
                    "Catalog imported locally. Choose an app and action; no app connection has been opened.",
            });
            this.#saveSetup();
            return true;
        } catch {
            this.reportImportFailure();
            return false;
        }
    }

    selection(): { app: LocalAppCatalogEntry; action: LocalAppAction } | undefined {
        const app = this.#state.catalog?.apps.find((app) => app.id === this.#state.appId);
        const action = app?.actions.find(
            (action) => action.definition.name === this.#state.actionId,
        );
        return app && action ? { app, action } : undefined;
    }

    chooseApp(appId: string): boolean {
        if (!this.#setupAllowed()) return false;
        if (appId && !this.#state.catalog?.apps.some((app) => app.id === appId)) return false;
        ++this.#epoch;
        this.#processor = this.#processors.get(appId);
        this.#set({
            appId: appId || undefined,
            actionId: undefined,
            processorReady: false,
            message: "Choose this app's action before proposing a message.",
        });
        this.#saveSetup();
        return true;
    }

    select(appId: string, actionId: string): boolean {
        if (!this.#setupAllowed()) return false;
        const app = this.#state.catalog?.apps.find((app) => app.id === appId);
        const action = app?.actions.find((action) => action.definition.name === actionId);
        if (!app || !action) return false;
        ++this.#epoch;
        this.#processor = this.#processors.get(appId);
        this.#set({
            appId,
            actionId,
            processorReady:
                !this.#state.disabledAppIds.includes(appId) &&
                (app.processor === undefined || !!this.#processor),
            message:
                app.processor && !this.#processor
                    ? "Import this app's matching local processor file before proposing a message."
                    : "Ready. Use Propose on one message to prepare a private draft.",
        });
        this.#saveSetup();
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
                this.#processors.delete(selection!.app.id);
                this.#set({
                    processorReady: false,
                    message:
                        "This processor file does not match the imported catalog. No code was run.",
                });
                this.#saveSetup();
                return false;
            }
            this.#processor = artifact;
            this.#processors.set(selection!.app.id, artifact);
            this.#set({
                processorReady: true,
                message:
                    "Matching processor imported. It runs only in an isolated local worker when you propose a message.",
            });
            this.#saveSetup();
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
        if (this.#state.disabledAppIds.includes(app.id)) {
            this.#set({
                message:
                    "This app is no longer available from its publisher. Reconnect it before proposing a message.",
            });
            return "retryable";
        }
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
            message: "Preparing a private draft locally. No app handoff has been requested.",
        });
        // Invocation-local enum only; no processor output/error is stored in workspace state.
        let processorOutcome: PrivateProcessorOutcome | undefined;
        try {
            const result = await this.deps.extract(action.definition, content, client, {
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
                              const processed = await this.deps.runProcessor(
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
                              processorOutcome = processed.kind;
                              return processed;
                          },
            });
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
                                ? "[PRIVATE-ACTION/SCHEMA_INCOMPLETE] The local result is missing required fields. No draft or external handoff was created."
                                : privateExtractionFailureMessage(result, processorOutcome);
                this.#set({ message });
                return "retryable";
            }
            const choiceSession = initializeLocalAppDraftChoices(
                action,
                JSON.stringify(projectLocalAppPayload(action, result.candidates), null, 2),
            );
            const draft = this.#drafts.create({
                target: {
                    appId: app.id,
                    actionId: action.definition.name,
                    destination: app.destination,
                    recipient: app.recipientLabel ?? "Choose the receiving account in the app",
                    appRevision: app.revision,
                    ...(app.deliveryEncryption
                        ? { deliveryEncryption: app.deliveryEncryption }
                        : {}),
                },
                schema: action.draftSchema,
                payload: JSON.parse(choiceSession.editorJson),
            });
            this.#choiceSession = choiceSession;
            this.#fieldEditBlocked = false;
            this.#restoredTargetMatches = true;
            this.#deliveryClient = client;
            this.#nativeDelivery = client.isNativeApp?.() === true;
            this.#set({
                draft,
                editorJson: choiceSession.editorJson,
                draftManualValues: false,
                recipient: draft.target.recipient,
                message:
                    "Private draft ready. Edit and review every field before choosing to send it outside OpenChat.",
            });
            this.#saveDraft();
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
        if (!this.#editable()) return;
        if (this.#choiceSession)
            this.#choiceSession = resetLocalAppDraftChoices(this.#choiceSession, editorJson);
        this.#fieldEditBlocked = false;
        this.#commitEdit(editorJson, recipient, true);
    }

    #editable(): boolean {
        const draft = this.#state.draft;
        return (
            this.#restoredTargetMatches &&
            !!draft &&
            !this.#state.busy &&
            ["draft", "reviewed"].includes(draft.status)
        );
    }

    #commitEdit(
        editorJson: string,
        recipient: string,
        manual = this.#state.draftManualValues,
    ): void {
        const draft = this.#state.draft;
        if (!draft || !this.#editable()) return;
        // Revoke approval even while the editor temporarily contains invalid JSON.
        this.#set({
            draft: this.#drafts.edit(draft.id, {}),
            editorJson,
            recipient,
            draftManualValues: manual,
            message: "Draft changed. Review the full request again before sending.",
        });
        this.#saveDraft();
    }

    /** Recipient and approval changes do not erase session-only field history. */
    editRecipient(recipient: string): void {
        this.#commitEdit(this.#state.editorJson, recipient);
    }

    invalidateReview(): void {
        this.#commitEdit(this.#state.editorJson, this.#state.recipient);
    }

    #changeFields(
        operation: (session: LocalAppDraftChoiceSession) => LocalAppDraftChoiceSession,
    ): string {
        if (!this.#editable()) throw new Error("This draft cannot be edited.");
        try {
            const session = this.#choiceSession;
            if (
                !session ||
                session.action !== this.selection()?.action ||
                session.editorJson !== this.#state.editorJson
            )
                throw new Error("The draft editor context changed.");
            const updated = operation(session);
            this.#choiceSession = updated;
            this.#fieldEditBlocked = false;
            this.#commitEdit(updated.editorJson, this.#state.recipient, updated.manual);
            return updated.editorJson;
        } catch {
            // Even a failed atomic edit must make a previously reviewed request unusable.
            this.#fieldEditBlocked = true;
            this.invalidateReview();
            throw new Error("The field edit could not be represented in this draft.");
        }
    }

    editDraftField(
        itemIndex: number,
        field: string,
        value: LocalAppDraftScalar | undefined,
    ): string {
        return this.#changeFields((session) =>
            editLocalAppDraftScalar(session, itemIndex, field, value),
        );
    }

    selectDraftChoice(itemIndex: number, field: string, value: string | undefined): string {
        return this.#changeFields((session) =>
            selectLocalAppDraftChoice(session, itemIndex, field, value),
        );
    }

    review(): boolean {
        const draft = this.#state.draft;
        if (!this.#restoredTargetMatches) return false;
        if (draft?.status === "uncertain" && !draft.approval && !this.#state.busy) {
            this.#drafts.reviewRecovered(draft.id);
            this.#set({
                draft: this.#drafts.get(draft.id),
                message:
                    "Review the exact recovered request. A retry needs separate confirmation and keeps its original import ID.",
            });
            return true;
        }
        if (!draft || this.#state.busy || !["draft", "reviewed"].includes(draft.status))
            return false;
        if (this.#fieldEditBlocked) {
            this.#set({
                message:
                    "Correct the pending field edit before review; no previous payload can be sent.",
            });
            return false;
        }
        try {
            const action = this.selection()?.action;
            if (!action) throw new Error("The draft action is unavailable.");
            assertLocalAppDraftChoiceConsistency(action, this.#state.editorJson);
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
            this.#saveDraft();
            return true;
        } catch {
            this.#set({
                draft: this.#drafts.edit(draft.id, {}),
                message:
                    "The edited JSON, app choices or recipient do not meet this app's schema. Correct them before review; nothing was sent.",
            });
            return false;
        }
    }

    async confirm(approvalId: string): Promise<void> {
        await this.#send(approvalId, "reviewed");
    }

    /** Separate user confirmation only: reuse the exact approved import ID and request. */
    async retryUncertain(approvalId: string): Promise<void> {
        await this.#send(approvalId, "uncertain");
    }

    /** Fresh explicit choice after checking the app; receipt alone does not establish saving. */
    async reopenDelivered(approvalId: string): Promise<void> {
        await this.#send(approvalId, "delivered");
    }

    async #send(
        approvalId: string,
        expectedStatus: "reviewed" | "uncertain" | "delivered",
    ): Promise<void> {
        const draft = this.#state.draft;
        if (draft && (!draft.target.deliveryEncryption || !draft.target.appRevision)) {
            this.#set({
                message:
                    "Reconnect this app before sending. This saved connection has no verified recipient encryption key; no fields were handed off.",
            });
            return;
        }
        if (
            !draft ||
            this.#state.busy ||
            draft.status !== expectedStatus ||
            draft.approval?.approvalId !== approvalId ||
            (expectedStatus === "delivered" &&
                this.deps.deliverySaved(draft.approval.request.idempotencyKey))
        )
            return;
        const epoch = this.#epoch;
        // confirm invokes the delivery adapter synchronously, keeping the user's popup gesture.
        const pending =
            expectedStatus === "delivered"
                ? this.#drafts.reopenDelivered(draft.id, approvalId)
                : expectedStatus === "uncertain"
                  ? this.#drafts.retryUncertain(draft.id, approvalId)
                  : this.#drafts.confirm(draft.id, approvalId);
        this.#set({
            busy: true,
            draft: this.#drafts.get(draft.id),
            message: "Sending the exact reviewed request. This does not mean the app has saved it.",
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
                    : "The handoff outcome is unknown. Check the receiving app first. An explicit retry keeps this exact reviewed request and import ID; no automatic retry will occur.",
        });
        this.#saveDraft();
    }

    discard(): void {
        const scope = this.#setupScope();
        ++this.#epoch;
        this.#abort?.abort();
        this.#abort = undefined;
        const dispatched = this.#state.draft
            ? this.#drafts.cancel(this.#state.draft.id).deliveryMayHaveOccurred
            : false;
        this.deps.cancelDelivery();
        this.#deliveryClient = undefined;
        this.#nativeDelivery = false;
        this.#choiceSession = undefined;
        this.#fieldEditBlocked = false;
        this.#restoredTargetMatches = true;
        this.#set({
            draft: undefined,
            editorJson: "",
            recipient: "",
            draftManualValues: false,
            busy: false,
            phase: undefined,
            message: dispatched
                ? "Local draft discarded. A remote handoff may already have occurred; check the app before sending again."
                : "Local draft or processing discarded. Nothing was sent to the app.",
        });
        if (scope && this.deps.draftStorage) {
            const epoch = this.#setupEpoch;
            this.#set({
                draftLoading: true,
                draftStorageStatus: "Removing this private card from this device…",
            });
            void this.deps.draftStorage.remove(scope).then(
                () => {
                    if (epoch === this.#setupEpoch)
                        this.#set({
                            draftLoading: false,
                            draftStorageStatus:
                                "Private card and its local encryption key removed.",
                        });
                },
                () => {
                    if (epoch === this.#setupEpoch)
                        this.#set({
                            draftLoading: false,
                            draftStorageStatus:
                                "Card cleared from memory, but saved data could not be removed. Use Forget before leaving this device.",
                        });
                },
            );
        }
        if (this.#refreshDeferred) {
            this.#refreshDeferred = false;
            void this.refreshDirectory();
        }
    }
}

export const privateAppWorkspaceState = writable<PrivateAppWorkspaceState>(initial());
export const privateAppWorkspace = new PrivateAppWorkspace(
    {
        extract: extractPrivateAppAction,
        runProcessor: runIsolatedAppProcessor,
        verifyProcessor: verifyImportedLocalProcessor,
        deliver: deliverLocalAppViaRelay,
        nativeDeliver: nativeAppDelivery.deliver,
        deliverySaved: (importId) => {
            const delivery = get(localAppDeliveryStatus);
            return delivery?.importId === importId && delivery.status === "saved";
        },
        cancelDelivery: () => {
            cancelLocalAppHandoffs();
            nativeAppDelivery.cancelAll();
        },
        setupStorage: createBrowserLocalAppSetupStorage(),
        draftStorage: createBrowserLocalAppDraftStorage(),
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
        client.privateAppStorageBackend?.(),
    );
    return privateAppWorkspace.propose(client, content, options);
}
