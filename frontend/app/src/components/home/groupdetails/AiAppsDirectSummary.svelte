<script lang="ts">
    // Per-DIRECT-chat AI-app affordance. Same Connect / "Open setup" / Reconnect / Disconnect actions
    // as groupdetails/AiAppsSummary.svelte, but WITHOUT the owner/admin enable toggle: a direct chat
    // has no admin, so enablement is implicit (your connected per-user-key apps participate). Its
    // reason to exist is the "Open setup" affordance — the manual, ungated way to (re)open an app's
    // chat_link surface for THIS chat (e.g. to link/re-link a sheet). Group chats get that from
    // AiAppsSummary; without this, a direct chat only ever gets the ONE post-confirm auto-open.
    // Generic — nothing app-specific.
    import { i18nKey } from "@src/i18n/i18n";
    import { toastStore } from "@src/stores/toast";
    import {
        chatLinkSurfaceOpening,
        openSurfaceExternally,
        type SurfaceOpening,
    } from "@utils/aiAppSurfaces";
    import { type AiAppRegistration, type ChatIdentifier, type OpenChat } from "openchat-client";
    import { getContext } from "svelte";
    import LinkOff from "svelte-material-icons/LinkOff.svelte";
    import LinkVariant from "svelte-material-icons/LinkVariant.svelte";
    import OpenInNew from "svelte-material-icons/OpenInNew.svelte";
    import { groupAiAppsOpen } from "../../../stores/settings";
    import Button from "../../Button.svelte";
    import CollapsibleCard from "../../CollapsibleCard.svelte";
    import Translatable from "../../Translatable.svelte";
    import AiAppLinkModal from "../AiAppLinkModal.svelte";
    import AiAppSurfaceModal from "../AiAppSurfaceModal.svelte";

    const client = getContext<OpenChat>("client");

    interface Props {
        chatId: ChatIdentifier;
    }

    let { chatId }: Props = $props();

    let apps = $state<AiAppRegistration[]>([]);
    // App ids THIS user holds a per-user delivery key for (pairing) — drives Connect vs Disconnect.
    let connected = $state(new Set<number>());
    let disconnecting = $state(new Set<number>());

    // Only apps that mean something in a direct chat: connectable (per-user keys), offering a
    // chat_link surface, or already connected. Others have no actionable affordance here, so hide them.
    let relevant = $derived(
        apps.filter(
            (app) =>
                app.manifest.perUserKeys ||
                connected.has(app.id) ||
                chatLinkSurfaceOpening(app, chatId) !== undefined,
        ),
    );

    async function load() {
        // Both facades resolve to [] on failure, so a load error just presents as "no apps".
        const [allApps, myKeys] = await Promise.all([client.aiApps(), client.myAiAppKeys()]);
        apps = allApps;
        connected = new Set(myKeys.filter((k) => k.publicKey.length > 0).map((k) => k.appId));
    }

    load();

    // Per-USER disconnect: removes THIS user's delivery key for the app (across all chats). One-sided.
    async function disconnectApp(app: AiAppRegistration) {
        if (disconnecting.has(app.id)) return;
        disconnecting = new Set(disconnecting).add(app.id);
        const ok = await client.removeMyAiAppKey(app.id);
        if (ok) {
            const next = new Set(connected);
            next.delete(app.id);
            connected = next;
            toastStore.showSuccessToast(i18nKey("aiApps.disconnected"));
        } else {
            toastStore.showFailureToast(i18nKey("aiApps.disconnectFailed"));
        }
        const done = new Set(disconnecting);
        done.delete(app.id);
        disconnecting = done;
    }

    let setupSurface = $state<SurfaceOpening | undefined>(undefined);
    function openSetup(opening: SurfaceOpening) {
        if (opening.surface.display === "sheet") {
            setupSurface = opening;
        } else {
            openSurfaceExternally(client, opening.url);
        }
    }

    // Merged Connect + Open setup, identical to AiAppsSummary: pair first if the user has no key
    // (deferring the setup surface to onLinked), otherwise open the setup surface straight away.
    let linkingApp = $state<AiAppRegistration | undefined>(undefined);
    let pendingSetup = $state<SurfaceOpening | undefined>(undefined);

    function startConnect(app: AiAppRegistration) {
        const setup = chatLinkSurfaceOpening(app, chatId);
        const needsPairing = app.manifest.perUserKeys && !connected.has(app.id);
        if (needsPairing) {
            pendingSetup = setup;
            linkingApp = app;
        } else if (setup !== undefined) {
            openSetup(setup);
        }
    }

    function onLinked() {
        linkingApp = undefined;
        toastStore.showSuccessToast(i18nKey("aiApps.linkComplete"));
        load();
        const setup = pendingSetup;
        pendingSetup = undefined;
        if (setup !== undefined) {
            openSetup(setup);
        }
    }
