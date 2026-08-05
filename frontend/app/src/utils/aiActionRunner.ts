// App-level orchestrator for the in-OpenChat AI-action runner.
//
// Ties together the three verified pieces: bounded AI-app lookup, the on-device model
// (inferOnDevice), and the generic runner (runAiAction, in openchat-shared). Given a chat message's content,
// it runs the offered action on-device and returns a proposable confirm-card. The caller posts the card
// with client.sendMessageWithContent. On confirm, OpenChat resolves the card's exact published app
// revision, action, inbox and authoritative chat-member keys before depositing. Nothing here is
// app-specific.
//
// Scoping (Phase A): in a group chat the actions on offer come from the AI-app directory — the apps the
// group's owner/admins enabled in that chat (enabled ids crossed with a bounded exact lookup), flattened to
// (app, action) pairs. Direct chats offer no actions while their provenance/send path is unsupported;
// the UI must not offer an operation the backend will reject.

import {
    applyRulesPostPass,
    buildActionCardContent,
    MAX_AI_ACTION_CANDIDATES,
    missingRequired,
    random64,
    runAiAction,
    type AiActionDefinition,
    type AiAppCardContentV1,
    type AiAppRegistration,
    type ModelModality,
    type RunAiActionResult,
} from "openchat-shared";
import type { ChatIdentifier, MessageContent, MessageContext, OpenChat } from "openchat-client";
import { appContentAttestationAvailable } from "./aiActionAvailability";
import { cardSurfaceOpening } from "./aiAppSurfaces";
import { inferOnDevice, onDeviceInferenceCapability } from "./onDeviceInference";

const MAX_AI_ACTION_ENABLED_APPS = 32;

// A directory app's action offered in a chat, with the delivery key already resolved. For a
// per-user-keys app this is the proposing user's own registered key (from my_ai_app_keys);
// otherwise it is the action's own consumer key when it declares one, else the app-level key from
// the manifest. Pairs with no resolvable key are not runnable and are never surfaced.
export interface AiActionCandidate {
    app: AiAppRegistration;
    action: AiActionDefinition;
    recipientKey: string;
    // Legacy sender-routing fields retained for wire compatibility. Current canisters ignore these
    // and resolve recipients/inbox from the vouched manifest and authoritative membership at confirm.
    additionalRecipientKeys?: string[];
    inboxCanisterId?: string;
}

export type AiActionUnavailableReason =
    | "missing_card_surface"
    | "missing_inbox_route"
    | "content_attestation_unavailable";

