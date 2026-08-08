<script lang="ts">
    import type { ActionCardContent, ChatIdentifier } from "@client";
    import type { Writable } from "svelte/store";
    import ActionCardContentView from "../src/components/home/ActionCardContent.svelte";

    interface Props {
        contentStore: Writable<ActionCardContent>;
        readonly: boolean;
        chatId: ChatIdentifier;
        messageId: bigint;
        viewerId: string;
        onRespond?: (
            response: "confirm" | "cancel",
            confirmPayloadOverride?: Uint8Array,
            confirmationGrant?: Uint8Array,
        ) => void | Promise<unknown>;
    }

    let { contentStore, readonly, chatId, messageId, viewerId, onRespond }: Props = $props();
</script>

<ActionCardContentView
    content={$contentStore}
    {readonly}
    {chatId}
    {messageId}
    {viewerId}
    {onRespond}
/>
