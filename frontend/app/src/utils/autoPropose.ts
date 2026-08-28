// Auto-propose: watches new text messages for keyword hits and suggests the existing
// "propose action" flow via a small under-bubble chip.
//
// Fully generic — the trigger vocabulary is DERIVED from registered data: for a given chat the
// candidate (app, action) pairs come from the existing Phase-A resolution (the apps enabled in
// the chat crossed with the global app directory — resolveCandidates in aiActionRunner.ts), and
// an action's trigger keywords are the union of the keywords of its keyword_map rules. An action
// with no keyword_map rules never auto-proposes. A keyword matches when it appears in the message as
// a WHOLE word/phrase, case-insensitively (see keywordMatch.ts) — raw substring matching made short
// keywords unusable, e.g. "owe" would have fired on "power"/"shower"/"flower".
//
// Performance: the per-chat vocabulary is cached for ~60s, so evaluating a message is pure
// string work — zero canister calls on the message path while the cache is warm.

import {
    chatIdentifierToString,
    currentUserIdStore,
    type ChatIdentifier,
    type EventWrapper,
    type Message,
    type OpenChat,
} from "@client";
import { matchesKeyword } from "./keywordMatch";
import { writable } from "svelte/store";
import { autoProposeSuggestions as autoProposeEnabled } from "../stores/settings";
import { configKeys } from "./config";
import {
    resolveCandidates,
    type AiActionCandidate,
    type AiActionCoordinates,
    type ProposalPhase,
} from "./aiActionRunner";
import {
    buildBoundedAutoProposeVocabulary,
    MAX_AUTO_PROPOSE_ACTIONS,
    type AutoProposeVocabulary,
} from "./autoProposeVocabulary";
import {
    AutoProposeEventWatermarks,
    AutoProposeEvaluationTracker,
    autoProposeIdentityKey,
} from "./autoProposeEvaluationTracker";
import { abortPrivateMatchOperations, runPrivateMatchCandidates } from "./privateMatchSurface";

// ---------------------------------------------------------------------------------------------
// Suggestion store — keyed by messageId, read by ChatMessage to render the chip.

export interface AutoProposeSuggestion extends AiActionCoordinates {
    // chatIdentifierToString of the chat the message lives in (lets a chat-level mute clear its
    // outstanding suggestions).
    chatKey: string;
    viewerId: string;
    sessionEpoch: number;
    // The matched action's card title — the chip reads "Propose <title>?".
    title: string;
    // Public manifest metadata used only to disambiguate otherwise-identical chip titles.
    appName: string;
}

export const autoProposeSuggestions = writable<Map<string, AutoProposeSuggestion[]>>(new Map());

/** Stable public identity for one exact action within a message's suggestion set. */
export function autoProposeSuggestionActionKey(
    suggestion: Pick<AutoProposeSuggestion, "appId" | "appRevision" | "actionId">,
): string {
    return JSON.stringify([
        suggestion.appId,
        suggestion.appRevision.toString(),
        suggestion.actionId,
    ]);
}

/** Add only as much public manifest metadata as is needed to make duplicate labels distinct. */
export function autoProposeSuggestionLabel(
    suggestion: AutoProposeSuggestion,
    suggestions: readonly AutoProposeSuggestion[],
): string {
    const sameTitle = suggestions.filter((value) => value.title === suggestion.title);
    if (sameTitle.length <= 1) return suggestion.title;

    const appLabel = `${suggestion.title} · ${suggestion.appName}`;
    const sameAppLabel = sameTitle.filter((value) => value.appName === suggestion.appName);
    if (sameAppLabel.length <= 1) return appLabel;

    const actionLabel = `${appLabel} · ${suggestion.actionId}`;
    const sameActionLabel = sameAppLabel.filter((value) => value.actionId === suggestion.actionId);
    return sameActionLabel.length <= 1 ? actionLabel : `${actionLabel} · #${suggestion.appId}`;
}

