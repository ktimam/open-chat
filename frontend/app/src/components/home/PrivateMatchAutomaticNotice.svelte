<script lang="ts">
    import type { AiAppRegistration, ChatIdentifier } from "@shared";
    import { i18nKey } from "@src/i18n/i18n";
    import { hasPrivateMatchSurface } from "@utils/aiAppSurfaces";
    import {
        autoProposeMutedInChat,
        autoProposeMuteRevision,
        refreshAutoProposeConfiguration,
        revokePrivateAutoProposeRuntime,
        unmuteAutoProposeInChat,
    } from "@utils/autoPropose";
    import Button from "../Button.svelte";
    import Translatable from "../Translatable.svelte";

    interface Props {
        app: AiAppRegistration;
        chatId: ChatIdentifier;
        available: boolean;
    }

    let { app, chatId, available }: Props = $props();
    let muted = $state(false);
    let lastAvailable = $state<boolean | undefined>(undefined);
    let supported = $derived(hasPrivateMatchSurface(app));

    $effect(() => {
        void $autoProposeMuteRevision;
        muted = autoProposeMutedInChat(chatId);
        if (lastAvailable === undefined) {
            if (available) refreshAutoProposeConfiguration(chatId);
        } else if (lastAvailable !== available) {
            // A connection/enablement edge starts a fresh no-backfill generation and aborts any
            // in-flight frame before its source-release boundary.
            revokePrivateAutoProposeRuntime();
        }
        lastAvailable = available;
    });

    function unmute() {
        unmuteAutoProposeInChat(chatId);
        muted = autoProposeMutedInChat(chatId);
    }
</script>

{#if supported && muted}
    <div class="muted-warning">
        <Translatable resourceKey={i18nKey("aiApps.privateTriggers.muted")} />
        <Button tiny hollow onClick={unmute}>
            <Translatable resourceKey={i18nKey("aiApps.privateTriggers.unmute")} />
        </Button>
    </div>
{/if}

<style lang="scss">
    .muted-warning {
        display: flex;
        align-items: center;
        gap: $sp2;
        margin-top: $sp2;
        color: var(--warning);
        @include font-size(fs-70);
    }
</style>
