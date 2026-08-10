<script lang="ts">
    import { currentUserIdStore } from "@client";
    import type { AiAppRegistration, ChatIdentifier } from "@shared";
    import { i18nKey } from "@src/i18n/i18n";
    import {
        privateMatchConsentEnabled,
        privateMatchConsentMarker,
        setPrivateMatchConsent,
    } from "@utils/privateMatchConsent";
    import { hasPrivateMatchSurface } from "@utils/aiAppSurfaces";
    import { supportsCredentiallessIframe } from "@utils/privateMatchSurface";
    import {
        autoProposeMutedInChat,
        autoProposeMuteRevision,
        refreshAutoProposeConfiguration,
        revokePrivateAutoProposeRuntime,
        unmuteAutoProposeInChat,
    } from "@utils/autoPropose";
    import Button from "../Button.svelte";
    import Toggle from "../Toggle.svelte";
    import Translatable from "../Translatable.svelte";

    interface Props {
        app: AiAppRegistration;
        chatId: ChatIdentifier;
        available: boolean;
    }

    let { app, chatId, available }: Props = $props();
    let checked = $state(false);
    let muted = $state(false);
    let supported = $derived(hasPrivateMatchSurface(app));
    let runtimeSupported = $derived(supportsCredentiallessIframe());
    let lastAvailable = false;
    let binding = $derived(privateMatchConsentMarker(app, chatId, $currentUserIdStore));

    $effect(() => {
        void binding;
        void $autoProposeMuteRevision;
        checked = privateMatchConsentEnabled(app, chatId, $currentUserIdStore);
        muted = autoProposeMutedInChat(chatId);
        if (lastAvailable && !available) {
            revokePrivateAutoProposeRuntime();
        } else if (available && !lastAvailable) {
            if (checked) revokePrivateAutoProposeRuntime();
            else refreshAutoProposeConfiguration(chatId);
        }
        lastAvailable = available;
    });

    function toggle() {
        if (!available || !runtimeSupported) return;
        const requested = !checked;
        // Both directions establish a new privacy boundary before durable state changes. Enabling
        // must not let an evaluation which began while consent was off disclose its older text.
        revokePrivateAutoProposeRuntime();
        setPrivateMatchConsent(app, chatId, requested, $currentUserIdStore);
        checked = privateMatchConsentEnabled(app, chatId, $currentUserIdStore);
    }

    function unmute() {
        unmuteAutoProposeInChat(chatId);
        muted = autoProposeMutedInChat(chatId);
    }
</script>

{#if supported}
    <div class="private-match-consent">
        <Toggle
            id={`ai-app-private-match-${app.id}`}
            small
            bottomMargin={false}
            disabled={!available || !runtimeSupported}
            label={i18nKey("aiApps.privateTriggers.label")}
            {checked}
            onChange={toggle}
        />
        <div class="description" class:disabled={!available || !runtimeSupported}>
            <Translatable
                resourceKey={i18nKey(
                    !runtimeSupported
                        ? "aiApps.privateTriggers.unsupported"
                        : available
                        ? chatId.kind === "direct_chat"
                            ? "aiApps.privateTriggers.descriptionDirect"
                            : "aiApps.privateTriggers.descriptionGroup"
                        : chatId.kind === "direct_chat"
                          ? "aiApps.privateTriggers.connectFirstDirect"
                          : "aiApps.privateTriggers.connectFirstGroup",
                )}
            />
        </div>
        {#if muted}
            <div class="muted-warning">
                <Translatable resourceKey={i18nKey("aiApps.privateTriggers.muted")} />
                <Button tiny hollow onClick={unmute}>
                    <Translatable resourceKey={i18nKey("aiApps.privateTriggers.unmute")} />
                </Button>
            </div>
        {/if}
    </div>
{/if}

<style lang="scss">
    .private-match-consent {
        display: flex;
        flex-direction: column;
        gap: $sp1;
        margin-top: $sp2;
        max-width: 34rem;
    }
    .description {
        @include font-size(fs-70);
        color: var(--txt-light);
        padding-left: calc(40px + $sp3);
        &.disabled {
            color: var(--disabledTxt);
        }
    }
    .muted-warning {
        display: flex;
        align-items: center;
        gap: $sp2;
        padding-left: calc(40px + $sp3);
        color: var(--warning);
        @include font-size(fs-70);
    }
</style>
