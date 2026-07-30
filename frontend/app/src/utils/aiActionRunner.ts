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
    applyRulesPostPass,
    buildActionCardContent,
    buildMultiActionCardContent,
    missingRequired,
    runAiAction,
    type AiActionDefinition,
    type AiAppRegistration,
    type ModelModality,
    type RunAiActionResult,
} from "openchat-shared";
import type { ChatIdentifier, MessageContent, MessageContext, OpenChat } from "openchat-client";
import { inferOnDevice, onDeviceInferenceCapability } from "./onDeviceInference";

// A directory app's action offered in a chat, with the delivery key already resolved. For a
// per-user-keys app this is the proposing user's own registered key (from my_ai_app_keys);
// otherwise it is the action's own consumer key when it declares one, else the app-level key from
// the manifest. Pairs with no resolvable key are not runnable and are never surfaced.
export interface AiActionCandidate {
    app: AiAppRegistration;
    action: AiActionDefinition;
    recipientKey: string;
    // Fan-out delivery: the OTHER chat members' registered keys for this app (resolved at propose
    // time via ai_app_user_keys). On confirm the deposit is encrypted to recipientKey AND each of
    // these, so every listed member's app inbox receives the action — not just the proposer's.
    additionalRecipientKeys?: string[];
    // Per-app inbox override from the app's manifest (undefined => global action_inbox).
    inboxCanisterId?: string;
}

export type ProposeResult =
    | RunAiActionResult
    // No AI app is enabled in this chat (non-group chats never have one — Phase A.1).
    | { kind: "no_actions" }
    // The message content isn't something the runner can extract from.
    | { kind: "unsupported_content" }
    // The message IS an image but the SELECTED MODEL has no image modality. The remedy is the same
    // in every client — pick an image-capable model — so this carries only the model that refused.
    | { kind: "image_unsupported"; modelId?: string }
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
// global app directory, flattened. Groups and channels carry an admin-curated enabled set on their
// canister; direct chats have no admin, so the user's CONNECTED apps (published per-user-keys apps
// they hold a delivery key for) participate automatically. Exported so the auto-propose matcher
// (utils/autoPropose.ts) derives its trigger vocabulary from this same resolution.
export async function resolveCandidates(
    client: OpenChat,
    chatId: ChatIdentifier,
): Promise<ResolvedCandidates> {
    if (chatId.kind === "direct_chat") {
        // v0 direct-chat enablement: your connected apps ARE the enabled set. An app you haven't
        // connected surfaces as `link_required` (so you can onboard IOU straight from a 1:1 chat —
        // previously it was silently skipped, and pairing was only reachable from a group).
        const apps = await client.aiApps();
        const perUserApps = apps.filter((app) => app.manifest.perUserKeys === true);
        if (perUserApps.length === 0) return { candidates: [], linkRequired: [] };
        const myKeys = new Map<number, string>();
        for (const key of await client.myAiAppKeys()) {
            myKeys.set(key.appId, key.publicKey);
        }
        const candidates: AiActionCandidate[] = [];
        const linkRequired: AiAppRegistration[] = [];
        for (const app of perUserApps) {
            const myKey = myKeys.get(app.id);
            if (myKey === undefined || myKey.length === 0) {
                linkRequired.push(app);
                continue;
            }
            // Fan-out: the OTHER participant's registered key for this app (if they connected it).
            // Best-effort — a failed lookup degrades to proposer-only delivery, exactly the old
            // behaviour. With it, a confirm lands in BOTH members' app inboxes immediately.
            const otherKeys = (await client.aiAppUserKeys(app.id, [chatId.userId]))
                .map((k) => k.publicKey)
                .filter((k) => k.length > 0);
            for (const action of app.manifest.actions) {
                candidates.push({
                    app,
                    action,
                    recipientKey: myKey,
                    additionalRecipientKeys: otherKeys.length > 0 ? otherKeys : undefined,
                    inboxCanisterId: app.manifest.inboxCanisterId,
                });
            }
        }
        return { candidates, linkRequired };
    }
    if (chatId.kind !== "group_chat" && chatId.kind !== "channel") {
        return { candidates: [], linkRequired: [] };
    }
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
                candidates.push({ app, action, recipientKey: myKey, inboxCanisterId: app.manifest.inboxCanisterId });
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
            candidates.push({ app, action, recipientKey, inboxCanisterId: app.manifest.inboxCanisterId });
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
    if (content.kind === "image_content") {
        // Prefer the raw bytes when present: a just-sent image carries `blobData` but often has no
        // `blobUrl` yet (that object URL is populated lazily when the blob is loaded for display).
        // Reading ONLY blobUrl made propose fail with "unsupported_content" on freshly-sent images
        // even though their bytes were already in hand. Fall back to fetching the display URL.
        if (content.blobData !== undefined && content.blobData.length > 0) {
            return { image: content.blobData };
        }
        if (content.blobUrl !== undefined) {
            try {
                const resp = await fetch(content.blobUrl);
                if (resp.ok) return { image: new Uint8Array(await resp.arrayBuffer()) };
            } catch {
                /* fall through — nothing usable */
            }
        }
    }
    return undefined;
}

