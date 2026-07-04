<script lang="ts">
    // Detail modal for one published AI app (opened from its explorer card). Everything shown is
    // manifest data, and the actions are the user's OWN connection lifecycle — Connect/Reconnect
    // (delegated up so the pairing modal can replace this one) and Disconnect (removes this user's
    // delivery key; the app's registration and other users are untouched). Per-chat enablement
    // stays where it lives: each chat's Apps settings.
    import { i18nKey } from "@src/i18n/i18n";
    import { toastStore } from "@src/stores/toast";
    import {
        homeSurfaceOpening,
        openSurfaceExternally,
        type SurfaceOpening,
    } from "@utils/aiAppSurfaces";
    import { mobileWidth, type AiAppRegistration, type OpenChat } from "openchat-client";
    import { getContext } from "svelte";
    import Web from "svelte-material-icons/Web.svelte";
    import Button from "../Button.svelte";
    import ButtonGroup from "../ButtonGroup.svelte";
    import ModalContent from "../ModalContent.svelte";
    import Overlay from "../Overlay.svelte";
    import Translatable from "../Translatable.svelte";
    import AiAppIcon from "./communities/explore/AiAppIcon.svelte";

    const client = getContext<OpenChat>("client");

    interface Props {
        app: AiAppRegistration;
        connected: boolean;
        onDismiss: () => void;
        // Open the pairing (link-code) modal for this app — the caller swaps the modals.
        onConnect: () => void;
        // The user's key was removed — the caller refreshes its connected set.
        onDisconnected: () => void;
        // Embed a "sheet"-display surface (the in-window browser) — the caller swaps the modals.
        onOpenSurface: (opening: SurfaceOpening) => void;
    }

    let { app, connected, onDismiss, onConnect, onDisconnected, onOpenSurface }: Props = $props();

    // The app's own webpage, when its manifest declares a "home" surface.
    let homeSurface = $derived(homeSurfaceOpening(app));

    function openHome() {
        if (homeSurface === undefined) return;
        if (homeSurface.surface.display === "sheet") {
            onOpenSurface(homeSurface);
        } else {
            openSurfaceExternally(client, homeSurface.url);
        }
    }

    let disconnecting = $state(false);

    async function disconnect() {
        if (disconnecting) return;
        disconnecting = true;
        const ok = await client.removeMyAiAppKey(app.id);
        disconnecting = false;
        if (ok) {
            toastStore.showSuccessToast(i18nKey("aiApps.disconnected"));
            onDisconnected();
        } else {
            toastStore.showFailureToast(i18nKey("aiApps.disconnectFailed"));
        }
    }
</script>

<Overlay dismissible onClose={onDismiss}>
    <ModalContent closeIcon onClose={onDismiss}>
        {#snippet header()}
            <div class="hdr">
                <AiAppIcon iconUrl={app.manifest.iconUrl} size={"2.5rem"} />
                <span class="name">{app.manifest.name}</span>
                {#if connected}
                    <span class="connected">
                        <Translatable resourceKey={i18nKey("aiApps.connectedBadge")} />
                    </span>
                {/if}
            </div>
        {/snippet}
        {#snippet body()}
            <div class="body">
                {#if app.manifest.description.length > 0}
                    <p class="desc">{app.manifest.description}</p>
                {/if}

                {#if homeSurface !== undefined}
                    <div class="website">
                        <Button hollow small onClick={openHome}>
                            <Web size="1em" color="currentColor" />
                            <Translatable resourceKey={i18nKey("aiApps.website")} />
                        </Button>
                    </div>
                {/if}

                <div class="actions">
                    <span class="heading">
                        <Translatable resourceKey={i18nKey("aiApps.actionsHeading")} />
                    </span>
                    {#each app.manifest.actions as action (action.name)}
                        <div class="action">
                            <span class="action-name">{action.name}</span>
                            {#if action.description.length > 0}
                                <span class="desc">{action.description}</span>
                            {/if}
                        </div>
                    {/each}
                </div>

                <p class="desc">
                    <Translatable resourceKey={i18nKey("aiApps.enableHint")} />
                </p>
            </div>
        {/snippet}
        {#snippet footer()}
            <ButtonGroup>
                {#if app.manifest.perUserKeys}
                    {#if connected}
                        <Button
                            danger
                            loading={disconnecting}
                            small={!$mobileWidth}
                            tiny={$mobileWidth}
                            onClick={disconnect}>
                            <Translatable resourceKey={i18nKey("aiApps.disconnect")} />
                        </Button>
                    {/if}
                    <Button small={!$mobileWidth} tiny={$mobileWidth} onClick={onConnect}>
                        <Translatable
                            resourceKey={i18nKey(connected ? "aiApps.reconnect" : "aiApps.connect")} />
                    </Button>
                {:else}
                    <Button secondary small={!$mobileWidth} tiny={$mobileWidth} onClick={onDismiss}>
                        <Translatable resourceKey={i18nKey("close")} />
                    </Button>
                {/if}
            </ButtonGroup>
        {/snippet}
    </ModalContent>
</Overlay>

<style lang="scss">
    .hdr {
        display: flex;
        align-items: center;
        gap: $sp3;
    }
    .name {
        @include font(bold, normal, fs-120);
    }
    .connected {
        @include font(book, normal, fs-70);
        color: var(--primary);
        white-space: nowrap;
    }
    .body {
        display: flex;
        flex-direction: column;
        gap: $sp4;
        text-align: start;
    }
    .desc {
        @include font(book, normal, fs-90);
        color: var(--txt-light);
        margin: 0;
    }
    .website {
        display: flex;
    }
    .actions {
        display: flex;
        flex-direction: column;
        gap: $sp3;
    }
    .heading {
        @include font(bold, normal, fs-70);
        color: var(--txt-light);
        text-transform: uppercase;
    }
    .action {
        display: flex;
        flex-direction: column;
        gap: $sp1;
    }
    .action-name {
        @include font(bold, normal, fs-90);
    }
</style>