/** Browser-only progress copy for a proposal; native runtimes keep the generic fallback. */
export function autoProposeBusyI18nKey(
    status: string,
    browserRuntime: boolean,
    proposalPhase?: ProposalPhase,
    modelProgressRelevant = true,
    generation?: {
        stage: "text" | "image";
        phase: "loading" | "downloading" | "inference";
    },
): string {
    if (browserRuntime && modelProgressRelevant) {
        if (generation?.phase === "inference") {
            return generation.stage === "image"
                ? "aiApps.autoPropose.processingImage"
                : "aiApps.autoPropose.processingPrompt";
        }
        if (generation?.phase === "loading" || generation?.phase === "downloading") {
            return "aiApps.autoPropose.loadingModel";
        }
        if (status === "verifying") return "aiApps.autoPropose.verifyingModel";
        if (status === "loading") return "aiApps.autoPropose.loadingModel";
    }
    switch (proposalPhase) {
        case "reading_text":
            return "aiApps.autoPropose.readingMessage";
        case "reading_image":
            return "aiApps.autoPropose.readingImage";
        case "generating":
            return "aiApps.autoPropose.generatingResult";
        case "validating":
            return "aiApps.autoPropose.validatingResult";
        case "attesting":
            return "aiApps.autoPropose.attestingCard";
        case "sending":
            return "aiApps.autoPropose.sendingProposal";
        default:
            return browserRuntime && modelProgressRelevant && status === "loaded"
                ? "aiApps.autoPropose.generatingResult"
                : "aiApps.autoPropose.working";
    }
}

// Session memory: every messageId we have already looked at (matched or not, suggested or
// dismissed). Nothing is ever evaluated twice, so a dismissed suggestion stays dismissed.
const evaluationTracker = new AutoProposeEvaluationTracker();
const eventWatermarks = new AutoProposeEventWatermarks();
const MAX_PENDING_CONFIRMED_SENDS = 128;
const pendingConfirmedSends = new Map<
    string,
    { generation: number; registration: number | undefined; eligible: boolean }
>();
let evaluationGeneration = 0;

export function autoProposeSuggestionStillCurrent(
    suggestion: Pick<AutoProposeSuggestion, "viewerId" | "sessionEpoch">,
): boolean {
    return (
        suggestion.viewerId === currentUserIdStore.value &&
        suggestion.sessionEpoch === evaluationGeneration
    );
}

export function currentAutoProposeSessionEpoch(): number {
    return evaluationGeneration;
}

// Messages older than the session never auto-propose — this is what "no history backfill" means:
// A per-stream event-index watermark enforces no-history backfill without trusting wall clocks.
// Existing windows establish an immutable baseline; only explicit sends or later indices evaluate.
function viewerChatKey(viewerId: string, chatId: ChatIdentifier): string {
    return JSON.stringify([viewerId, chatIdentifierToString(chatId)]);
}

/** Prime one exact chat/thread at its subscription boundary with an authoritative event index. */
export interface AutoProposeEventRegistration {
    viewerId: string;
    token: number | undefined;
    release: () => void;
}

export function registerAutoProposeEventBoundary(
    chatId: ChatIdentifier,
    threadRootMessageIndex: number | undefined,
    latestEventIndex: number,
): AutoProposeEventRegistration {
    const viewerId = currentUserIdStore.value;
    const identityChatKey = viewerChatKey(viewerId, chatId);
    const registration = eventWatermarks.registerBoundary(
        identityChatKey,
        threadRootMessageIndex,
        latestEventIndex,
    );
    return {
        viewerId,
        token: registration,
        release: () =>
            eventWatermarks.unregisterBoundary(
                identityChatKey,
                threadRootMessageIndex,
                registration,
            ),
    };
}

/** Remove the exact main-stream root wrapper from a thread's local reply event-index stream. */
export function autoProposeThreadStreamMessages(
    messages: readonly EventWrapper<Message>[],
    threadRootEvent: EventWrapper<Message> | undefined,
): EventWrapper<Message>[] {
    return threadRootEvent === undefined
        ? [...messages]
        : messages.filter((event) => event !== threadRootEvent);
}

