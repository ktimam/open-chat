// App-level orchestrator for the in-OpenChat AI-action runner.
//
// Ties together the three verified pieces: the AI-app directory (client.aiApps()), the on-device model
// (inferOnDevice), and the generic runner (runAiAction, in openchat-shared). Given a chat message's content,
// it runs the offered action on-device and returns a proposable confirm-card. The caller posts the card
// with client.sendMessageWithContent — on confirm, OpenChat encrypts confirmPayload to the action's
// recipient_public_key and deposits it into the action_inbox. Nothing here is app-specific.
//
// Scoping (Phase A): in a group chat the actions on offer come from the AI-app directory — the apps the
// group's owner/admins enabled in that chat (client.enabledAiApps X client.aiApps), flattened to
// (app, action) pairs. A chat with no enabled app — including every non-group chat, where there is no app
// enablement yet (Phase A.1) — offers no actions.

import {
    buildActionCardContent,
    runAiAction,
    type AiActionDefinition,
    type AiAppRegistration,
    type RunAiActionResult,
} from "openchat-shared";
import type { ChatIdentifier, MessageContent, MessageContext, OpenChat } from "openchat-client";
import { inferOnDevice } from "./onDeviceInference";

// A directory app's action offered in a chat, with the delivery key already resolved. For a
// per-user-keys app this is the proposing user's own registered key (from my_ai_app_keys);
// otherwise it is the action's own consumer key when it declares one, else the app-level key from
// the manifest. Pairs with no resolvable key are not runnable and are never surfaced.
export interface AiActionCandidate {
    app: AiAppRegistration;
    action: AiActionDefinition;
    recipientKey: string;
}

export type ProposeResult =
    | RunAiActionResult
    // No AI app is enabled in this chat (non-group chats never have one — Phase A.1).
    | { kind: "no_actions" }
    // The message content isn't something the runner can extract from.
    | { kind: "unsupported_content" }
    // More than one enabled (app, action) pair applies — the UI must show a chooser and run the
    // picked candidate with proposeAndPostCandidate.
    | { kind: "choose"; candidates: AiActionCandidate[] }
    // Every enabled candidate comes from a per-user-keys app the user has not linked yet — the UI
    // must run the one-time consent flow (create a link code, wait for the app to claim it) and
    // then re-propose.
    | { kind: "link_required"; app: AiAppRegistration };

export interface ResolvedCandidates {
    candidates: AiActionCandidate[];
    // Enabled per-user-keys apps the user has no registered key for. Their actions must NOT fall
    // back to the manifest/action key (it belongs to someone else) — they need the one-time
    // link-code pairing first.
    linkRequired: AiAppRegistration[];
}

// Resolve the (app, action) candidates on offer in a chat: the apps enabled in the chat crossed with the
// global app directory, flattened. Phase A: the directory is group-scoped only, so any other chat kind
// resolves to no candidates. Exported so the auto-propose matcher (utils/autoPropose.ts) derives its
// trigger vocabulary from this same resolution.
export async function resolveCandidates(
    client: OpenChat,
    chatId: ChatIdentifier,
): Promise<ResolvedCandidates> {
    if (chatId.kind !== "group_chat") return { candidates: [], linkRequired: [] };
    const [enabledIds, apps] = await Promise.all([client.enabledAiApps(chatId), client.aiApps()]);
    const enabled = new Set(enabledIds);
    const enabledApps = apps.filter((app) => enabled.has(app.id));

    // The user's own registered delivery keys, fetched only when an enabled app declares per-user
    // keys — apps without per_user_keys resolve exactly as before.
    const myKeys = new Map<number, string>();
    if (enabledApps.some((app) => app.manifest.perUserKeys === true)) {
        for (const key of await client.myAiAppKeys()) {
            myKeys.set(key.appId, key.publicKey);
        }
    }

    const candidates: AiActionCandidate[] = [];
    const linkRequired: AiAppRegistration[] = [];
    for (const app of enabledApps) {
        if (app.manifest.perUserKeys === true) {
            // Per-user delivery: the ONLY acceptable recipient is the proposing user's own key.
            const myKey = myKeys.get(app.id);
            if (myKey === undefined || myKey.length === 0) {
                linkRequired.push(app);
                continue;
            }
            for (const action of app.manifest.actions) {
                candidates.push({ app, action, recipientKey: myKey });
            }
            continue;
        }
        // Legacy single-key delivery, unchanged: the action's own key else the manifest key.
        for (const action of app.manifest.actions) {
            const recipientKey =
                (action.consumerPublicKey?.length ?? 0) > 0
                    ? (action.consumerPublicKey as string)
                    : app.manifest.consumerPublicKey;
            if (recipientKey.length === 0) continue;
            candidates.push({ app, action, recipientKey });
        }
    }
    return { candidates, linkRequired };
}

