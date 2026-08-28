<script lang="ts">
    import type { ActionCardContent, ChatIdentifier } from "@client";
    import type { Writable } from "svelte/store";
    import ActionCardContentView from "../src/components/home/ActionCardContent.svelte";

    interface Props {
        contentStore: Writable<ActionCardContent>;
        reconciliationStore: Writable<boolean>;
        readonly: boolean;
        chatIdStore: Writable<ChatIdentifier>;
        messageId: bigint;
        viewerId: string;
        onRespond?: (
            response: "confirm" | "cancel",
            confirmPayloadOverride?: Uint8Array,
            confirmationGrant?: Uint8Array,
        ) => boolean | Promise<boolean>;
    }

    let {
        contentStore,
        reconciliationStore,
        readonly,
        chatIdStore,
        messageId,
        viewerId,
        onRespond,
    }: Props = $props();
</script>

<ActionCardContentView
    content={$contentStore}
    reconciliationTrigger={$reconciliationStore}
    {readonly}
    chatId={$chatIdStore}
    {messageId}
    {viewerId}
    {onRespond}
/>