export function autoProposeSuggestionKey(
    viewerId: string,
    chatId: ChatIdentifier,
    threadRootMessageIndex: number | undefined,
    messageId: bigint,
): string {
    return autoProposeIdentityKey(
        viewerChatKey(viewerId, chatId),
        threadRootMessageIndex,
        messageId,
    );
}

export function dismissAutoProposeSuggestion(
    viewerId: string,
    chatId: ChatIdentifier,
    threadRootMessageIndex: number | undefined,
    messageId: bigint,
    suggestion: Pick<AutoProposeSuggestion, "appId" | "appRevision" | "actionId">,
): void {
    const key = autoProposeSuggestionKey(viewerId, chatId, threadRootMessageIndex, messageId);
    autoProposeSuggestions.update((map) => {
        const current = map.get(key);
        if (current === undefined) return map;
        const actionKey = autoProposeSuggestionActionKey(suggestion);
        const remaining = current.filter(
            (value) => autoProposeSuggestionActionKey(value) !== actionKey,
        );
        const next = new Map(map);
        if (remaining.length === 0) {
            next.delete(key);
        } else {
            next.set(key, remaining);
        }
        return next;
    });
}

// ---------------------------------------------------------------------------------------------
// Per-chat mute, persisted in localStorage (a plain JSON array of chat keys).

function loadMutedChats(): Set<string> {
    try {
        const raw = localStorage.getItem(configKeys.autoProposeMutedChats);
        if (raw === null) return new Set();
        const parsed: unknown = JSON.parse(raw);
        return new Set(
            Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [],
        );
    } catch {
        return new Set();
    }
}

const mutedChats = loadMutedChats();
export const autoProposeMuteRevision = writable(0);

export function autoProposeMutedInChat(chatId: ChatIdentifier): boolean {
    return mutedChats.has(viewerChatKey(currentUserIdStore.value, chatId));
}

export function muteAutoProposeInChat(chatId: ChatIdentifier): void {
    const chatKey = chatIdentifierToString(chatId);
    const viewerId = currentUserIdStore.value;
    mutedChats.add(viewerChatKey(viewerId, chatId));
    try {
        localStorage.setItem(configKeys.autoProposeMutedChats, JSON.stringify([...mutedChats]));
    } catch {
        // Persisting is best-effort; the in-memory mute still applies for this session.
    }
    autoProposeMuteRevision.update((revision) => revision + 1);
    revokePrivateAutoProposeRuntime();
    // Muting also clears anything already suggested in that chat.
    autoProposeSuggestions.update((map) => {
        for (const [messageId, suggestions] of map) {
            if (
                suggestions.some(
                    (suggestion) =>
                        suggestion.chatKey === chatKey && suggestion.viewerId === viewerId,
                )
            ) {
                map.delete(messageId);
            }
        }
        return map;
    });
}

// ---------------------------------------------------------------------------------------------
// Vocabulary cache: chat key -> the keyword-bearing enabled actions, refreshed at most once a
// minute. The value is the in-flight/settled promise so concurrent messages share one lookup.

const VOCABULARY_TTL_MS = 60_000;
type AutoProposeSource = AiActionCoordinates & {
    title: string;
    appName: string;
};
type AutoProposeContext = {
    vocabulary: AutoProposeVocabulary;
    publicSources: AutoProposeSource[];
    privateCandidates: AiActionCandidate[];
};
const vocabularyCache = new Map<
    string,
    { expiresAt: number; entries: Promise<AutoProposeContext> }
>();

function invalidateAutoProposeRuntime(): void {
    evaluationGeneration += 1;
    evaluationTracker.clear();
    eventWatermarks.clear();
    pendingConfirmedSends.clear();
    vocabularyCache.clear();
    autoProposeSuggestions.set(new Map());
    abortPrivateMatchOperations();
}

