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

import type { ChatIdentifier, EventWrapper, Message, OpenChat } from "openchat-client";
import { matchesKeyword } from "./keywordMatch";
import { chatIdentifierToString } from "openchat-client";
import { writable } from "svelte/store";
import { autoProposeSuggestions as autoProposeEnabled } from "../stores/settings";
import { configKeys } from "./config";
import { resolveCandidates } from "./aiActionRunner";
import {
    buildBoundedAutoProposeVocabulary,
    type AutoProposeVocabulary,
} from "./autoProposeVocabulary";

// ---------------------------------------------------------------------------------------------
// Suggestion store — keyed by messageId, read by ChatMessage to render the chip.

export interface AutoProposeSuggestion {
    // chatIdentifierToString of the chat the message lives in (lets a chat-level mute clear its
    // outstanding suggestions).
    chatKey: string;
    // The matched action's card title — the chip reads "Propose <title>?".
    title: string;
}

export const autoProposeSuggestions = writable<Map<bigint, AutoProposeSuggestion>>(new Map());

// Session memory: every messageId we have already looked at (matched or not, suggested or
// dismissed). Nothing is ever evaluated twice, so a dismissed suggestion stays dismissed.
const evaluated = new Set<bigint>();

// Messages older than the session never auto-propose — this is what "no history backfill" means:
// scrolling old events into view (or reloading a window) only ever evaluates messages that were
// actually sent while this session was running.
const sessionStart = Date.now();

export function dismissAutoProposeSuggestion(messageId: bigint): void {
    autoProposeSuggestions.update((map) => {
        map.delete(messageId);
        return map;
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

export function autoProposeMutedInChat(chatId: ChatIdentifier): boolean {
    return mutedChats.has(chatIdentifierToString(chatId));
}

export function muteAutoProposeInChat(chatId: ChatIdentifier): void {
    const chatKey = chatIdentifierToString(chatId);
    mutedChats.add(chatKey);
    try {
        localStorage.setItem(configKeys.autoProposeMutedChats, JSON.stringify([...mutedChats]));
    } catch {
        // Persisting is best-effort; the in-memory mute still applies for this session.
    }
    // Muting also clears anything already suggested in that chat.
    autoProposeSuggestions.update((map) => {
        for (const [messageId, suggestion] of map) {
            if (suggestion.chatKey === chatKey) {
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
const vocabularyCache = new Map<
    string,
    { expiresAt: number; entries: Promise<AutoProposeVocabulary> }
>();

async function buildVocabulary(
    client: OpenChat,
    chatId: ChatIdentifier,
): Promise<AutoProposeVocabulary> {
    const { candidates, linkRequired } = await resolveCandidates(client, chatId);
    // Link-required apps (per-user keys, not yet paired) MUST contribute too: tapping the chip runs
    // the propose flow, which is exactly where the pairing consent sheet lives — excluding them would
    // make pairing unreachable from the suggestion path.
    const actions = [
        ...candidates.map((c) => c.action),
        ...linkRequired.flatMap((app) => app.manifest.actions),
    ];
    return buildBoundedAutoProposeVocabulary(actions);
}

function vocabularyFor(client: OpenChat, chatId: ChatIdentifier): Promise<AutoProposeVocabulary> {
    const chatKey = chatIdentifierToString(chatId);
    const now = Date.now();
    const cached = vocabularyCache.get(chatKey);
    if (cached !== undefined && cached.expiresAt > now) {
        return cached.entries;
    }
    // A failed lookup caches as empty for the TTL so a flaky connection never turns the message
    // path into a canister-call loop.
    const entries = buildVocabulary(client, chatId).catch(
        () => ({ keywordEntries: [] }) as AutoProposeVocabulary,
    );
    vocabularyCache.set(chatKey, { expiresAt: now + VOCABULARY_TTL_MS, entries });
    return entries;
}

// ---------------------------------------------------------------------------------------------
// The evaluator, called from the exactly-once-per-message pub/sub seams ("sentMessage" with the
// single sent event, "loadedNewMessages" with the currently loaded messages — the session Set
// makes overlapping subscribers evaluate each message at most once).

export function evaluateForAutoPropose(
    client: OpenChat,
    chatId: ChatIdentifier,
    messages: EventWrapper<Message>[],
): void {
    if (!autoProposeEnabled.value) return;
    // Phase-A app enablement is group-scoped, so only group chats can have a vocabulary —
    // bailing out here keeps every other chat kind entirely off the lookup path.
    if (chatId.kind !== "group_chat" && chatId.kind !== "channel" && chatId.kind !== "direct_chat")
        return;
    if (autoProposeMutedInChat(chatId)) return;

    const fresh = messages.filter(
        (ev) =>
            // Text keyword-matches; an image offers extraction directly. Every other content kind
            // (action cards, video, files, …) never auto-proposes.
            (ev.event.content.kind === "text_content" ||
                ev.event.content.kind === "image_content") &&
            Number(ev.timestamp) >= sessionStart &&
            !evaluated.has(ev.event.messageId),
    );
    if (fresh.length === 0) return;
    // Mark before the (possibly async) vocabulary lookup so a concurrent event for the same
    // message is a no-op.
    for (const ev of fresh) {
        evaluated.add(ev.event.messageId);
    }

    void vocabularyFor(client, chatId).then((vocabulary) => {
        if (vocabulary.keywordEntries.length === 0 && vocabulary.imageTitle === undefined) return;
        const chatKey = chatIdentifierToString(chatId);
        const matched: [bigint, AutoProposeSuggestion][] = [];
        for (const ev of fresh) {
            const content = ev.event.content;
            if (content.kind === "text_content") {
                // First matching action wins; tapping the chip re-runs the full propose flow, which
                // shows the chooser anyway when several actions apply.
                const text = content.text.toLowerCase();
                const entry = vocabulary.keywordEntries.find((v) =>
                    v.keywords.some((k) => matchesKeyword(text, k)),
                );
                if (entry !== undefined) {
                    matched.push([ev.event.messageId, { chatKey, title: entry.title }]);
                }
            } else if (content.kind === "image_content" && vocabulary.imageTitle !== undefined) {
                // An image carries no keywords to match — offer to extract from it whenever the chat
                // has any candidate app, mirroring the manual "Propose action" on an image.
                matched.push([ev.event.messageId, { chatKey, title: vocabulary.imageTitle }]);
            }
        }
        if (matched.length === 0) return;
        // Re-check the toggles: they may have flipped while the vocabulary was fetched.
        if (!autoProposeEnabled.value || mutedChats.has(chatKey)) return;
        autoProposeSuggestions.update((map) => {
            for (const [messageId, suggestion] of matched) {
                map.set(messageId, suggestion);
            }
            return map;
        });
    });
}
