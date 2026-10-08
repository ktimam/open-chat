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
    snapshotSavedLocalAppDraftCollection,
    snapshotLocalAppDraftSourceReference,
    LocalAppDraftStorageCapacityError,
    type LocalAppDraftSourceReference,
    type SavedLocalAppDraftCollection,
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
import { isLocalAppInboxGrant, localAppInboxTarget, localAppInboxEndpoint } from "./localAppInbox";
import { deliverLocalAppToInbox, type LocalAppInboxDeposit } from "./localAppInboxDelivery";
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
    cardPresentation: "saved" | "source";
    /** Transient host-only placement intent; never persisted or included in an app handoff. */
    presentationSource?: LocalAppDraftSourceReference;
    /** Binds a completed source presentation, including a source-less fallback, to its result. */
    presentationDraftId?: string;
    account?: string;
    backend?: string;
    setupLoading: boolean;
    setupStatus: string;
    setupGeneration: number;
    draftLoading: boolean;
    draftStorageStatus: string;
    /** Only storage failures are surfaced in the normal card and Apps UI. */
    draftStorageError?: string;
    enabledChats: LocalAppSetupSnapshot["enabledChats"];
    catalog?: LocalAppCatalog;
    appId?: string;
    actionId?: string;
    processorReady: boolean;
    busy: boolean;
    /** Transient editor guard, published so source-card navigation cannot hide an invalid edit. */
    readonly fieldEditBlocked: boolean;
    phase?: ProposalPhase;
    message: string;
    draft?: LocalDraftView;
    cards: readonly LocalDraftView[];
    cardSources: Readonly<Record<string, LocalAppDraftSourceReference | undefined>>;
    activeCardApp?: LocalAppCatalogEntry;
    /** Host-authored feedback only; never persisted or supplied by an app. */
    cardReviewBlockedReason?: string;
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
    inboxDeposit?: LocalAppInboxDeposit;
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
    /** An explicit user request for fresh extraction; never replaces a retained card. */
    regenerate?: boolean;
    sourceTimestamp?: number;
    onPhase?: ProposalPhaseListener;
    /** Host-captured identifiers only; never included in the app's outgoing DTO. */
    source?: LocalAppDraftSourceReference;
};

type CardSession = {
    app?: LocalAppCatalogEntry;
    editorJson: string;
    recipient: string;
    manual: boolean;
    choices?: LocalAppDraftChoiceSession;
    blocked: boolean;
    targetMatches: boolean;
    source?: LocalAppDraftSourceReference;
};

/** Both inputs are already bounded, data-only catalog snapshots; object order is immaterial. */
function sameCardConfiguration(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
    if (Array.isArray(left) || Array.isArray(right))
        return (
            Array.isArray(left) &&
            Array.isArray(right) &&
            left.length === right.length &&
            left.every((value, index) => sameCardConfiguration(value, right[index]))
        );
    const leftEntries = Object.entries(left);
    const rightEntries = new Map(Object.entries(right));
    return (
        leftEntries.length === rightEntries.size &&
        leftEntries.every(
            ([key, value]) =>
                rightEntries.has(key) && sameCardConfiguration(value, rightEntries.get(key)),
        )
    );
}

/** Navigation metadata may be absent from legacy records; stable message identity stays unchanged. */
function sameSourceMessage(
    left: LocalAppDraftSourceReference,
    right: LocalAppDraftSourceReference,
): boolean {
    return (
        left.chatKey === right.chatKey &&
        left.messageId === right.messageId &&
        left.threadRootMessageIndex === right.threadRootMessageIndex &&
        (left.chatKind === undefined ||
            right.chatKind === undefined ||
            left.chatKind === right.chatKind)
    );
}

