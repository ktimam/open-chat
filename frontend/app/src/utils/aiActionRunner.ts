// App-level orchestrator for the in-OpenChat AI-action runner.
//
// Ties together the three verified pieces: the on-chain registry (client.aiActions()), the on-device model
// (inferOnDevice), and the generic runner (runAiAction, in openchat-shared). Given a chat message's content,
// it runs the registered action on-device and returns a proposable confirm-card. The caller posts the card
// with client.sendMessageWithContent — on confirm, OpenChat encrypts confirmPayload to the action's
// recipient_public_key and deposits it into the action_inbox. Nothing here is app-specific.

import {
    isActionRunnable,
    runAiAction,
    type AiActionDefinition,
    type RunAiActionResult,
} from "openchat-shared";
import type { MessageContent, MessageContext, OpenChat } from "openchat-client";
import { inferOnDevice, isNativeClient } from "./onDeviceInference";

export type ProposeResult =
    | RunAiActionResult
    // No app has registered an AI action with a recipient key.
    | { kind: "no_actions" }
    // The message content isn't something the runner can extract from.
    | { kind: "unsupported_content" };

// Pick a registered action to run against this content. Generic: the first action that is runnable on this
// client (on-device inference available + the action declares a recipient key). A richer UI could let the
// user choose, or match on a per-action trigger.
function pickAction(actions: AiActionDefinition[]): AiActionDefinition | undefined {
    const available = isNativeClient();
    return actions.find((a) => isActionRunnable(a, available));
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

// Run the best registered action against a message's content, returning a card to propose (or a status).
export async function proposeAiActionForMessage(
    client: OpenChat,
    content: MessageContent,
): Promise<ProposeResult> {
    const actions = await client.aiActions();
    const def = pickAction(actions);
    if (def === undefined) return { kind: "no_actions" };

    const input = await contentToInput(content);
    if (input === undefined) return { kind: "unsupported_content" };

    // def.consumerPublicKey is guaranteed by isActionRunnable/pickAction.
    return runAiAction(def, input, def.consumerPublicKey as string, inferOnDevice);
}

// Convenience: run + post. Posts the proposed card into the chat (Pending) for the user to confirm.
export async function proposeAndPost(
    client: OpenChat,
    messageContext: MessageContext,
    content: MessageContent,
): Promise<ProposeResult> {
    const result = await proposeAiActionForMessage(client, content);
    if (result.kind === "ready") {
        client.sendMessageWithContent(messageContext, result.card, false, [], false);
    }
    return result;
}
