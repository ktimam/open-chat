<script lang="ts">
    import { i18nKey } from "@src/i18n/i18n";
    import { toastStore } from "@src/stores/toast";
    import {
        chatLinkSurfaceOpening,
        type SurfaceOpening,
    } from "@utils/aiAppSurfaces";
    import { Body, BodySmall, CommonButton, Container, Switch } from "component-lib";
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
    import Translatable from "../../Translatable.svelte";
    import AiAppLinkSheet from "../AiAppLinkSheet.svelte";
    import AiAppSurfaceSheet from "../AiAppSurfaceSheet.svelte";
    import Separator from "../Separator.svelte";

    const client = getContext<OpenChat>("client");

    interface Props {
        chat: MultiUserChat;
    }

    let { chat }: Props = $props();

    // Phase A: the AI-app directory is group-scoped only — no channels/communities yet.
    let isMultiUser = $derived(chat.id.kind === "group_chat" || chat.id.kind === "channel");
    let myRole = $derived($selectedChatSummaryStore?.membership.role);
    // Only the group's owner or admins can enable/disable apps (the canister enforces this too).
    let canManage = $derived(!$anonUserStore && (myRole === ROLE_OWNER || myRole === ROLE_ADMIN));

    let loading = $state(true);
    let apps = $state<AiAppRegistration[]>([]);
    let enabled = $state(new Set<number>());
    let toggling = $state(new Set<number>());
    // App ids THIS user has a delivery key registered for (per-user-keys pairing) — the set the
    // per-user "Disconnect" affordance is driven by.
    let connected = $state(new Set<number>());
    let disconnecting = $state(new Set<number>());

    async function load() {
        loading = true;
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
        loading = false;
    }

    if (chat.id.kind === "group_chat" || chat.id.kind === "channel") {
        load();
    }

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
    // app; its registration and every other user are unaffected. Re-connecting is the normal
    // pairing flow (a fresh high-entropy claim token).
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

    // An app with a "chat_link" surface gets an "Open setup" affordance that opens that surface
    // for THIS chat on demand — deliberately not gated by the once-per-(app, chat) shown-marker
    // the post-confirm auto-open uses.
    let setupSurface = $state<SurfaceOpening | undefined>(undefined);

    function openSetup(opening: SurfaceOpening) {
        setupSurface = opening;
    }

    // Merge Connect + Open setup: pair first when this user has no key, then continue directly to
    // the per-chat setup surface after pairing succeeds. Reconnect remains an explicit key refresh
    // and does not reopen setup unless it came from the primary Connect action.
    let linkingApp = $state<AiAppRegistration | undefined>(undefined);
    let pendingSetup = $state<SurfaceOpening | undefined>(undefined);

    function startConnect(app: AiAppRegistration) {
        const setup = chatLinkSurfaceOpening(app, chat.id);
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
        load(); // refresh the connected set
        const setup = pendingSetup;
        pendingSetup = undefined;
        if (setup !== undefined) {
            openSetup(setup);
        }
    }
</script>

{#if isMultiUser}
    <Separator />

    <Container padding={["zero", "md"]} gap={"lg"} direction={"vertical"}>
        <Body colour={"textSecondary"} fontWeight={"bold"}>
            <Translatable resourceKey={i18nKey("aiApps.title")} />
        </Body>

        {#if loading}
            <BodySmall colour={"textSecondary"}>
                <Translatable resourceKey={i18nKey("aiApps.loading")} />
            </BodySmall>
        {:else if apps.length === 0}
            <BodySmall colour={"textSecondary"}>
                <Translatable resourceKey={i18nKey("aiApps.none")} />
            </BodySmall>
        {:else}
            {#each apps as app (app.id)}
                {@const setup = chatLinkSurfaceOpening(app, chat.id)}
                {@const needsPairing = app.manifest.perUserKeys && !connected.has(app.id)}
                {@const showPrimary = needsPairing || setup !== undefined}
                <Container
                    mainAxisAlignment={"spaceBetween"}
                    crossAxisAlignment={"center"}
                    gap={"md"}>
                    <Container direction={"vertical"} gap={"xs"}>
                        <Body fontWeight={"bold"}>{app.manifest.name}</Body>
                        {#if app.manifest.description.length > 0}
                            <BodySmall colour={"textSecondary"}>
                                {app.manifest.description}
                            </BodySmall>
                        {/if}
                        {#if showPrimary || connected.has(app.id)}
                            <!-- Plain div, not Container: the action row can hold three buttons,
                                 which overflow a non-wrapping flex row on a narrow window — this
                                 wraps them onto extra lines instead of clipping. -->
                            <div class="app-actions">
                                {#if showPrimary}
                                    <CommonButton
                                        onClick={() => startConnect(app)}
                                        size={"small_text"}>
                                        {#snippet icon(color, size)}
                                            {#if needsPairing}
                                                <LinkVariant {color} {size} />
                                            {:else}
                                                <OpenInNew {color} {size} />
                                            {/if}
                                        {/snippet}
                                        <Translatable
                                            resourceKey={i18nKey(
                                                needsPairing
                                                    ? "aiApps.connect"
                                                    : "aiApps.openSetup",
                                            )} />
                                    </CommonButton>
                                {/if}
                                {#if connected.has(app.id)}
                                    {#if app.manifest.perUserKeys}
                                        <CommonButton
                                            onClick={() => (linkingApp = app)}
                                            size={"small_text"}>
                                            {#snippet icon(color, size)}
                                                <LinkVariant {color} {size} />
                                            {/snippet}
                                            <Translatable
                                                resourceKey={i18nKey("aiApps.reconnect")} />
                                        </CommonButton>
                                    {/if}
                                    <CommonButton
                                        onClick={() => disconnectApp(app)}
                                        loading={disconnecting.has(app.id)}
                                        size={"small_text"}>
                                        {#snippet icon(color, size)}
                                            <LinkOff {color} {size} />
                                        {/snippet}
                                        <Translatable
                                            resourceKey={i18nKey("aiApps.disconnect")} />
                                    </CommonButton>
                                {/if}
                            </div>
                        {/if}
                    </Container>
                    <Switch
                        bound={false}
                        checked={enabled.has(app.id)}
                        disabled={!canManage}
                        loading={toggling.has(app.id)}
                        onChange={() => toggleApp(app)} />
                </Container>
            {/each}
        {/if}
    </Container>

    {#if setupSurface !== undefined}
        <AiAppSurfaceSheet
            title={setupSurface.app.manifest.name}
            url={setupSurface.url}
            display={setupSurface.surface.display}
            dataDisclosures={setupSurface.dataDisclosures}
            onDismiss={() => (setupSurface = undefined)} />
    {/if}

    {#if linkingApp !== undefined}
        <AiAppLinkSheet
            app={linkingApp}
            onDismiss={() => {
                linkingApp = undefined;
                pendingSetup = undefined;
            }}
            {onLinked} />
    {/if}
{/if}

<style lang="scss">
    .app-actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        column-gap: $sp4;
        row-gap: $sp2;
    }
</style>
