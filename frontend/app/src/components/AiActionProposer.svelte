<script lang="ts">
    // Trigger UI for the in-OpenChat AI-action runner. Given a message's content (image/text) and the
    // registered actions, it offers a "propose" affordance per runnable action. On click it runs the user's
    // selected ON-DEVICE model against the action's prompt, builds a confirmable ActionCard (with the
    // recipient routing baked in), and hands it to `onPropose` to post. Nothing is sent autonomously and
    // nothing is posted until the model produces a parseable result.
    import { inferOnDevice, isNativeClient } from "@utils/onDeviceInference";
    import { Button } from "component-lib";
    import {
        type ActionCardContent,
        type AiActionDefinition,
        isActionRunnable,
        runAiAction,
    } from "openchat-shared";

    interface Props {
        actions: AiActionDefinition[];
        imageBytes?: Uint8Array;
        text?: string;
        // The caller wires this to the chat's send path (apiMessageContent maps it to the canister).
        onPropose: (card: ActionCardContent) => void;
    }
    let { actions, imageBytes, text, onPropose }: Props = $props();

    const native = isNativeClient();
    let busy = $state<string | undefined>(undefined);
    let message = $state<string | undefined>(undefined);

    // Only actions that can deliver on-chain (have a recipient key) and can run on-device.
    const runnable = $derived(actions.filter((a) => isActionRunnable(a, native)));

    async function propose(action: AiActionDefinition) {
        busy = action.name;
        message = undefined;
        try {
            const result = await runAiAction(
                action,
                { image: imageBytes, text },
                action.consumerPublicKey ?? "",
                inferOnDevice,
            );
            switch (result.kind) {
                case "ready":
                    onPropose(result.card);
                    break;
                case "unavailable":
                    message = `On-device model unavailable: ${result.reason}`;
                    break;
                case "no_extraction":
                    message = "The model couldn't find a matching action in this message.";
                    break;
                case "error":
                    message = `Inference failed: ${result.error}`;
                    break;
            }
        } finally {
            busy = undefined;
        }
    }
</script>

{#if runnable.length > 0}
    <div class="ai-action-proposer">
        {#each runnable as action (action.name)}
            <Button secondary disabled={busy !== undefined} onClick={() => propose(action)}>
                {busy === action.name ? "…" : `✨ ${action.card.title}`}
            </Button>
        {/each}
        {#if message !== undefined}
            <span class="message">{message}</span>
        {/if}
    </div>
{/if}

<style lang="scss">
    .ai-action-proposer {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        margin-top: 8px;
    }

    .message {
        font-size: 0.85em;
        opacity: 0.7;
    }
</style>