export interface AiActionUnavailable {
    app: AiAppRegistration;
    reason: AiActionUnavailableReason;
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
    | { kind: "link_required"; app: AiAppRegistration }
    // Enabled apps exist, but starting a proposal would create a card that cannot safely complete.
    // This is decided before local inference, provenance minting, or posting.
    | { kind: "actions_unavailable"; unavailable: AiActionUnavailable[] };

export interface ResolvedCandidates {
    candidates: AiActionCandidate[];
    // Enabled per-user-keys apps the user has no registered key for. Their actions must NOT fall
    // back to the manifest/action key (it belongs to someone else) — they need the one-time
    // link-code pairing first.
    linkRequired: AiAppRegistration[];
    unavailable: AiActionUnavailable[];
}

function unavailableReasonForApp(
    app: AiAppRegistration,
    chatId: ChatIdentifier,
): AiActionUnavailableReason | undefined {
    // UserIndex provenance resolution requires an actual registered card surface. Classic cards are
    // not a supported fallback for new app-bound proposals because they cannot display private app
    // context or prove the sender's title/rows/payload came from the app.
    if (cardSurfaceOpening(app, chatId) === undefined) return "missing_card_surface";
    // A card with no app inbox can be proposed but can never deliver a confirmed action. Reject it
    // before spending model work or asking the user to confirm a doomed operation.
    if ((app.manifest.inboxCanisterId?.trim().length ?? 0) === 0) return "missing_inbox_route";
    // Temporary global kill-switch: app_verified currently attests coordinates only. Until the
    // backend can mint app_content_verified for the full canonical card, no new proposal is usable.
    if (!appContentAttestationAvailable()) return "content_attestation_unavailable";
    return undefined;
}

// Resolve the (app, action) candidates on offer in a chat: the apps enabled in the chat crossed with the
// global app directory, flattened. Groups and channels carry an admin-curated enabled set on their
// canister; direct chats fail closed until their provenance path exists. Exported so the auto-propose matcher
// (utils/autoPropose.ts) derives its trigger vocabulary from this same resolution.
export async function resolveCandidates(
    client: OpenChat,
    chatId: ChatIdentifier,
): Promise<ResolvedCandidates> {
    if (chatId.kind === "direct_chat") {
        // Direct provenance/send is explicitly unsupported by the backend. Do not offer a candidate
        // or link flow that can only fail after model work and user interaction.
        return { candidates: [], linkRequired: [], unavailable: [] };
    }
    if (chatId.kind !== "group_chat" && chatId.kind !== "channel") {
        return { candidates: [], linkRequired: [], unavailable: [] };
    }
    const enabledIds = await client.enabledAiApps(chatId);
    const boundedIds = enabledIds.slice(0, MAX_AI_ACTION_ENABLED_APPS);
    const apps = await client.aiApps(boundedIds.map((appId) => ({ appId })));
    const enabled = new Set(boundedIds);
    const enabledApps = apps
        .filter((app) => enabled.has(app.id))
        .slice(0, MAX_AI_ACTION_ENABLED_APPS);
    const unavailable: AiActionUnavailable[] = [];
    const runnableApps: AiAppRegistration[] = [];
    for (const app of enabledApps) {
        const reason = unavailableReasonForApp(app, chatId);
        if (reason === undefined) {
            runnableApps.push(app);
        } else {
            unavailable.push({ app, reason });
        }
    }

    // The user's own registered delivery keys, fetched only when an enabled app declares per-user
    // keys — apps without per_user_keys resolve exactly as before.
    const myKeys = new Map<number, string>();
    if (runnableApps.some((app) => app.manifest.perUserKeys === true)) {
        for (const key of await client.myAiAppKeys()) {
            myKeys.set(key.appId, key.publicKey);
        }
    }

    const candidates: AiActionCandidate[] = [];
    const linkRequired: AiAppRegistration[] = [];
    candidateApps: for (const app of runnableApps) {
        if (app.manifest.perUserKeys === true) {
            // Per-user delivery: the ONLY acceptable recipient is the proposing user's own key.
            const myKey = myKeys.get(app.id);
            if (myKey === undefined || myKey.length === 0) {
                if (linkRequired.length < MAX_AI_ACTION_ENABLED_APPS) linkRequired.push(app);
                continue;
            }
            for (const action of app.manifest.actions) {
                if (candidates.length >= MAX_AI_ACTION_CANDIDATES) break candidateApps;
                candidates.push({
                    app,
                    action,
                    recipientKey: myKey,
                    inboxCanisterId: app.manifest.inboxCanisterId,
                });
            }
            continue;
        }
        // Legacy single-key delivery, unchanged: the action's own key else the manifest key.
        for (const action of app.manifest.actions) {
            if (candidates.length >= MAX_AI_ACTION_CANDIDATES) break candidateApps;
            const recipientKey =
                (action.consumerPublicKey?.length ?? 0) > 0
                    ? (action.consumerPublicKey as string)
                    : app.manifest.consumerPublicKey;
            if (recipientKey.length === 0) continue;
            candidates.push({
                app,
                action,
                recipientKey,
                inboxCanisterId: app.manifest.inboxCanisterId,
            });
        }
    }
    return { candidates, linkRequired, unavailable };
}

export type AiActionPreflightBlocker = Extract<
    ProposeResult,
    { kind: "actions_unavailable" | "no_actions" }
>;

// Cheap directory-only check used before the UI asks for a model/manual extraction. It returns only
// terminal blockers; runnable or linkable candidates continue through the normal proposal flow.
export async function preflightAiActionForMessage(
    client: OpenChat,
    chatId: ChatIdentifier,
): Promise<AiActionPreflightBlocker | undefined> {
    const { candidates, linkRequired, unavailable } = await resolveCandidates(client, chatId);
    if (candidates.length > 0 || linkRequired.length > 0) return undefined;
    return unavailable.length > 0
        ? { kind: "actions_unavailable", unavailable }
        : { kind: "no_actions" };
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
// manual extraction for surfacing), 1 valid → the single-entry OBJECT card, and multiple valid entries
// fail closed until an access-controlled exact-payload hydration endpoint exists.
export function buildManualCard(
    def: AiActionDefinition,
    manualExtraction: ManualExtraction,
    recipientKey: string,
    inboxCanisterId?: string,
    additionalRecipientKeys?: string[],
    // The owning app id, baked onto the built card so the recipient binds the surface to this app.
    appId?: number,
    appRevision?: bigint,
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
            appRevision,
        );
        return { kind: "ready", card, extracted: valid[0] };
    }
    return {
        kind: "error",
        error: "Multiple action entries require an access-controlled exact-payload endpoint before a card can be posted.",
    };
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
    appRevision?: bigint,
): Promise<ProposeResult> {
    if (manualExtraction !== undefined) {
        return buildManualCard(
            def,
            manualExtraction,
            recipientKey,
            inboxCanisterId,
            additionalRecipientKeys,
            appId,
            appRevision,
        );
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

    return runAiAction(
        def,
        input,
        recipientKey,
        inferOnDevice,
        inboxCanisterId,
        additionalRecipientKeys,
        appId,
        appRevision,
    );
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
    const { candidates, linkRequired, unavailable } = await resolveCandidates(client, chatId);
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
            c.app.updated,
        );
    }
    if (candidates.length > 1) {
        return { kind: "choose", candidates };
    }
    if (linkRequired.length > 0) {
        return { kind: "link_required", app: linkRequired[0] };
    }
    if (unavailable.length > 0) {
        return { kind: "actions_unavailable", unavailable };
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
    if (result.kind === "ready_multi") {
        return {
            kind: "error",
            error: "Multiple action entries require an access-controlled exact-payload endpoint before a card can be posted.",
        };
    }
    try {
        const appId = result.card.appId;
        const appRevision = result.card.appRevision;
        if (appId === undefined || appRevision === undefined) {
            return { kind: "error", error: "could not prove the card's app provenance" };
        }
        const messageId = random64();
        const exactContent: AiAppCardContentV1 = {
            title: result.card.title,
            rows: result.card.rows.map((row) => ({ label: row.label, value: row.value })),
            confirmLabel: result.card.confirmLabel,
            cancelLabel: result.card.cancelLabel,
            actionId: result.card.actionId,
            disclosure: result.card.disclosure,
            expiresAt: result.card.expiresAt,
            confirmPayload: result.card.confirmPayload?.slice(),
        };
        const provenance = await client.createAiAppCardProvenance(
            appId,
            appRevision,
            result.card.actionId,
            exactContent,
            messageContext.chatId,
            messageId,
            messageContext.threadRootMessageIndex,
        );
        if (provenance === undefined || provenance.expiresAt <= BigInt(Date.now())) {
            return {
                kind: "error",
                error: "the app is unavailable or the card could not be verified",
            };
        }
        const vouchedCard = { ...result.card, appProvenance: provenance.provenance };
        // NB: this does NOT throw on failure — it RESOLVES with a failure response (e.g. the chat is
        // missing from the store, or the send is throttled), which is the other half of why a failed
        // propose was completely silent. Inspect the response, don't just await it.
        const res = await client.sendMessageWithContent(
            messageContext,
            vouchedCard,
            false,
            [],
            false,
            messageId,
        );
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
    const unavailableReason = unavailableReasonForApp(candidate.app, messageContext.chatId);
    if (unavailableReason !== undefined) {
        return {
            kind: "actions_unavailable",
            unavailable: [{ app: candidate.app, reason: unavailableReason }],
        };
    }
    const result = await runDefinition(
        candidate.action,
        candidate.recipientKey,
        content,
        manualExtraction,
        candidate.inboxCanisterId,
        candidate.additionalRecipientKeys,
        candidate.app.id,
        candidate.app.updated,
    );
    if (result.kind === "ready" || result.kind === "ready_multi") {
        return postCard(client, messageContext, result);
    }
    return result;
}

// Every "propose can't run because there is no model" exit says this — the pre-check and the
// `unavailable` result both land here, so the user gets one answer and one place to go.
export const NO_MODEL_MESSAGE =
    "No on-device model is ready — pick one in profile → App settings → On-device models.";

/**
 * What to tell the user about a propose result, or undefined when there is nothing to say — the card
 * was posted, or a chooser/consent surface is now up and the flow continues through it.
 *
 * This mapping used to be copied into both ChatMessage trees, and copies drift: the classic tree was
 * fixed while the mobile one kept its silent exit, so proposing on mobile did nothing and said
 * nothing. One switch, reachable from a unit test, is the fix. It is EXHAUSTIVE on purpose — a new
 * ProposeResult kind fails to type as `never` below, so adding one without deciding what the user
 * hears is a COMPILE error rather than another dead button.
 */
export function proposeFailureMessage(result: ProposeResult): string | undefined {
    switch (result.kind) {
        case "ready":
        case "ready_multi":
            // The card is already in the chat, waiting to be confirmed.
            return undefined;
        case "choose":
        case "link_required":
            // Not an outcome: runProposeFlow is mid-flight and a surface is up.
            return undefined;
        case "actions_unavailable": {
            const reasons = new Set(result.unavailable.map((entry) => entry.reason));
            if (reasons.has("content_attestation_unavailable")) {
                return "New app actions are temporarily unavailable until OpenChat can verify the complete app-authored card content.";
            }
            if (reasons.has("missing_card_surface")) {
                return "This app action is unavailable because the app has no valid secure in-chat card surface.";
            }
            return "This app action is unavailable because the app has no confirmed-action inbox route.";
        }
        case "no_actions":
            // The one message here that IS a translation key — it predates the rest and exists in the
            // locale files. Callers wrap the return in i18nKey, which passes the plain-English
            // messages below through untranslated.
            return "aiApps.noneEnabled";
        case "unavailable":
            return NO_MODEL_MESSAGE;
        case "unsupported_content":
            return "This message can't be turned into an action";
        case "image_unsupported":
            return `${result.modelId ?? "This model"} doesn't support images, only text. Switch to an image-capable model in profile → App settings → On-device models.`;
        case "no_extraction":
            return "The model found no action in this message";
        case "error":
            return `Action failed: ${result.error}`;
        default: {
            const unhandled: never = result;
            // Unreachable while the switch above is complete; still returns a STRING so that even a
            // kind bolted on at runtime speaks rather than leaving the user staring at nothing.
            return `Action failed: ${JSON.stringify(unhandled)}`;
        }
    }
}

// Everything the propose flow needs from its host tree. Injected rather than imported so the flow is
// testable with no model, no Tauri bridge and no mounted component — that this logic was reachable
// only by clicking is precisely how the same silent-exit bug shipped twice.
export interface ProposeFlowDeps {
    // Resolve terminal availability before touching model/manual-extraction UX. In particular, the
    // temporary content-attestation kill-switch must speak before any local inference work starts.
    preflight: () => Promise<AiActionPreflightBlocker | undefined>;
    // Is an on-device model loaded and usable right now?
    canInfer: () => boolean;
    // The manual-JSON seam (a prompt behind `manualExtractEnabled`). Real users are never offered it,
    // so it answers `undefined` — which means "no extraction available", NOT "stay quiet".
    promptForExtraction: () => ManualExtraction | undefined;
    propose: (extraction?: ManualExtraction) => Promise<ProposeResult>;
    proposeCandidate: (
        candidate: AiActionCandidate,
        extraction?: ManualExtraction,
    ) => Promise<ProposeResult>;
    // Pick between several offered actions. The classic tree answers synchronously (a numbered
    // window.prompt), the mobile tree asynchronously (a sheet); undefined means the user backed out.
    chooseCandidate: (
        candidates: AiActionCandidate[],
    ) => AiActionCandidate | undefined | Promise<AiActionCandidate | undefined>;
    // Run the one-time pairing surface for a per-user-keys app; true once the key is registered.
    linkApp: (app: AiAppRegistration) => boolean | Promise<boolean>;
    toast: (message: string) => void;
}

/**
 * Propose an action for one message: decide, run, and make sure the user always hears an answer.
 *
 * Hoisted out of components/home/ChatMessage.svelte and components_mobile/home/ChatMessage.svelte,
 * which carried two hand-maintained copies of it. Each tree keeps its own surfaces (prompts vs
 * sheets) — only the DECISIONS live here.
 *
 * The rule the two copies kept breaking: every path that stops early must first say why. A dismissed
 * seam prompt is not a reason to go quiet — with no model there is nothing to propose and the user
 * needs to be told where to get one, whether that dead end is reached before proposing, after an
 * `unavailable`, or after an `unavailable` from a CHOSEN candidate (the branch the mobile tree
 * returned from in silence, leaving a user with two candidates and no model a dead button).
 */
export async function runProposeFlow(deps: ProposeFlowDeps): Promise<void> {
    const blocker = await deps.preflight();
    if (blocker !== undefined) {
        const message = proposeFailureMessage(blocker);
        if (message !== undefined) deps.toast(message);
        return;
    }

    let extraction: ManualExtraction | undefined;
    if (!deps.canInfer()) {
        extraction = deps.promptForExtraction();
        if (extraction === undefined) {
            deps.toast(NO_MODEL_MESSAGE);
            return;
        }
    }

    let result = await deps.propose(extraction);

    if (result.kind === "link_required") {
        // The pairing surface reports its own outcome, and dismissing it is a deliberate "not now" —
        // the one early exit that is honest without a toast.
        if (!(await deps.linkApp(result.app))) return;
        result = await deps.propose(extraction);
    }

    if (result.kind === "choose") {
        const candidate = await deps.chooseCandidate(result.candidates);
        // Backing out of the chooser is a choice, not a failure.
        if (candidate === undefined) return;
        result = await deps.proposeCandidate(candidate, extraction);
        if (result.kind === "unavailable") {
            const retry = deps.promptForExtraction();
            // NB: no early return when the seam gives nothing — falling through to the message below
            // IS the fix. Returning here is what left the mobile chooser path mute.
            if (retry !== undefined) {
                result = await deps.proposeCandidate(candidate, retry);
            }
        }
    } else if (result.kind === "unavailable") {
        const retry = deps.promptForExtraction();
        if (retry !== undefined) {
            result = await deps.propose(retry);
        }
    }

    const message = proposeFailureMessage(result);
    if (message !== undefined) deps.toast(message);
}
