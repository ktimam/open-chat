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
        chatLinkSurfaceOpening,
        openSurfaceExternally,
        type SurfaceOpening,
    } from "@utils/aiAppSurfaces";
    import {
        anonUserStore,
        ROLE_ADMIN,
        ROLE_OWNER,
        selectedChatSummaryStore,
        type AiAppRegistration,
        type MultiUserChat,
        type OpenChat,
    } from "openchat-client";
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
        // All facades resolve to [] on failure, so a load error just presents as "no apps".
        const [allApps, enabledIds, myKeys] = await Promise.all([
            client.aiApps(),
            client.enabledAiApps(chat.id),
            client.myAiAppKeys(),
        ]);
        apps = allApps;
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
    // flow (a fresh 6-digit code).
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
    let setupSurface = $state<SurfaceOpening | undefined>(undefined);

    function openSetup(opening: SurfaceOpening) {
        if (opening.surface.display === "sheet") {
            setupSurface = opening;
        } else {
            openSurfaceExternally(client, opening.url);
        }
    }

    // On-demand pairing for per-user-keys apps: "Connect" when no key is registered, "Reconnect"
    // when one is. Reconnect matters when the APP side dropped its half of the pairing (e.g. the
    // user disconnected inside the app): OpenChat still holds a stale key, so the propose flow never
    // re-offers the consent sheet — this opens it explicitly, and claiming the fresh code simply
    // upserts (replaces) the key. One-sided, no disconnect required first.
    let linkingApp = $state<AiAppRegistration | undefined>(undefined);

    function onLinked() {
        linkingApp = undefined;
        toastStore.showSuccessToast(i18nKey("aiApps.linkComplete"));
        load(); // refresh the connected set
    }
</script>

{#if apps.length > 0}
    <CollapsibleCard
        onToggle={groupAiAppsOpen.toggle}
        open={$groupAiAppsOpen}
        headerText={i18nKey("aiApps.title")}>
        <div class="apps">
            {#each apps as app (app.id)}
                {@const setup = chatLinkSurfaceOpening(app, chat.id)}
                <div class="app">
                    <div class="app-info">
                        <div class="name">{app.manifest.name}</div>
                        {#if app.manifest.description.length > 0}
                            <div class="desc">{app.manifest.description}</div>
                        {/if}
                        {#if setup !== undefined || connected.has(app.id) || app.manifest.perUserKeys}
                            <div class="app-actions">
                                {#if setup !== undefined}
                                    <Button tiny hollow onClick={() => openSetup(setup)}>
                                        <OpenInNew size="1em" color="currentColor" />
                                        <Translatable resourceKey={i18nKey("aiApps.openSetup")} />
                                    </Button>
                                {/if}
                                {#if app.manifest.perUserKeys}
                                    <Button tiny hollow onClick={() => (linkingApp = app)}>
                                        <LinkVariant size="1em" color="currentColor" />
                                        <Translatable
                                            resourceKey={i18nKey(
                                                connected.has(app.id)
                                                    ? "aiApps.reconnect"
                                                    : "aiApps.connect",
                                            )} />
                                    </Button>
                                {/if}
                                {#if connected.has(app.id)}
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
                        {/if}
                    </div>
                    <Toggle
                        id={`ai-app-${app.id}`}
                        small
                        bottomMargin={false}
                        checked={enabled.has(app.id)}
                        disabled={!canManage}
                        waiting={toggling.has(app.id)}
                        onChange={() => toggleApp(app)} />
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
    <AiAppLinkModal app={linkingApp} onDismiss={() => (linkingApp = undefined)} {onLinked} />
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
