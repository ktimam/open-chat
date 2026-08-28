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
    import { isDirectChatCardApp, loadDirectChatAiApps } from "@utils/aiAppDirectChat";
    import {
        bindPendingChatLinkSetup,
        createChatLinkSurfaceOpening,
        hasChatLinkSurface,
        pendingChatLinkSetupAppForChat,
        type ChatLinkSurfaceOpening,
        type PendingChatLinkSetup,
    } from "@utils/aiAppSurfaces";
    import {
        currentUserIdStore,
        type AiAppRegistration,
        type ChatIdentifier,
        type OpenChat,
    } from "@client";
    import { chatIdentifierToString, chatKeyFor } from "@shared";
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
    import PrivateMatchAutomaticNotice from "../PrivateMatchAutomaticNotice.svelte";

    const client = getContext<OpenChat>("client");

    interface Props {
        chatId: ChatIdentifier;
        chatName: string;
    }

    let { chatId, chatName }: Props = $props();

    let apps = $state<AiAppRegistration[]>([]);
    // App ids THIS user holds a per-user delivery key for (pairing) — drives Connect vs Disconnect.
    let connected = $state(new Set<number>());
    let exactAppIds = $state(new Set<number>());
    let disconnecting = $state(new Set<number>());

    // Direct app tokens/cards require a published per-user-key registration. A connected key must
    // also have resolved through the bounded exact lookup; never offer setup from a directory
    // snapshot when that authoritative lookup failed.
    let relevant = $derived(
        apps.filter(
            (app) =>
                isDirectChatCardApp(app) &&
                (!connected.has(app.id) || exactAppIds.has(app.id)),
        ),
    );

    async function load() {
        const direct = await loadDirectChatAiApps(client);
        apps = direct.apps;
        connected = new Set(direct.connectedKeys.keys());
        exactAppIds = new Set(direct.exactAppIds);
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

    let setupSurface = $state<ChatLinkSurfaceOpening | undefined>(undefined);
    let setupHandedOff = $state(false);
    let openingSetup = $state<number | undefined>(undefined);
    let openingRequest = 0;

    $effect(() => {
        const chatMarker = chatIdentifierToString(chatId);
        void chatMarker;
        return () => {
            openingRequest += 1;
            openingSetup = undefined;
            const opening = setupSurface;
            setupSurface = undefined;
            if (opening !== undefined && !setupHandedOff) {
                void client.cancelAiAppChatLinkToken(opening.chatLinkToken);
            }
            setupHandedOff = false;
        };
    });

    async function openSetup(app: AiAppRegistration) {
        if (openingSetup !== undefined || setupSurface !== undefined) return;
        const request = ++openingRequest;
        openingSetup = app.id;
        const opening = await createChatLinkSurfaceOpening(client, app, chatId, chatName);
        if (request !== openingRequest) {
            if (opening !== undefined) {
                await client.cancelAiAppChatLinkToken(opening.chatLinkToken);
            }
            return;
        }
        openingSetup = undefined;
        if (opening === undefined) {
            toastStore.showFailureToast(i18nKey("aiApps.openSetupFailed"));
            return;
        }
        setupHandedOff = false;
        setupSurface = opening;
    }

    async function dismissSetup() {
        const opening = setupSurface;
        const cancel = opening !== undefined && !setupHandedOff;
        setupSurface = undefined;
        setupHandedOff = false;
        if (cancel && opening !== undefined) {
            await client.cancelAiAppChatLinkToken(opening.chatLinkToken);
        }
    }

    // Merged Connect + Open setup, identical to AiAppsSummary: pair first if the user has no key
    // (deferring the setup surface to onLinked), otherwise open the setup surface straight away.
    let linkingApp = $state<AiAppRegistration | undefined>(undefined);
    let pendingSetup = $state<PendingChatLinkSetup | undefined>(undefined);

    $effect(() => {
        const pendingChatKey = chatKeyFor(chatId, $currentUserIdStore);
        void pendingChatKey;
        return () => {
            pendingSetup = undefined;
        };
    });

    function startConnect(app: AiAppRegistration) {
        const hasSetup = hasChatLinkSurface(app);
        const needsPairing = app.manifest.perUserKeys && !connected.has(app.id);
        if (needsPairing) {
            pendingSetup = hasSetup
                ? bindPendingChatLinkSetup(app, chatId, $currentUserIdStore)
                : undefined;
            linkingApp = app;
        } else if (hasSetup) {
            void openSetup(app);
        }
    }

    function onLinked() {
        linkingApp = undefined;
        toastStore.showSuccessToast(i18nKey("aiApps.linkComplete"));
        load();
        const app = pendingChatLinkSetupAppForChat(pendingSetup, chatId, $currentUserIdStore);
        pendingSetup = undefined;
        if (app !== undefined) void openSetup(app);
    }
</script>

{#if relevant.length > 0}
    <CollapsibleCard
        onToggle={groupAiAppsOpen.toggle}
        open={$groupAiAppsOpen}
        headerText={i18nKey("aiApps.title")}
    >
        <div class="apps">
            {#each relevant as app (app.id)}
                {@const hasSetup = hasChatLinkSurface(app)}
                {@const needsPairing = app.manifest.perUserKeys && !connected.has(app.id)}
                {@const showPrimary = needsPairing || hasSetup}
                <div class="app">
                    <div class="app-info">
                        <div class="name">{app.manifest.name}</div>
                        {#if app.manifest.description.length > 0}
                            <div class="desc">{app.manifest.description}</div>
                        {/if}
                        <PrivateMatchAutomaticNotice
                            {app}
                            {chatId}
                            available={connected.has(app.id)}
                        />
                        <div class="app-actions">
                            {#if showPrimary}
                                <!-- Merged Connect + Open setup: unpaired "Connect" pairs the key
                                     AND then opens the chat setup surface; once paired it's just
                                     "Open setup" for this chat's surface. -->
                                <Button
                                    tiny
                                    hollow
                                    loading={openingSetup === app.id}
                                    disabled={openingSetup !== undefined && openingSetup !== app.id}
                                    onClick={() => startConnect(app)}
                                >
                                    {#if needsPairing}
                                        <LinkVariant size="1em" color="currentColor" />
                                    {:else}
                                        <OpenInNew size="1em" color="currentColor" />
                                    {/if}
                                    <Translatable
                                        resourceKey={i18nKey(
                                            needsPairing ? "aiApps.connect" : "aiApps.openSetup",
                                        )}
                                    />
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
                                    onClick={() => disconnectApp(app)}
                                >
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
        display={setupSurface.surface.display}
        dataDisclosures={setupSurface.dataDisclosures}
        onConsent={() => (setupHandedOff = true)}
        onDismiss={dismissSetup}
    />
{/if}

{#if linkingApp !== undefined}
    <AiAppLinkModal
        app={linkingApp}
        onDismiss={() => {
            linkingApp = undefined;
            pendingSetup = undefined;
        }}
        {onLinked}
    />
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