</script>

{#if relevant.length > 0}
    <CollapsibleCard
        onToggle={groupAiAppsOpen.toggle}
        open={$groupAiAppsOpen}
        headerText={i18nKey("aiApps.title")}>
        <div class="apps">
            {#each relevant as app (app.id)}
                {@const setup = chatLinkSurfaceOpening(app, chatId)}
                {@const needsPairing = app.manifest.perUserKeys && !connected.has(app.id)}
                {@const showPrimary = needsPairing || setup !== undefined}
                <div class="app">
                    <div class="app-info">
                        <div class="name">{app.manifest.name}</div>
                        {#if app.manifest.description.length > 0}
                            <div class="desc">{app.manifest.description}</div>
                        {/if}
                        <div class="app-actions">
                            {#if showPrimary}
                                <!-- Merged Connect + Open setup: unpaired "Connect" pairs the key
                                     AND then opens the chat setup surface; once paired it's just
                                     "Open setup" for this chat's surface. -->
                                <Button tiny hollow onClick={() => startConnect(app)}>
                                    {#if needsPairing}
                                        <LinkVariant size="1em" color="currentColor" />
                                    {:else}
                                        <OpenInNew size="1em" color="currentColor" />
                                    {/if}
                                    <Translatable
                                        resourceKey={i18nKey(
                                            needsPairing ? "aiApps.connect" : "aiApps.openSetup",
                                        )} />
                                </Button>
                            {/if}
                            {#if connected.has(app.id)}
                                {#if app.manifest.perUserKeys}
                                    <Button tiny hollow onClick={() => (linkingApp = app)}>
                                        <LinkVariant size="1em" color="currentColor" />
                                        <Translatable resourceKey={i18nKey("aiApps.reconnect")} />
                                    </Button>
                                {/if}
                                <Button
                                    tiny
                                    hollow
                                    loading={disconnecting.has(app.id)}
                                    onClick={() => disconnectApp(app)}>
                                    <LinkOff size="1em" color="currentColor" />
                                    <Translatable resourceKey={i18nKey("aiApps.disconnect")} />
                                </Button>
                            {/if}
                        </div>
                    </div>
                </div>
            {/each}
        </div>
    </CollapsibleCard>
{/if}

{#if setupSurface !== undefined}
    <AiAppSurfaceModal
        title={setupSurface.app.manifest.name}
        url={setupSurface.url}
        onDismiss={() => (setupSurface = undefined)} />
{/if}

{#if linkingApp !== undefined}
    <AiAppLinkModal
        app={linkingApp}
        onDismiss={() => {
            linkingApp = undefined;
            pendingSetup = undefined;
        }}
        {onLinked} />
{/if}

<style lang="scss">
    /* mirrors groupdetails/AiAppsSummary.svelte */
    .apps {
        display: flex;
        flex-direction: column;
        gap: $sp3;
    }
    .app {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: $sp3;
    }
    .app-info {
        display: flex;
        flex-direction: column;
        gap: $sp2;
        min-width: 0;
    }
    .name {
        @include font(bold, normal, fs-90);
    }
    .desc {
        @include font-size(fs-80);
        color: var(--txt-light);
    }
    .app-actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: $sp2;
        margin-top: $sp2;
    }
</style>