/**
 * Revoke all captured/private-derived work without resetting stream watermarks. Keeping the active
 * boundaries is essential: reconnecting, enabling, or unmuting must not backfill earlier texts.
 */
export function revokePrivateAutoProposeRuntime(): void {
    evaluationGeneration += 1;
    evaluationTracker.clear();
    vocabularyCache.clear();
    pendingConfirmedSends.clear();
    autoProposeSuggestions.set(new Map());
    abortPrivateMatchOperations();
}

/** Restore suggestions for only the current viewer and exact chat. */
export function unmuteAutoProposeInChat(chatId: ChatIdentifier): void {
    mutedChats.delete(viewerChatKey(currentUserIdStore.value, chatId));
    try {
        localStorage.setItem(configKeys.autoProposeMutedChats, JSON.stringify([...mutedChats]));
    } catch {
        // Persisting is best-effort; the in-memory unmute still applies for this session.
    }
    autoProposeMuteRevision.update((revision) => revision + 1);
}

let activeViewerId = currentUserIdStore.value;
const unsubscribeViewerChanges = currentUserIdStore.subscribe((viewerId) => {
    if (viewerId === activeViewerId) return;
    activeViewerId = viewerId;
    invalidateAutoProposeRuntime();
});
let previousAutoProposeEnabled = autoProposeEnabled.value;
const unsubscribeAutoProposeEnabled = autoProposeEnabled.subscribe((enabled) => {
    if (previousAutoProposeEnabled && !enabled) revokePrivateAutoProposeRuntime();
    previousAutoProposeEnabled = enabled;
}, undefined);

import.meta.hot?.dispose(() => {
    unsubscribeViewerChanges();
    unsubscribeAutoProposeEnabled();
    invalidateAutoProposeRuntime();
});

export async function retryAutoProposeVocabularyLookup<T>(lookup: () => Promise<T>): Promise<T> {
    try {
        return await lookup();
    } catch {
        // Exactly one in-evaluation retry. Once it fails, the message identity is terminal and no
        // later loaded-window refresh may restart private capabilities for the same message.
        return lookup();
    }
}

async function buildVocabulary(
    client: OpenChat,
    chatId: ChatIdentifier,
): Promise<AutoProposeContext> {
    const { candidates, linkRequired } = await resolveCandidates(client, chatId);
    // Link-required apps (per-user keys, not yet paired) MUST contribute too: tapping the chip runs
    // the propose flow, which is exactly where the pairing consent sheet lives — excluding them would
    // make pairing unreachable from the suggestion path.
    const untrustedSources = [
        ...candidates.map((candidate) => ({ app: candidate.app, action: candidate.action })),
        ...linkRequired.flatMap((app) => app.manifest.actions.map((action) => ({ app, action }))),
    ];
    const sourceKeys = new Set<string>();
    const sources: typeof untrustedSources = [];
    for (const source of untrustedSources) {
        const key = autoProposeSuggestionActionKey({
            appId: source.app.id,
            appRevision: source.app.updated,
            actionId: source.action.name,
        });
        if (sourceKeys.has(key)) continue;
        sourceKeys.add(key);
        sources.push(source);
        if (sources.length === MAX_AUTO_PROPOSE_ACTIONS) break;
    }
    return {
        vocabulary: buildBoundedAutoProposeVocabulary(sources.map(({ action }) => action)),
        publicSources: sources.map(({ app, action }) => ({
            appId: app.id,
            appRevision: app.updated,
            actionId: action.name,
            title: action.card.title,
            appName: app.manifest.name,
        })),
        // Consent and private_match surface eligibility are intentionally checked at execution
        // time, not cached: revoking the per-chat toggle takes effect immediately.
        privateCandidates: candidates.filter((candidate) =>
            sourceKeys.has(
                autoProposeSuggestionActionKey({
                    appId: candidate.app.id,
                    appRevision: candidate.app.updated,
                    actionId: candidate.action.name,
                }),
            ),
        ),
    };
}