// A manual extraction is either a single entry (OBJECT) or several (ARRAY of objects) — the test/
// manual prompt answer may be either, mirroring what the model may emit.
export type ManualExtraction = Record<string, unknown> | Record<string, unknown>[];

// The manual-extraction half of runDefinition, exported as a pure seam for tests. A caller-supplied
// extraction goes through the SAME deterministic gate as the model path — the rules post-pass
// (schema conformance included) and the required-fields check, applied PER ELEMENT — so the manual
// path can never post a card the model path would have refused (e.g. a degenerate amount 0 against a
// schema requiring amount > 0, which the consumer then rejects as an invalid draft). Degenerate
// elements are dropped; 0 valid → the existing "model found no action" UX (`raw` carries the ORIGINAL
// manual extraction for surfacing), 1 valid → the single-entry OBJECT card, ≥2 valid → ONE multi
// card whose confirmPayload is the JSON ARRAY.
export function buildManualCard(
    def: AiActionDefinition,
    manualExtraction: ManualExtraction,
    recipientKey: string,
    inboxCanisterId?: string,
    additionalRecipientKeys?: string[],
    // The owning app id, baked onto the built card so the recipient binds the surface to this app.
    appId?: number,
): ProposeResult {
    const candidates = Array.isArray(manualExtraction) ? manualExtraction : [manualExtraction];
    // No message text: message-driven rules (from_message / keyword_map override) don't apply to a
    // manual extraction — normalize + schema conformance still run, per element.
    const valid: Record<string, unknown>[] = [];
    for (const candidate of candidates) {
        const finalExtraction = applyRulesPostPass(
            def.rules ?? [],
            candidate,
            undefined,
            def.responseSchema,
        );
        if (missingRequired(finalExtraction, def.responseSchema).length === 0) {
            valid.push(finalExtraction);
        }
    }
    if (valid.length === 0) {
        return { kind: "no_extraction", raw: JSON.stringify(manualExtraction) };
    }
    if (valid.length === 1) {
        const card = buildActionCardContent(
            def,
            valid[0],
            recipientKey,
            inboxCanisterId,
            additionalRecipientKeys,
            appId,
        );
        return { kind: "ready", card, extracted: valid[0] };
    }
    const card = buildMultiActionCardContent(
        def,
        valid,
        recipientKey,
        inboxCanisterId,
        additionalRecipientKeys,
        appId,
    );
    return { kind: "ready_multi", card, extracted: valid };
}

// Test seam for the manual-JSON extraction prompt (Issue 1): the raw `window.prompt` fallback for
// clients with no on-device model runs ONLY when this is enabled — either
// `localStorage["oc:manualExtract"] === "1"` or the URL carries `?manualExtract=1`. Real users
// (seam OFF) are guided to set up an on-device model instead of seeing a raw JSON box; the automated
// journey harness sets the flag to keep driving the confirm → deposit cycle without a model.
export function manualExtractEnabled(): boolean {
    if (typeof window === "undefined") return false;
    try {
        if (window.localStorage?.getItem("oc:manualExtract") === "1") return true;
    } catch {
        // localStorage can throw in locked-down sandboxes — treat as disabled.
    }
    try {
        if (new URLSearchParams(window.location.search).get("manualExtract") === "1") return true;
    } catch {
        // no parseable query string — treat as disabled.
    }
    return false;
}

// Run one action definition against the message content, delivering to the given recipient key.
// When the caller supplies an extraction directly (no on-device runtime, or a native client with no
// model), the card is built from it with no inference — the rest of the cycle is identical, INCLUDING
// the deterministic post-pass + required-fields gate (buildManualCard).
async function runDefinition(
    def: AiActionDefinition,
    recipientKey: string,
    content: MessageContent,
    manualExtraction?: ManualExtraction,
    inboxCanisterId?: string,
    additionalRecipientKeys?: string[],
    // The id of the app that owns this action, baked onto the built card (see ActionCardContent.appId).
    appId?: number,
): Promise<ProposeResult> {
    if (manualExtraction !== undefined) {
        return buildManualCard(def, manualExtraction, recipientKey, inboxCanisterId, additionalRecipientKeys, appId);
    }

    const input = await contentToInput(content);
    if (input === undefined) return { kind: "unsupported_content" };

    // An image needs a model with the "image" modality. Without this the bytes were shipped into a
    // text-only runtime and the propose silently did NOTHING (browser) or failed deep inside the
    // native plugin — the user got no explanation either way. Both entry points (the message menu and
    // the auto-propose chip) funnel through here, so one gate covers both.
    if (input.image !== undefined) {
        const blocked = imageUnsupportedReason(onDeviceInferenceCapability());
        if (blocked !== undefined) return blocked;
    }

    return runAiAction(def, input, recipientKey, inferOnDevice, inboxCanisterId, additionalRecipientKeys, appId);
}