// Turn a message's content into runner input. Text is used directly; an image's bytes are fetched from the
// (already-decrypted, displayable) blob URL so the on-device vision model can read it (the receipt case).
async function contentToInput(
    content: MessageContent,
): Promise<{ text?: string; image?: Uint8Array } | undefined> {
    if (content.kind === "text_content") {
        return { text: content.text };
    }
    if (content.kind === "image_content" && content.blobUrl !== undefined) {
        try {
            const resp = await fetch(content.blobUrl);
            if (!resp.ok) return undefined;
            return { image: new Uint8Array(await resp.arrayBuffer()) };
        } catch {
            return undefined;
        }
    }
    return undefined;
}

// Run one action definition against the message content, delivering to the given recipient key.
// When the caller supplies an extraction directly (no on-device runtime, or a native client with no
// model), the card is built from it with no inference — the rest of the cycle is identical.
async function runDefinition(
    def: AiActionDefinition,
    recipientKey: string,
    content: MessageContent,
    manualExtraction?: Record<string, unknown>,
): Promise<ProposeResult> {
    if (manualExtraction !== undefined) {
        const card = buildActionCardContent(def, manualExtraction, recipientKey);
        return { kind: "ready", card, extracted: manualExtraction };
    }

    const input = await contentToInput(content);
    if (input === undefined) return { kind: "unsupported_content" };

    return runAiAction(def, input, recipientKey, inferOnDevice);
}

// Run the action on offer for a message in this chat, returning a card to propose (or a status).
// The AI-app directory is the only source of actions: exactly one runnable candidate runs directly,
// several defer to the UI's chooser. When the only enabled apps are per-user-keys apps the user
// hasn't linked yet, the caller must run the consent flow ("link_required"). A chat with no enabled
// app — including every non-group chat — yields "no_actions".
export async function proposeAiActionForMessage(
    client: OpenChat,
    chatId: ChatIdentifier,
    content: MessageContent,
    manualExtraction?: Record<string, unknown>,
): Promise<ProposeResult> {
    const { candidates, linkRequired } = await resolveCandidates(client, chatId);
    if (candidates.length === 1) {
        const c = candidates[0];
        return runDefinition(c.action, c.recipientKey, content, manualExtraction);
    }
    if (candidates.length > 1) {
        return { kind: "choose", candidates };
    }
    if (linkRequired.length > 0) {
        return { kind: "link_required", app: linkRequired[0] };
    }
    return { kind: "no_actions" };
}

// Convenience: run + post. Posts the proposed card into the chat (Pending) for the user to confirm.
export async function proposeAndPost(
    client: OpenChat,
    messageContext: MessageContext,
    content: MessageContent,
    manualExtraction?: Record<string, unknown>,
): Promise<ProposeResult> {
    const result = await proposeAiActionForMessage(
        client,
        messageContext.chatId,
        content,
        manualExtraction,
    );
    if (result.kind === "ready") {
        client.sendMessageWithContent(messageContext, result.card, false, [], false);
    }
    return result;
}

// The second half of the chooser flow: run the (app, action) candidate the user picked and post the
// proposed card on success. Never returns "choose".
export async function proposeAndPostCandidate(
    client: OpenChat,
    messageContext: MessageContext,
    content: MessageContent,
    candidate: AiActionCandidate,
    manualExtraction?: Record<string, unknown>,
): Promise<ProposeResult> {
    const result = await runDefinition(
        candidate.action,
        candidate.recipientKey,
        content,
        manualExtraction,
    );
    if (result.kind === "ready") {
        client.sendMessageWithContent(messageContext, result.card, false, [], false);
    }
    return result;
}