function vocabularyFor(
    client: OpenChat,
    chatId: ChatIdentifier,
    viewerId: string,
): Promise<AutoProposeContext> {
    const chatKey = viewerChatKey(viewerId, chatId);
    const now = Date.now();
    const cached = vocabularyCache.get(chatKey);
    if (cached !== undefined && cached.expiresAt > now) {
        return cached.entries;
    }
    // A failed lookup caches as empty for the TTL so a flaky connection never turns the message
    // path into a canister-call loop.
    const entries = retryAutoProposeVocabularyLookup(() => buildVocabulary(client, chatId));
    vocabularyCache.set(chatKey, { expiresAt: now + VOCABULARY_TTL_MS, entries });
    // Share one in-flight lookup, but never cache a transient failure as a completed no-match.
    void entries.catch(() => {
        if (vocabularyCache.get(chatKey)?.entries === entries) {
            vocabularyCache.delete(chatKey);
        }
    });
    return entries;
}

/** Drop only this viewer/chat's app-directory snapshot after connect/enable/revision changes. */
export function refreshAutoProposeConfiguration(chatId: ChatIdentifier): void {
    vocabularyCache.delete(viewerChatKey(currentUserIdStore.value, chatId));
}

// ---------------------------------------------------------------------------------------------
// The evaluator, called from the exactly-once-per-message pub/sub seams ("sentMessage" with the
// single sent event, "loadedNewMessages" with the currently loaded messages — the session Set
// makes overlapping subscribers evaluate each message at most once).

