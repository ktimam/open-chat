<script lang="ts">
    // The one-time consent modal for a per-user-keys AI app the user hasn't linked yet: shows a
    // 6-digit pairing code (user_index create_ai_app_link_code) which the user enters in the app;
    // the app claims it (claim_ai_app_link_code) pushing the user's public key to OpenChat. "Check
    // connection" re-queries my_ai_app_keys and, once the key appears, hands control back to the
    // caller so the propose flow that triggered the modal resumes automatically.
    import { i18nKey } from "@src/i18n/i18n";
    import { now500 } from "@src/stores/time";
    import { toastStore } from "@src/stores/toast";
    import { connectSurfaceOpening, openSurfaceExternally } from "@utils/aiAppSurfaces";
    import {
        mobileWidth,
        type AiAppLinkCode,
        type AiAppRegistration,
        type OpenChat,
    } from "openchat-client";
    import { getContext } from "svelte";
    import OpenInNew from "svelte-material-icons/OpenInNew.svelte";
    import Button from "../Button.svelte";
    import ButtonGroup from "../ButtonGroup.svelte";
    import ModalContent from "../ModalContent.svelte";
    import Overlay from "../Overlay.svelte";
    import Translatable from "../Translatable.svelte";

    const client = getContext<OpenChat>("client");

    interface Props {
        app: AiAppRegistration;
        onDismiss: () => void;
        // The app has claimed the code (the user's key is now registered) — the caller closes the
        // modal and resumes the propose that triggered it.
        onLinked: () => void;
    }

    let { app, onDismiss, onLinked }: Props = $props();

    // The app's registered "connect" surface — its pairing-code entry page. When declared, the
    // modal offers a one-tap "open the right page" shortcut.
    let connectSurface = $derived(connectSurfaceOpening(app));

    let loadingCode = $state(false);
    let codeFailed = $state(false);
    let checking = $state(false);
    let notLinkedYet = $state(false);
    let linkCode = $state<AiAppLinkCode | undefined>(undefined);

    let expired = $derived(linkCode !== undefined && $now500 >= Number(linkCode.expiresAt));
    let remaining = $derived(
        linkCode !== undefined
            ? client.durationFromMilliseconds(Math.max(0, Number(linkCode.expiresAt) - $now500))
            : undefined,
    );

    function formatRemaining(): string {
        if (remaining === undefined) return "";
        const pad = (n: number) => n.toString().padStart(2, "0");
        return `${pad(remaining.minutes)}:${pad(remaining.seconds)}`;
    }

    async function fetchCode() {
        loadingCode = true;
        codeFailed = false;
        notLinkedYet = false;
        // Creating a new code for the same (user, app) replaces the old one, so this doubles as the
        // "get a new code" action once the current one expires.
        linkCode = await client.createAiAppLinkCode(app.id);
        codeFailed = linkCode === undefined;
        loadingCode = false;
    }

    fetchCode();

    async function copyCode() {
        if (linkCode === undefined) return;
        try {
            await navigator.clipboard.writeText(linkCode.code);
            toastStore.showSuccessToast(i18nKey("aiApps.linkCodeCopied"));
        } catch {
            toastStore.showFailureToast(i18nKey("aiApps.linkCodeCopyFailed"));
        }
    }

    async function checkConnection() {
        checking = true;
        notLinkedYet = false;
        const keys = await client.myAiAppKeys();
        checking = false;
        if (keys.some((k) => k.appId === app.id && k.publicKey.length > 0)) {
            onLinked();
        } else {
            notLinkedYet = true;
        }
    }
</script>