function backfillSourceLocation(
    retained: LocalAppDraftSourceReference,
    current: LocalAppDraftSourceReference,
): LocalAppDraftSourceReference {
    if (
        (retained.messageIndex !== undefined || current.messageIndex === undefined) &&
        (retained.chatKind !== undefined || current.chatKind === undefined)
    )
        return retained;
    return snapshotLocalAppDraftSourceReference({
        ...retained,
        ...(retained.messageIndex === undefined && current.messageIndex !== undefined
            ? { messageIndex: current.messageIndex }
            : {}),
        ...(retained.chatKind === undefined && current.chatKind !== undefined
            ? { chatKind: current.chatKind }
            : {}),
    });
}

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

const CARD_CONNECTION_REVIEW_BLOCKED =
    "This saved card's app setup changed or is unavailable. It is inspect-only until the original matching connection is restored. The saved card and any previous request are unchanged. Check the receiving app before starting a new proposal or discarding this card.";

const initial = (): PrivateAppWorkspaceState => ({
    open: false,
    cardPresentation: "saved",
    processorReady: false,
    busy: false,
    fieldEditBlocked: false,
    setupLoading: false,
    setupStatus: "Setup stays in memory for this session.",
    setupGeneration: 0,
    draftLoading: false,
    draftStorageStatus: "",
    cards: Object.freeze([]),
    cardSources: Object.freeze({}),
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
    #connectionAbort?: AbortController;
    #cancelledConnection?: AbortController;
    #abort?: AbortController;
    #deliveryClient?: OpenChat;
    #nativeDelivery = false;
    #choiceSession?: LocalAppDraftChoiceSession;
    #fieldEditBlocked = false;
    #draftSaveRevision = 0;
    #restoredTargetMatches = true;
    #draftRestoreFailed = false;
    readonly #cards = new Map<string, CardSession>();
    readonly #drafts: LocalAppDraftStore;

    constructor(
        private readonly deps: Dependencies,
        private readonly onChange: (state: PrivateAppWorkspaceState) => void = () => {},
    ) {
        this.#connectAppSetup = deps.connectAppSetup;
        this.#drafts = new LocalAppDraftStore((request, signal) => {
            if (request.deliveryInbox) {
                const draft = this.#state.draft;
                const grant = draft && this.#cards.get(draft.id)?.app?.deliveryInbox;
                // An inbox is an explicitly connected app destination, never a relay fallback.
                // Without durable write-ahead storage no upload is permitted.
                if (
                    !draft ||
                    !grant ||
                    !isLocalAppInboxGrant(grant) ||
                    !this.deps.draftStorage ||
                    (this.#nativeDelivery && !nativeDeliveryAllowed(this.#deliveryClient))
                )
                    return Promise.resolve({ kind: "uncertain" });
                const epoch = this.#epoch;
                return deliverLocalAppToInbox(request, signal, {
                    grant,
                    saved: this.#drafts.get(draft.id)?.inboxDelivery,
                    deposit: deps.inboxDeposit,
                    persist: async (value) => {
                        signal.throwIfAborted();
                        if (epoch !== this.#epoch) throw new Error("App delivery cancelled");
                        this.#drafts.setInboxDelivery(draft.id, value);
                        await this.#persistDraft();
                        signal.throwIfAborted();
                        if (epoch !== this.#epoch) throw new Error("App delivery cancelled");
                    },
                });
            }
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
        this.#state = { ...this.#state, ...patch, fieldEditBlocked: this.#fieldEditBlocked };
        this.#rememberActive();
        this.#state.cards = Object.freeze(
            [...this.#cards.keys()].flatMap((id) => {
                const draft = this.#drafts.get(id);
                return draft ? [draft] : [];
            }),
        );
        this.#state.cardSources = Object.freeze(
            Object.fromEntries(
                [...this.#cards].flatMap(([id, card]) =>
                    card.source === undefined ? [] : [[id, card.source]],
                ),
            ),
        );
        this.#state.activeCardApp = this.#state.draft
            ? this.#cards.get(this.#state.draft.id)?.app
            : undefined;
        this.#state.cardReviewBlockedReason =
            this.#state.draft && !this.#restoredTargetMatches
                ? CARD_CONNECTION_REVIEW_BLOCKED
                : undefined;
        this.onChange(this.state);
    }
    #rememberActive(): void {
        const card = this.#state.draft && this.#cards.get(this.#state.draft.id);
        if (!card) return;
        Object.assign(card, {
            editorJson: this.#state.editorJson,
            recipient: this.#state.recipient,
            manual: this.#state.draftManualValues,
            choices: this.#choiceSession,
            blocked: this.#fieldEditBlocked,
            targetMatches: this.#restoredTargetMatches,
        });
    }
    #leaveCard(): void {
        const current = this.#state.draft;
        if (current?.approval) this.#set({ draft: this.#drafts.revokeApproval(current.id) });
        this.#rememberActive();
    }
    selectCard(id: string, persistSelection = true): boolean {
        if (this.#state.busy || this.#state.draftLoading || this.#fieldEditBlocked) return false;
        const card = this.#cards.get(id);
        const draft = this.#drafts.get(id);
        if (!card || !draft) return false;
        this.#leaveCard();
        this.#choiceSession = card.choices;
        this.#fieldEditBlocked = card.blocked;
        this.#restoredTargetMatches = card.targetMatches;
        this.#processor = this.#processors.get(draft.target.appId);
        this.#set({
            draft: this.#drafts.get(id),
            presentationSource: this.#state.cardPresentation === "source" ? card.source : undefined,
            presentationDraftId: this.#state.cardPresentation === "source" ? id : undefined,
            appId: draft.target.appId,
            actionId: draft.target.actionId,
            editorJson: card.editorJson,
            recipient: card.recipient,
            draftManualValues: card.manual,
            processorReady:
                !!this.#processor ||
                !(
                    card.app ??
                    this.#state.catalog?.apps.find((app) => app.id === draft.target.appId)
                )?.processor,
            message: card.targetMatches
                ? "Private card selected. Review it before confirming any handoff."
                : "This saved card's app configuration changed or is unavailable. Inspect or discard it; it cannot be sent to a changed destination.",
        });
        if (persistSelection) this.#saveDraft();
        return true;
    }
    setFieldEditBlocked(blocked: boolean): void {
        const changed = this.#fieldEditBlocked !== blocked;
        this.#fieldEditBlocked = blocked;
        if (blocked) this.invalidateReview();
        this.#rememberActive();
        if (changed) this.#set({});
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
        this.#draftRestoreFailed = false;
        this.#cards.clear();
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
                        "Saved app setup could not be restored. Open Apps and reconnect the app; nothing was run or sent.",
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
            const collection = snapshotSavedLocalAppDraftCollection(raw);
            for (const { saved, source, app: savedApp } of collection.cards) {
                const configuredApp = this.#state.catalog?.apps.find(
                    (app) => app.id === saved.draft.target.appId,
                );
                const app = savedApp ?? configuredApp;
                const action = app?.actions.find(
                    (action) => action.definition.name === saved.draft.target.actionId,
                );
                const configuredAction = configuredApp?.actions.find(
                    (action) => action.definition.name === saved.draft.target.actionId,
                );
                const configuredInbox =
                    configuredApp?.deliveryInbox &&
                    isLocalAppInboxGrant(configuredApp.deliveryInbox)
                        ? localAppInboxTarget(configuredApp.deliveryInbox)
                        : undefined;
                const targetMatches =
                    !!configuredApp &&
                    !!action &&
                    configuredApp.destination === saved.draft.target.destination &&
                    configuredApp.revision === saved.draft.target.appRevision &&
                    sameCardConfiguration(configuredInbox, saved.draft.target.deliveryInbox) &&
                    JSON.stringify(
                        snapshotLocalDraftJson(configuredApp.deliveryEncryption ?? null),
                    ) ===
                        JSON.stringify(
                            snapshotLocalDraftJson(saved.draft.target.deliveryEncryption ?? null),
                        ) &&
                    JSON.stringify(snapshotLocalDraftJson(action.draftSchema)) ===
                        JSON.stringify(saved.draft.schema) &&
                    (!savedApp || sameCardConfiguration(configuredAction, action));
                const draft = this.#drafts.restore(saved.draft);
                let choices: LocalAppDraftChoiceSession | undefined;
                if (action && targetMatches) {
                    // Original default/choice history is not a permission to recompute fields.
                    // Treat every recovered value as manual; default selection cannot overwrite it.
                    const session = initializeLocalAppDraftChoices(
                        action,
                        JSON.stringify(draft.payload),
                    );
                    choices = resetLocalAppDraftChoices(session, saved.editorJson);
                }
                this.#cards.set(draft.id, {
                    app: savedApp ?? (targetMatches ? configuredApp : undefined),
                    editorJson: saved.editorJson,
                    recipient: saved.recipient,
                    manual: true,
                    choices,
                    blocked: false,
                    targetMatches,
                    source,
                });
            }
            this.#set({
                draftLoading: false,
                draftStorageStatus:
                    "Private cards restored from encrypted storage on this device. No approval or handoff session was restored.",
            });
            const first = collection.activeDraftId ?? this.#cards.keys().next().value;
            if (first) this.selectCard(first, false);
        } catch {
            if (epoch === this.#setupEpoch) {
                this.#draftRestoreFailed = true;
                this.#cards.clear();
                this.#drafts.clear();
                this.#set({
                    draftLoading: false,
                    draftStorageStatus:
                        "The saved private card could not be restored. Nothing was sent. Restart OpenChat to retry; saved data was left unchanged.",
                    draftStorageError:
                        "Saved cards could not be restored. Restart OpenChat to retry. Nothing was sent or deleted.",
                });
            }
        }
    }

    #collection(): SavedLocalAppDraftCollection {
        this.#rememberActive();
        return snapshotSavedLocalAppDraftCollection({
            version: 2,
            ...(this.#state.draft ? { activeDraftId: this.#state.draft.id } : {}),
            cards: [...this.#cards].map(([id, card]) => {
                const draft = this.#drafts.snapshot(id);
                return {
                    saved: {
                        version: 1,
                        draft,
                        editorJson: draft.attempted
                            ? JSON.stringify(draft.payload, null, 2)
                            : card.editorJson,
                        recipient: draft.attempted ? draft.target.recipient : card.recipient,
                    },
                    ...(card.source ? { source: card.source } : {}),
                    ...(card.app ? { app: card.app } : {}),
                };
            }),
        });
    }

    async #persistDraft(): Promise<void> {
        const scope = this.#setupScope();
        const storage = this.deps.draftStorage;
        if (!storage) return;
        const epoch = this.#setupEpoch,
            revision = ++this.#draftSaveRevision;
        this.#set({
            draftStorageStatus: "Saving this private card on this device…",
            draftStorageError: undefined,
        });
        try {
            if (!scope)
                throw new Error("Private card storage requires a signed-in account and backend");
            if (this.#draftRestoreFailed) throw new Error("Saved cards could not be read");
            await storage.write(scope, this.#collection());
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
                    draftStorageError:
                        "This card could not be saved on this device. Keep OpenChat open and try again; nothing will be sent until it is saved.",
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
        // Inspecting a retained card from a disconnected app is not a new setup selection.
        const selected = catalog.apps.find((app) => app.id === this.#state.appId);
        // Capture only setup at the explicit user mutation. Never serialize workspace state.
        const snapshot: LocalAppSetupSnapshot = {
            catalog,
            appId: selected?.id,
            actionId: selected?.actions.find(
                (action) => action.definition.name === this.#state.actionId,
            )?.definition.name,
            processor: selected ? this.#processor : undefined,
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
        if (
            account !== this.#account ||
            catalog !== this.#state.catalog ||
            !this.#setupAllowed(true)
        )
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
        if (
            this.#state.setupLoading ||
            this.#state.draftLoading ||
            (this.#state.busy && this.#cards.size > 0) ||
            !this.#account
        )
            return false;
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
    open(cardPresentation: "saved" | "source" = "saved"): void {
        this.#set({
            open: true,
            cardPresentation,
            presentationSource:
                cardPresentation === "source" ? this.#state.presentationSource : undefined,
            presentationDraftId:
                cardPresentation === "source" ? this.#state.presentationDraftId : undefined,
        });
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
        if (this.#state.busy) {
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
            if (this.#state.busy || this.#cards.size > 0) {
                this.#refreshDeferred = true;
                this.#set({
                    directoryStatus:
                        "Available apps updated. Saved cards keep their existing configuration; connect explicitly to change an app.",
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
                if (this.#state.busy || this.#cards.size > 0) {
                    this.#refreshDeferred = true;
                    break;
                }
                if (pkg.catalog.apps[0].destination !== app.destination) {
                    updates[app.id] = "Connect to approve the changed destination.";
                    continue;
                }
                if (
                    !sameCardConfiguration(
                        pkg.catalog.apps[0].deliveryInbox
                            ? localAppInboxEndpoint(pkg.catalog.apps[0].deliveryInbox!)
                            : undefined,
                        app.deliveryInbox ? localAppInboxEndpoint(app.deliveryInbox) : undefined,
                    )
                ) {
                    updates[app.id] = "Connect to approve the changed app inbox.";
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
        if (!this.#setupAllowed(true) || this.#state.directoryLoading || !this.#connectAppSetup)
            return false;
        const descriptor = this.#state.directory?.apps.find((app) => app.id === appId);
        const source = this.#directorySource;
        if (!descriptor || !source) return false;
        const epoch = this.#epoch;
        const abort = new AbortController();
        this.#abort = abort;
        this.#connectionAbort = abort;
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        let removeCancellationListener = () => {};
        this.#set({
            busy: true,
            message:
                "Checking the app recipe and opening its account connection. No chat content is sent.",
        });
        try {
            const cancelled = new Promise<never>((_resolve, reject) => {
                const listener = () => reject(new Error("App connection cancelled"));
                abort.signal.addEventListener("abort", listener, { once: true });
                removeCancellationListener = () =>
                    abort.signal.removeEventListener("abort", listener);
            });
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
                cancelled,
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
                        this.#cancelledConnection === abort
                            ? "Connection cancelled. Existing apps and saved cards are unchanged."
                            : "The app connection could not be verified. Previously installed setup is unchanged; retry Connect explicitly.",
                });
            return false;
        } finally {
            clearTimeout(deadlineTimer);
            removeCancellationListener();
            if (this.#connectionAbort === abort) this.#connectionAbort = undefined;
            if (this.#cancelledConnection === abort) this.#cancelledConnection = undefined;
            if (this.#abort === abort) {
                this.#abort = undefined;
                this.#set({ busy: false });
            }
        }
    }

    /** Cancel only a connection attempt; never discard a card or interrupt model processing. */
    cancelConnection(): boolean {
        const abort = this.#connectionAbort;
        if (!abort || this.#abort !== abort || abort.signal.aborted) return false;
        this.#cancelledConnection = abort;
        abort.abort();
        return true;
    }

    /** Disconnect only this app. Retained cards stay inspectable but cannot use a removed connection. */
    async disconnectApp(appId: string): Promise<boolean> {
        if (!this.#setupAllowed(true) || this.#state.directoryLoading) return false;
        if (!this.#state.catalog?.apps.some((app) => app.id === appId)) return false;
        const catalog = parseLocalAppCatalog(
            JSON.stringify({
                version: 1,
                apps: this.#state.catalog.apps.filter((app) => app.id !== appId),
            }),
        );
        ++this.#epoch;
        this.#processors.delete(appId);
        this.#installations.delete(appId);
        this.#updateCardConnection(appId);
        const enabledChats = Object.freeze(
            this.#state.enabledChats
                .map((row) =>
                    Object.freeze({
                        ...row,
                        appIds: Object.freeze(row.appIds.filter((id) => id !== appId)),
                    }),
                )
                .filter((row) => row.appIds.length),
        );
        const updates = { ...this.#state.appUpdates };
        delete updates[appId];
        const retainSelection = !!this.#state.draft || this.#state.appId !== appId;
        const selectedId = retainSelection ? this.#state.appId : undefined;
        this.#processor = selectedId ? this.#processors.get(selectedId) : undefined;
        this.#set({
            catalog,
            enabledChats,
            appId: selectedId,
            actionId: retainSelection ? this.#state.actionId : undefined,
            processorReady: selectedId !== appId && this.#state.processorReady,
            disabledAppIds: Object.freeze(this.#state.disabledAppIds.filter((id) => id !== appId)),
            appUpdates: Object.freeze(updates),
            setupGeneration: ++this.#setupGeneration,
            message:
                "App disconnected on this device. Its saved cards are retained; nothing was sent or deleted.",
        });
        this.#saveSetup();
        this.#saveDraft();
        return true;
    }

    #updateCardConnection(appId: string, app?: LocalAppCatalogEntry): void {
        for (const [id, card] of this.#cards) {
            const draft = this.#drafts.get(id);
            if (draft?.target.appId !== appId) continue;
            card.targetMatches = !!app && sameCardConfiguration(card.app, app);
            if (!card.targetMatches && draft.approval) this.#drafts.revokeApproval(id);
            if (id === this.#state.draft?.id) {
                this.#restoredTargetMatches = card.targetMatches;
                this.#state = { ...this.#state, draft: this.#drafts.get(id) };
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
        this.#updateCardConnection(app.id, app);
        const activeDraft = this.#state.draft;
        const appId = activeDraft?.target.appId ?? (select ? app.id : this.#state.appId);
        const oldAction = this.#state.actionId;
        const selected = catalog.apps.find((entry) => entry.id === appId);
        const actionId = activeDraft
            ? activeDraft.target.actionId
            : select
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
        if (this.#cards.size > 0) this.#saveDraft();
    }

    #setupAllowed(retainCards = false): boolean {
        if (
            this.#state.setupLoading ||
            this.#state.draftLoading ||
            this.#draftRestoreFailed ||
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
        if (this.#state.busy || (retainCards ? this.#fieldEditBlocked : this.#cards.size > 0)) {
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
        const app = this.#state.draft
            ? this.#cards.get(this.#state.draft.id)?.app
            : this.#state.catalog?.apps.find((app) => app.id === this.#state.appId);
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
        return this.#select(appId, actionId, false);
    }

    /** Choosing a proposal target preserves retained cards instead of retargeting them. */
    selectForProposal(appId: string, actionId: string): boolean {
        return this.#select(appId, actionId, true);
    }

    #select(appId: string, actionId: string, retainCards: boolean): boolean {
        if (!this.#setupAllowed(retainCards)) return false;
        const app = this.#state.catalog?.apps.find((app) => app.id === appId);
        const action = app?.actions.find((action) => action.definition.name === actionId);
        if (!app || !action) return false;
        this.#leaveCard();
        this.#choiceSession = undefined;
        this.#fieldEditBlocked = false;
        this.#restoredTargetMatches = true;
        ++this.#epoch;
        this.#processor = this.#processors.get(appId);
        this.#set({
            appId,
            actionId,
            draft: undefined,
            editorJson: "",
            recipient: "",
            draftManualValues: false,
            processorReady:
                !this.#state.disabledAppIds.includes(appId) &&
                (app.processor === undefined || !!this.#processor),
            message:
                app.processor && !this.#processor
                    ? "Reconnect this app from Apps before proposing a message."
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
        if (!this.#account || client.clientOnlyApps?.() !== true) {
            this.#set({
                message: "Private app drafts require a signed-in unofficial client.",
            });
            return "retryable";
        }
        if (!this.#setupAllowed(true)) return "retryable";
        if (!options.stillCurrent()) return "retryable";
        const selection = this.selection();
        if (!selection) {
            this.#set({
                message:
                    "Connect an app from AI Apps and enable it in this chat, then propose the message again. Nothing was sent.",
            });
            return "retryable";
        }
        this.open("source");
        const selectedAppId = selection.app.id;
        const selectedActionId = selection.action.definition.name;
        let source: LocalAppDraftSourceReference | undefined;
        try {
            source =
                options.source === undefined
                    ? undefined
                    : snapshotLocalAppDraftSourceReference(options.source);
        } catch {
            this.#set({
                presentationSource: undefined,
                presentationDraftId: undefined,
                message: "The message reference is invalid. No draft was created.",
            });
            return "retryable";
        }
        // A failed or cancelled new extraction must not present the previously selected card
        // as the result for this message. Keep the requested source until explicit navigation.
        this.#set({ presentationSource: source, presentationDraftId: undefined });
        if (source && !options.regenerate) {
            const existing = [...this.#cards].find(([id, card]) => {
                const target = this.#drafts.get(id)?.target;
                return (
                    target?.appId === selectedAppId &&
                    target.actionId === selectedActionId &&
                    card.source !== undefined &&
                    sameSourceMessage(card.source, source)
                );
            });
            if (existing) {
                const [id, card] = existing;
                const previousSource = card.source;
                if (previousSource) card.source = backfillSourceLocation(previousSource, source);
                if (this.selectCard(id)) return "drafted";
                card.source = previousSource;
            }
        }
        // Starting fresh extraction is not approval of either the old or the new result.
        this.#leaveCard();
        // A retained card's immutable presentation is for reviewing that card only.
        // Every new proposal is pinned afresh to the currently connected configuration.
        const app = this.#state.catalog?.apps.find((app) => app.id === selectedAppId);
        const action = app?.actions.find((action) => action.definition.name === selectedActionId);
        if (!app || !action) {
            this.#set({ message: "Reconnect the app before creating another private card." });
            return "retryable";
        }
        if (this.#state.disabledAppIds.includes(app.id)) {
            this.#set({
                message:
                    "This app is no longer available from its publisher. Reconnect it before proposing a message.",
            });
            return "retryable";
        }
        const artifact = this.#processors.get(app.id);
        if (app.processor && (!artifact || !this.#state.processorReady)) {
            this.#set({
                message: "Reconnect this app from Apps, then propose the message again.",
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
            const inboxTarget = app.deliveryInbox
                ? await localAppInboxTarget(app.deliveryInbox)
                : undefined;
            if (!stillCurrent()) return "retryable";
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
                    ...(inboxTarget ? { deliveryInbox: inboxTarget } : {}),
                },
                schema: action.draftSchema,
                payload: JSON.parse(choiceSession.editorJson),
            });
            this.#rememberActive();
            this.#cards.set(draft.id, {
                app,
                editorJson: choiceSession.editorJson,
                recipient: draft.target.recipient,
                manual: false,
                choices: choiceSession,
                blocked: false,
                targetMatches: true,
                source,
            });
            try {
                this.#collection();
            } catch (error) {
                this.#cards.delete(draft.id);
                this.#drafts.cancel(draft.id);
                if (!(error instanceof LocalAppDraftStorageCapacityError)) throw error;
                this.#set({
                    message:
                        "Private card storage is full. Remove an unneeded card from this device and try again. Existing cards were preserved; nothing was sent.",
                });
                return "retryable";
            }
            this.#leaveCard();
            this.#choiceSession = choiceSession;
            this.#fieldEditBlocked = false;
            this.#restoredTargetMatches = true;
            this.#deliveryClient = client;
            this.#nativeDelivery = client.isNativeApp?.() === true;
            this.#set({
                draft,
                presentationDraftId:
                    this.#state.cardPresentation === "source" ? draft.id : undefined,
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
        const draft = this.#state.draft;
        if (
            draft?.approval &&
            (draft.status === "uncertain" || draft.status === "delivered") &&
            !this.#state.busy
        ) {
            this.#set({
                draft: this.#drafts.revokeApproval(draft.id),
                message:
                    "Review revoked. Review the exact recovered request again before retrying.",
            });
            this.#saveDraft();
            return;
        }
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
        if (draft?.target.deliveryInbox) {
            const configured = this.#state.catalog?.apps.find(
                (app) => app.id === draft.target.appId,
            )?.deliveryInbox;
            if (
                !configured ||
                !isLocalAppInboxGrant(configured) ||
                !sameCardConfiguration(localAppInboxTarget(configured), draft.target.deliveryInbox)
            ) {
                this.#set({ message: CARD_CONNECTION_REVIEW_BLOCKED });
                return false;
            }
        }
        if (draft && !this.#restoredTargetMatches) {
            this.#set({ message: CARD_CONNECTION_REVIEW_BLOCKED });
            return false;
        }
        if (this.#fieldEditBlocked) return false;
        if (
            draft &&
            ["uncertain", "delivered"].includes(draft.status) &&
            !draft.approval &&
            !this.#state.busy
        ) {
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
                    "The edited fields, app choices or recipient do not meet this app's schema. Correct them before review; nothing was sent.",
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
        if (draft?.target.deliveryInbox) {
            const configured = this.#state.catalog?.apps.find(
                (app) => app.id === draft.target.appId,
            )?.deliveryInbox;
            if (
                !configured ||
                !isLocalAppInboxGrant(configured) ||
                !sameCardConfiguration(localAppInboxTarget(configured), draft.target.deliveryInbox)
            ) {
                this.#set({ message: CARD_CONNECTION_REVIEW_BLOCKED });
                return;
            }
        }
        if (draft && !this.#restoredTargetMatches) {
            this.#set({ message: CARD_CONNECTION_REVIEW_BLOCKED });
            return;
        }
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
            this.#fieldEditBlocked ||
            !this.#restoredTargetMatches ||
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
                    ? current.inboxDelivery?.receipt
                        ? current.inboxDelivery.receipt.status === "Saved"
                            ? "The app reports that this request was saved."
                            : current.inboxDelivery.receipt.status === "Dismissed"
                              ? "This request was dismissed in the app. It was not queued again."
                              : "The encrypted request is stored in the app inbox, pending your review. Open the app to review and save it."
                        : current.approval &&
                            this.deps.deliverySaved(current.approval.request.idempotencyKey)
                          ? "The app reports that this request was saved."
                          : "The app received the handoff. Review and save it in the app; delivery is not proof that it was saved."
                    : "The handoff outcome is unknown. Check the receiving app first. An explicit retry keeps this exact reviewed request and import ID; no automatic retry will occur.",
        });
        this.#saveDraft();
    }

    discard(): void {
        if (this.#abort) {
            ++this.#epoch;
            this.#abort.abort();
            this.#abort = undefined;
            this.#set({
                busy: false,
                phase: undefined,
                message:
                    "Processing cancelled. Existing private cards were retained; no new handoff was requested.",
            });
            return;
        }
        ++this.#epoch;
        const dispatched = this.#state.draft
            ? this.#drafts.cancel(this.#state.draft.id).deliveryMayHaveOccurred
            : false;
        if (this.#state.draft) this.#cards.delete(this.#state.draft.id);
        this.deps.cancelDelivery();
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
        // Cancelling one source card must not open a different message's card.
        // Other encrypted cards remain available from their original messages.
        if (this.#setupScope() && this.deps.draftStorage) {
            const epoch = this.#setupEpoch;
            this.#set({
                draftLoading: true,
                draftStorageStatus: "Removing this private card from this device…",
            });
            void this.#persistDraft().then(
                () => {
                    if (epoch === this.#setupEpoch)
                        this.#set({
                            draftLoading: false,
                            draftStorageStatus:
                                "Selected private card removed. Other cards remain encrypted on this device.",
                        });
                },
                () => {
                    if (epoch === this.#setupEpoch)
                        this.#set({
                            draftLoading: false,
                            draftStorageStatus:
                                "Card cleared from memory, but saved data could not be removed. Restart OpenChat, reopen the saved card and try Remove from this device again.",
                            draftStorageError:
                                "The saved card could not be removed. Restart OpenChat, reopen the card and try Remove from this device again.",
                        });
                },
            );
        }
        if (this.#refreshDeferred && this.#cards.size === 0) {
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