export function evaluateForAutoPropose(
    client: OpenChat,
    chatId: ChatIdentifier,
    threadRootMessageIndex: number | undefined,
    messages: EventWrapper<Message>[],
    observation: "sent" | "sent_confirmed" | "loaded_new",
    registration?: AutoProposeEventRegistration,
): void {
    // Phase-A app enablement is group-scoped, so only group chats can have a vocabulary —
    // bailing out here keeps every other chat kind entirely off the lookup path.
    if (chatId.kind !== "group_chat" && chatId.kind !== "channel" && chatId.kind !== "direct_chat")
        return;
    const viewerId = currentUserIdStore.value;
    const chatKey = chatIdentifierToString(chatId);
    const identityChatKey = viewerChatKey(viewerId, chatId);
    if (
        observation !== "loaded_new" &&
        (registration?.viewerId !== viewerId ||
            messages.some((event) => event.event.sender !== viewerId) ||
            !eventWatermarks.isActiveRegistration(
                identityChatKey,
                threadRootMessageIndex,
                registration.token,
            ))
    )
        return;

    const suggestionsEnabled = autoProposeEnabled.value;
    const chatMuted = autoProposeMutedInChat(chatId);
    if (observation === "sent") {
        for (const event of messages) {
            const identity = autoProposeIdentityKey(
                identityChatKey,
                threadRootMessageIndex,
                event.event.messageId,
            );
            pendingConfirmedSends.delete(identity);
            pendingConfirmedSends.set(identity, {
                generation: evaluationGeneration,
                registration: registration?.token,
                eligible: suggestionsEnabled && !chatMuted,
            });
            while (pendingConfirmedSends.size > MAX_PENDING_CONFIRMED_SENDS) {
                const oldest = pendingConfirmedSends.keys().next().value as string | undefined;
                if (oldest === undefined) break;
                pendingConfirmedSends.delete(oldest);
            }
        }
    }

    // Advance the authoritative stream watermark even while suggestions are disabled or muted.
    // Enabling later can therefore never backfill exact texts observed before that opt-in.
    const observed =
        observation === "sent"
            ? messages
            : observation === "sent_confirmed"
              ? messages.filter((event) => {
                    eventWatermarks.observeSent(
                        identityChatKey,
                        threadRootMessageIndex,
                        event.index,
                        registration?.token,
                    );
                    const identity = autoProposeIdentityKey(
                        identityChatKey,
                        threadRootMessageIndex,
                        event.event.messageId,
                    );
                    const pending = pendingConfirmedSends.get(identity);
                    pendingConfirmedSends.delete(identity);
                    return (
                        pending?.generation === evaluationGeneration &&
                        pending.registration === registration?.token &&
                        pending.eligible
                    );
                })
              : registration?.viewerId === viewerId
                ? eventWatermarks.observeLoadedNew(
                      identityChatKey,
                      threadRootMessageIndex,
                      messages,
                      registration.token,
                  )
                : [];
    if (observation === "sent" && (!suggestionsEnabled || chatMuted)) {
        // A send observed while opted out is part of the closed interval. Record its stream index so
        // enabling before the canonical loaded_new refresh cannot backfill that exact text.
        for (const event of messages) {
            eventWatermarks.observeSent(
                identityChatKey,
                threadRootMessageIndex,
                event.index,
                registration?.viewerId === viewerId ? registration.token : undefined,
            );
        }
    }
    // Optimistic sends only capture bounded eligibility. They never claim the evaluation identity
    // or start vocabulary/private work; the canister-confirmed event evaluates public and private
    // triggers once, eliminating the cold-vocabulary acknowledgement race and all failed-send egress.
    if (observation === "sent") return;
    if (!suggestionsEnabled || chatMuted) return;

    const fresh = observed.filter(
        (ev) =>
            // Our own outgoing event is handled only by sentMessageConfirmed. A loaded server event
            // may resolve the send promise first, but must not bypass its captured session/opt-in.
            (observation !== "loaded_new" || ev.event.sender !== viewerId) &&
            // Text keyword-matches; an image offers extraction directly. Every other content kind
            // (action cards, video, files, …) never auto-proposes.
            (ev.event.content.kind === "text_content" ||
                ev.event.content.kind === "image_content") &&
            evaluationTracker.claim(identityChatKey, threadRootMessageIndex, ev.event.messageId),
    );
    if (fresh.length === 0) return;
    const generation = evaluationGeneration;
    const stillEligible = () =>
        generation === evaluationGeneration &&
        viewerId === currentUserIdStore.value &&
        autoProposeEnabled.value &&
        !mutedChats.has(viewerChatKey(viewerId, chatId));

    void vocabularyFor(client, chatId, viewerId)
        .then(async ({ vocabulary, publicSources, privateCandidates }) => {
            if (!stillEligible()) return;
            const publishedPublicActionKeys = new Map<string, Set<string>>();
            const immediatePublicMatches: [string, AutoProposeSuggestion[]][] = [];
            for (const ev of fresh) {
                const actionKeys = new Set<string>();
                const content = ev.event.content;
                if (content.kind === "text_content") {
                    const text = content.text.toLowerCase();
                    for (const entry of vocabulary.keywordEntries) {
                        if (entry.keywords.some((keyword) => matchesKeyword(text, keyword))) {
                            const source = publicSources[entry.actionIndex];
                            if (source !== undefined) {
                                actionKeys.add(autoProposeSuggestionActionKey(source));
                            }
                        }
                    }
                } else if (content.kind === "image_content") {
                    for (const entry of vocabulary.imageEntries) {
                        const source = publicSources[entry.actionIndex];
                        if (source !== undefined) {
                            actionKeys.add(autoProposeSuggestionActionKey(source));
                        }
                    }
                }
                if (actionKeys.size === 0) continue;
                const identity = autoProposeIdentityKey(
                    identityChatKey,
                    threadRootMessageIndex,
                    ev.event.messageId,
                );
                publishedPublicActionKeys.set(identity, actionKeys);
                immediatePublicMatches.push([
                    identity,
                    publicSources.flatMap((source) =>
                        actionKeys.has(autoProposeSuggestionActionKey(source))
                            ? [
                                  {
                                      chatKey,
                                      viewerId,
                                      sessionEpoch: generation,
                                      ...source,
                                  },
                              ]
                            : [],
                    ),
                ]);
            }
            if (immediatePublicMatches.length > 0) {
                autoProposeSuggestions.update((map) => {
                    const next = new Map(map);
                    for (const [key, suggestions] of immediatePublicMatches) {
                        next.set(key, suggestions);
                    }
                    return next;
                });
            }

            const matched: [string, AutoProposeSuggestion[]][] = [];
            for (const ev of fresh) {
                const content = ev.event.content;
                const matchedActionKeys = new Set<string>();
                if (content.kind === "text_content") {
                    const text = content.text.toLowerCase();
                    for (const entry of vocabulary.keywordEntries) {
                        if (entry.keywords.some((keyword) => matchesKeyword(text, keyword))) {
                            const source = publicSources[entry.actionIndex];
                            if (source !== undefined) {
                                matchedActionKeys.add(autoProposeSuggestionActionKey(source));
                            }
                        }
                    }
                    // Separately-consented private-match apps are evaluated even when a public rule
                    // also matched. Every candidate receives its own one-use, exact
                    // message/app/revision/action/key-bound capability; the returned public action
                    // coordinates are then unioned and deduplicated below.
                    const privateResult = await runPrivateMatchCandidates(
                        client,
                        chatId,
                        threadRootMessageIndex,
                        ev.event.messageId,
                        content.text,
                        privateCandidates,
                        viewerId,
                        stillEligible,
                    );
                    if (!stillEligible()) return;
                    if (privateResult.kind === "matched") {
                        for (const candidate of privateResult.candidates) {
                            matchedActionKeys.add(
                                autoProposeSuggestionActionKey({
                                    appId: candidate.app.id,
                                    appRevision: candidate.app.updated,
                                    actionId: candidate.action.name,
                                }),
                            );
                        }
                    }
                } else if (content.kind === "image_content") {
                    // An image carries no keywords to match — offer to extract from it whenever the chat
                    // has any candidate app, mirroring the manual "Propose action" on an image.
                    for (const entry of vocabulary.imageEntries) {
                        const source = publicSources[entry.actionIndex];
                        if (source !== undefined) {
                            matchedActionKeys.add(autoProposeSuggestionActionKey(source));
                        }
                    }
                }
                const suggestions = publicSources.flatMap((source) =>
                    matchedActionKeys.has(autoProposeSuggestionActionKey(source))
                        ? [
                              {
                                  chatKey,
                                  viewerId,
                                  sessionEpoch: generation,
                                  ...source,
                              },
                          ]
                        : [],
                );
                if (suggestions.length > 0) {
                    matched.push([
                        autoProposeIdentityKey(
                            identityChatKey,
                            threadRootMessageIndex,
                            ev.event.messageId,
                        ),
                        suggestions,
                    ]);
                }
                // Every event reaching this point is authoritative (confirmed outgoing or loaded
                // incoming), so its bounded public/private decision is terminal for this activation.
                evaluationTracker.finish(
                    identityChatKey,
                    threadRootMessageIndex,
                    ev.event.messageId,
                    true,
                );
            }
            if (matched.length === 0) return;
            // Re-check the toggles: they may have flipped while the vocabulary was fetched.
            if (!stillEligible()) return;
            autoProposeSuggestions.update((map) => {
                const next = new Map(map);
                for (const [key, suggestions] of matched) {
                    const publicKeys = publishedPublicActionKeys.get(key) ?? new Set<string>();
                    const retainedKeys = new Set(
                        (map.get(key) ?? []).map(autoProposeSuggestionActionKey),
                    );
                    const retained = suggestions.filter((suggestion) => {
                        const actionKey = autoProposeSuggestionActionKey(suggestion);
                        return !publicKeys.has(actionKey) || retainedKeys.has(actionKey);
                    });
                    if (retained.length > 0) next.set(key, retained);
                }
                return next;
            });
        })
        .catch(() => {
            if (generation !== evaluationGeneration || viewerId !== currentUserIdStore.value)
                return;
            for (const ev of fresh) {
                evaluationTracker.finish(
                    identityChatKey,
                    threadRootMessageIndex,
                    ev.event.messageId,
                    true,
                );
            }
        });
}