<Overlay dismissible onClose={onDismiss}>
    <ModalContent closeIcon onClose={onDismiss}>
        {#snippet header()}
            <div class="hdr">
                <Translatable resourceKey={i18nKey("aiApps.linkTitle", { name: app.manifest.name })} />
            </div>
        {/snippet}
        {#snippet body()}
            <div class="body">
                {#if app.manifest.description.length > 0}
                    <p class="desc">{app.manifest.description}</p>
                {/if}
                <p>
                    <Translatable
                        resourceKey={i18nKey("aiApps.linkExplain", { name: app.manifest.name })} />
                </p>

                {#if linkCode !== undefined}
                    <div class="code" class:expired>
                        {#each linkCode.code as digit, i (i)}
                            <div class="digit">{digit}</div>
                        {/each}
                    </div>

                    <div class="remaining" class:expired>
                        {#if expired}
                            <Translatable resourceKey={i18nKey("aiApps.linkCodeExpired")} />
                        {:else}
                            <Translatable
                                resourceKey={i18nKey("aiApps.linkCodeExpires", {
                                    remaining: formatRemaining(),
                                })} />
                        {/if}
                    </div>

                    <ol class="steps">
                        <li><Translatable resourceKey={i18nKey("aiApps.linkStepCopy")} /></li>
                        <li>
                            {#if connectSurface !== undefined}
                                <Translatable
                                    resourceKey={i18nKey("aiApps.linkStepOpen", {
                                        name: app.manifest.name,
                                    })} />
                                <div class="inline-btn">
                                    <Button
                                        hollow
                                        small
                                        onClick={() =>
                                            openSurfaceExternally(client, connectSurface.url)}>
                                        <OpenInNew size="1em" color="currentColor" />
                                        <Translatable
                                            resourceKey={i18nKey("aiApps.linkOpenConnectPage", {
                                                name: app.manifest.name,
                                            })} />
                                    </Button>
                                </div>
                            {:else}
                                <Translatable
                                    resourceKey={i18nKey("aiApps.linkInstruction", {
                                        name: app.manifest.name,
                                    })} />
                            {/if}
                        </li>
                        <li><Translatable resourceKey={i18nKey("aiApps.linkStepPaste")} /></li>
                        <li><Translatable resourceKey={i18nKey("aiApps.linkStepCheck")} /></li>
                    </ol>

                    {#if notLinkedYet}
                        <p class="desc">
                            <Translatable
                                resourceKey={i18nKey("aiApps.linkNotYet", {
                                    name: app.manifest.name,
                                })} />
                        </p>
                    {/if}
                {:else if codeFailed}
                    <p class="desc">
                        <Translatable resourceKey={i18nKey("aiApps.linkCodeFailed")} />
                    </p>
                {/if}
            </div>
        {/snippet}
        {#snippet footer()}
            <ButtonGroup>
                {#if linkCode !== undefined && !expired}
                    <Button
                        secondary
                        small={!$mobileWidth}
                        tiny={$mobileWidth}
                        onClick={copyCode}>
                        <Translatable resourceKey={i18nKey("aiApps.linkCodeCopy")} />
                    </Button>
                {/if}
                {#if codeFailed || expired}
                    <Button
                        secondary
                        loading={loadingCode}
                        small={!$mobileWidth}
                        tiny={$mobileWidth}
                        onClick={fetchCode}>
                        <Translatable resourceKey={i18nKey("aiApps.linkNewCode")} />
                    </Button>
                {/if}
                <Button
                    loading={checking}
                    disabled={loadingCode || linkCode === undefined}
                    small={!$mobileWidth}
                    tiny={$mobileWidth}
                    onClick={checkConnection}>
                    <Translatable resourceKey={i18nKey("aiApps.checkConnection")} />
                </Button>
            </ButtonGroup>
        {/snippet}
    </ModalContent>
</Overlay>

<style>
    .hdr {
        font-weight: 700;
    }
    .body {
        display: flex;
        flex-direction: column;
        gap: 1rem;
        text-align: start;
    }
    .desc {
        color: var(--txt-light);
        margin: 0;
    }
    .steps {
        margin: 0;
        padding-inline-start: 1.25rem;
        display: flex;
        flex-direction: column;
        gap: 0.375rem;
        width: 100%;
    }
    .steps li::marker {
        color: var(--txt-light, inherit);
    }
    .inline-btn {
        margin-top: 0.25rem;
    }
    .code {
        display: flex;
        gap: 0.5rem;
        justify-content: center;
        width: 100%;
    }
    .digit {
        font-size: 2rem;
        font-weight: 700;
        line-height: 1;
        padding: 0.75rem 0.5rem;
        min-width: 2.5rem;
        text-align: center;
        border-bottom: 0.25rem solid var(--primary);
        border-radius: 0.25rem;
    }
    .code.expired .digit {
        opacity: 0.4;
    }
    .remaining {
        display: flex;
        justify-content: center;
        width: 100%;
        color: var(--warning);
    }
    .remaining.expired {
        color: var(--error);
    }
</style>
