<script lang="ts">
    // Per-chat AI-app settings (v1 port of components_mobile/.../groupdetails/AiAppsSummary.svelte).
    // Lists every registered AI app with: an owner/admin enable toggle for THIS chat, a per-user
    // "Connect/Reconnect/Disconnect" affordance for apps that pair per-user delivery keys, and an
    // "Open setup" shortcut for apps that declare a chat_link surface. All logic is shared through
    // the OpenChat client — this component only renders the v1 UI. Self-contained: it owns its
    // CollapsibleCard and renders nothing until it knows at least one app is registered, so instances
    // with no AI apps see no empty section in group details.
    import { i18nKey } from "@src/i18n/i18n";
    import { toastStore } from "@src/stores/toast";
    import {
        bindPendingChatLinkSetup,
        createChatLinkSurfaceOpening,
        hasChatLinkSurface,
        pendingChatLinkSetupAppForChat,
        type ChatLinkSurfaceOpening,
        type PendingChatLinkSetup,
    } from "@utils/aiAppSurfaces";
    import {
        anonUserStore,
        currentUserIdStore,
        ROLE_ADMIN,
        ROLE_OWNER,
        selectedChatSummaryStore,
        type AiAppRegistration,
        type MultiUserChat,
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
    import Toggle from "../../Toggle.svelte";
    import Translatable from "../../Translatable.svelte";
    import AiAppLinkModal from "../AiAppLinkModal.svelte";
    import AiAppSurfaceModal from "../AiAppSurfaceModal.svelte";

    const client = getContext<OpenChat>("client");

    interface Props {
        chat: MultiUserChat;
    }

    let { chat }: Props = $props();

    let myRole = $derived($selectedChatSummaryStore?.membership.role);
    // Only the group's owner or admins can enable/disable apps (the canister enforces this too).
    let canManage = $derived(!$anonUserStore && (myRole === ROLE_OWNER || myRole === ROLE_ADMIN));

    let apps = $state<AiAppRegistration[]>([]);
    let enabled = $state(new Set<number>());
    let toggling = $state(new Set<number>());
    // App ids THIS user has a delivery key registered for (per-user-keys pairing) — the set the
    // per-user "Disconnect" affordance is driven by.
    let connected = $state(new Set<number>());
    let disconnecting = $state(new Set<number>());

    async function load() {
        const [enabledIds, myKeys, directory] = await Promise.all([
            client.enabledAiApps(chat.id),
            client.myAiAppKeys(),
            client.exploreAiApps(undefined, 0, 8),
        ]);
        const relevantIds = [
            ...new Set([
                ...enabledIds,
                ...myKeys.filter((key) => key.publicKey.length > 0).map((key) => key.appId),
            ]),
        ];
        const exact = await client.aiApps(relevantIds.map((appId) => ({ appId })));
        const byId = new Map(directory.matches.map((app) => [app.id, app]));
        for (const app of exact) byId.set(app.id, app);
        apps = [...byId.values()].sort((left, right) => left.id - right.id);
        enabled = new Set(enabledIds);
        connected = new Set(myKeys.filter((k) => k.publicKey.length > 0).map((k) => k.appId));
    }

    load();

    async function toggleApp(app: AiAppRegistration) {
        if (!canManage || toggling.has(app.id)) return;
        const enable = !enabled.has(app.id);
        toggling = new Set(toggling).add(app.id);
        const success = await client.setAiAppEnabled(chat.id, app.id, enable);
        if (success) {
            const next = new Set(enabled);
            if (enable) {
                next.add(app.id);
            } else {
                next.delete(app.id);
            }
            enabled = next;
        } else {
            toastStore.showFailureToast(i18nKey("aiApps.toggleFailed"));
        }
        const done = new Set(toggling);
        done.delete(app.id);
        toggling = done;
    }

    // Per-USER disconnect: removes THIS user's own delivery key for the app (across all chats), so
    // OpenChat stops delivering their confirmed actions to it. One-sided — needs nothing from the
    // app; its registration and every other user are unaffected. Re-connecting is the normal pairing
    // flow (a fresh high-entropy claim token).
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

    // An app with a "chat_link" surface gets an "Open setup" affordance that opens that surface for
    // THIS chat on demand — deliberately not gated by the once-per-(app, chat) shown-marker the
    // post-confirm auto-open uses.
    let setupSurface = $state<ChatLinkSurfaceOpening | undefined>(undefined);
    let setupHandedOff = $state(false);
    let openingSetup = $state<number | undefined>(undefined);
    let openingRequest = 0;

    $effect(() => {
        const chatMarker = chatIdentifierToString(chat.id);
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
        const chatId = chat.id;
        openingSetup = app.id;
        const opening = await createChatLinkSurfaceOpening(client, app, chatId);
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

    // `linkingApp` drives the AiAppLinkModal (a high-entropy claim token). `pendingSetup` is the per-chat
    // setup surface to open ONCE the pairing completes — together they implement the MERGED action:
    // one "Connect" pairs the delivery key (if the user has none) and then hands them straight to the
    // chat setup surface, instead of two separate "Connect" + "Open setup" steps. Reconnect (an
    // already-linked user re-pairing after the app dropped its half) sets `linkingApp` directly with
    // no `pendingSetup`, so it just re-pairs.
    let linkingApp = $state<AiAppRegistration | undefined>(undefined);
    let pendingSetup = $state<PendingChatLinkSetup | undefined>(undefined);

    $effect(() => {
        const pendingChatKey = chatKeyFor(chat.id, $currentUserIdStore);
        void pendingChatKey;
        return () => {
            pendingSetup = undefined;
        };
    });

    // Single entry point for the merged "Connect" / "Open setup" action: pair first if needed
    // (deferring the setup surface to onLinked), otherwise open the setup surface right away.
    function startConnect(app: AiAppRegistration) {
        const hasSetup = hasChatLinkSurface(app);
        const needsPairing = app.manifest.perUserKeys && !connected.has(app.id);
        if (needsPairing) {
            pendingSetup = hasSetup
                ? bindPendingChatLinkSetup(app, chat.id, $currentUserIdStore)
                : undefined;
            linkingApp = app;
        } else if (hasSetup) {
            void openSetup(app);
        }
    }

    function onLinked() {
        linkingApp = undefined;
        toastStore.showSuccessToast(i18nKey("aiApps.linkComplete"));
        load(); // refresh the connected set
        // Merge: after pairing, continue straight to the per-chat setup surface (if the app has one).
        const app = pendingChatLinkSetupAppForChat(pendingSetup, chat.id, $currentUserIdStore);
        pendingSetup = undefined;
        if (app !== undefined) void openSetup(app);
    }
</script>

{#if apps.length > 0}
    <CollapsibleCard
        onToggle={groupAiAppsOpen.toggle}
        open={$groupAiAppsOpen}
        headerText={i18nKey("aiApps.title")}
    >
        <div class="apps">
            {#each apps as app (app.id)}
                {@const hasSetup = hasChatLinkSurface(app)}
                {@const needsPairing = app.manifest.perUserKeys && !connected.has(app.id)}
                {@const showPrimary = needsPairing || hasSetup}
                <div class="app">
                    <div class="app-info">
                        <div class="name">{app.manifest.name}</div>
                        {#if app.manifest.description.length > 0}
                            <div class="desc">{app.manifest.description}</div>
                        {/if}
                        {#if showPrimary || connected.has(app.id)}
                            <div class="app-actions">
                                {#if showPrimary}
                                    <!-- Merged Connect + Open setup: when unpaired, "Connect" pairs
                                         the delivery key AND then opens the chat setup surface; once
                                         paired it's just "Open setup" for the per-chat surface. -->
                                    <Button
                                        tiny
                                        hollow
                                        loading={openingSetup === app.id}
                                        disabled={openingSetup !== undefined &&
                                            openingSetup !== app.id}
                                        onClick={() => startConnect(app)}
                                    >
                                        {#if needsPairing}
                                            <LinkVariant size="1em" color="currentColor" />
                                        {:else}
                                            <OpenInNew size="1em" color="currentColor" />
                                        {/if}
                                        <Translatable
                                            resourceKey={i18nKey(
                                                needsPairing
                                                    ? "aiApps.connect"
                                                    : "aiApps.openSetup",
                                            )}
                                        />
                                    </Button>
                                {/if}
                                {#if connected.has(app.id)}
                                    {#if app.manifest.perUserKeys}
                                        <Button tiny hollow onClick={() => (linkingApp = app)}>
                                            <LinkVariant size="1em" color="currentColor" />
                                            <Translatable
                                                resourceKey={i18nKey("aiApps.reconnect")}
                                            />
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
                        {/if}
                    </div>
                    <Toggle
                        id={`ai-app-${app.id}`}
                        small
                        bottomMargin={false}
                        checked={enabled.has(app.id)}
                        disabled={!canManage}
                        waiting={toggling.has(app.id)}
                        onChange={() => toggleApp(app)}
                    />
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