/**
 * Can this client read an IMAGE right now? Returns undefined when it can, else the ProposeResult
 * explaining why not. Pure (capability + client kind in, verdict out) so the policy is unit-testable
 * without a Tauri bridge or a loaded model.
 *
 * The verdict is about the MODEL, never about which client you are in — so this takes ONLY the
 * capability. Browser vision is absent today, not impossible: `webEligibleModels` excludes the 2-FILE
 * shape (weights + a separate mmproj projector) within a ~2 GB wasm32 envelope — a single-file vision
 * GGUF under that ceiling would already pass — and `webInfer` then rejects images because the WASM
 * projector path is unimplemented, not because a browser cannot do it. So when a browser-runnable
 * image model appears, the capability probe starts reporting "image" and this allows it with no change
 * here. Deliberately NOT branching on native-vs-browser: a distinction the UI does not use is the kind
 * of dead code that let this whole failure go unreported in the first place.
 */
export function imageUnsupportedReason(capability: {
    selectedModalities: ModelModality[];
    selectedModelId?: string;
}): { kind: "image_unsupported"; modelId?: string } | undefined {
    if (capability.selectedModalities.includes("image")) return undefined;
    return { kind: "image_unsupported", modelId: capability.selectedModelId };
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
    manualExtraction?: ManualExtraction,
): Promise<ProposeResult> {
    const { candidates, linkRequired } = await resolveCandidates(client, chatId);
    if (candidates.length === 1) {
        const c = candidates[0];
        return runDefinition(
            c.action,
            c.recipientKey,
            content,
            manualExtraction,
            c.inboxCanisterId,
            c.additionalRecipientKeys,
            c.app.id,
        );
    }
    if (candidates.length > 1) {
        return { kind: "choose", candidates };
    }
    if (linkRequired.length > 0) {
        return { kind: "link_required", app: linkRequired[0] };
    }
    return { kind: "no_actions" };
}

// Post the proposed card. The send was previously FIRE-AND-FORGET (no await, no catch), so if posting
// the card message failed the whole propose ended in silence: the extraction prompt had been answered,
// no toast appeared, and simply no card showed up — indistinguishable from "nothing matched". Await it
// and turn a failure into an "error" result so the caller can surface it.
async function postCard(
    client: OpenChat,
    messageContext: MessageContext,
    result: ProposeResult & { kind: "ready" | "ready_multi" },
): Promise<ProposeResult> {
    try {
        // NB: this does NOT throw on failure — it RESOLVES with a failure response (e.g. the chat is
        // missing from the store, or the send is throttled), which is the other half of why a failed
        // propose was completely silent. Inspect the response, don't just await it.
        const res = await client.sendMessageWithContent(messageContext, result.card, false, [], false);
        if (res?.kind !== undefined && res.kind !== "success") {
            console.error("[aiAction] posting the proposed card was rejected", res);
            return { kind: "error", error: `could not post the card (${res.kind})` };
        }
        return result;
    } catch (err) {
        console.error("[aiAction] posting the proposed card failed", err);
        return { kind: "error", error: String((err as { message?: string })?.message ?? err) };
    }
}

// Convenience: run + post. Posts the proposed card into the chat (Pending) for the user to confirm.
export async function proposeAndPost(
    client: OpenChat,
    messageContext: MessageContext,
    content: MessageContent,
    manualExtraction?: ManualExtraction,
): Promise<ProposeResult> {
    const result = await proposeAiActionForMessage(
        client,
        messageContext.chatId,
        content,
        manualExtraction,
    );
    if (result.kind === "ready" || result.kind === "ready_multi") {
        return postCard(client, messageContext, result);
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
    manualExtraction?: ManualExtraction,
): Promise<ProposeResult> {
    const result = await runDefinition(
        candidate.action,
        candidate.recipientKey,
        content,
        manualExtraction,
        candidate.inboxCanisterId,
        candidate.additionalRecipientKeys,
        candidate.app.id,
    );
    if (result.kind === "ready" || result.kind === "ready_multi") {
        return postCard(client, messageContext, result);
    }
    return result;
}
