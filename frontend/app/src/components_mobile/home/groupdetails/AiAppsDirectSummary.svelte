<script lang="ts">
    // Per-DIRECT-chat AI-app affordance (mobile/v2). Same Connect / "Open setup" / Reconnect /
    // Disconnect actions as groupdetails/AiAppsSummary.svelte, WITHOUT the owner/admin enable toggle:
    // a direct chat has no admin, so enablement is implicit (your connected per-user-key apps
    // participate). Its reason to exist is the "Open setup" affordance — the manual, ungated way to
    // (re)open an app's chat_link surface for THIS chat (e.g. to link/re-link a sheet). Group chats
    // get that from AiAppsSummary; without this, a direct chat only gets the ONE post-confirm
    // auto-open. Generic — nothing app-specific.
    import { i18nKey } from "@src/i18n/i18n";
    import { toastStore } from "@src/stores/toast";
    import {
        chatLinkSurfaceOpening,
        type SurfaceOpening,
    } from "@utils/aiAppSurfaces";
    import { Body, BodySmall, CommonButton, Container } from "component-lib";
    import {
        type AiAppRegistration,
        type ChatIdentifier,
        currentUserIdStore,
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
                chatLinkSurfaceOpening(app, chatId, $currentUserIdStore) !== undefined,
        ),
    );

    async function load() {
        const [myKeys, directory] = await Promise.all([
            client.myAiAppKeys(),
            client.exploreAiApps(undefined, 0, 8),
        ]);
        const exact = await client.aiApps(
            myKeys.map((key) => ({ appId: key.appId })),
        );
        const byId = new Map(directory.matches.map((app) => [app.id, app]));
        for (const app of exact) byId.set(app.id, app);
        apps = [...byId.values()].sort((left, right) => left.id - right.id);
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
        setupSurface = opening;
    }

    let linkingApp = $state<AiAppRegistration | undefined>(undefined);
    let pendingSetup = $state<SurfaceOpening | undefined>(undefined);

    function startConnect(app: AiAppRegistration) {
        const setup = chatLinkSurfaceOpening(app, chatId, $currentUserIdStore);
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
    <Separator />

    <Container padding={["zero", "md"]} gap={"lg"} direction={"vertical"}>
        <Body colour={"textSecondary"} fontWeight={"bold"}>
            <Translatable resourceKey={i18nKey("aiApps.title")} />
        </Body>

        {#each relevant as app (app.id)}
            {@const setup = chatLinkSurfaceOpening(app, chatId, $currentUserIdStore)}
            {@const needsPairing = app.manifest.perUserKeys && !connected.has(app.id)}
            {@const showPrimary = needsPairing || setup !== undefined}
            <Container mainAxisAlignment={"spaceBetween"} crossAxisAlignment={"center"} gap={"md"}>
                <Container direction={"vertical"} gap={"xs"}>
                    <Body fontWeight={"bold"}>{app.manifest.name}</Body>
                    {#if app.manifest.description.length > 0}
                        <BodySmall colour={"textSecondary"}>
                            {app.manifest.description}
                        </BodySmall>
                    {/if}
                    <!-- Plain div, not Container: the action row can hold three buttons, which
                         overflow a non-wrapping flex row on a narrow window — this wraps them. -->
                    <div class="app-actions">
                        {#if showPrimary}
                            <CommonButton onClick={() => startConnect(app)} size={"small_text"}>
                                {#snippet icon(color, size)}
                                    {#if needsPairing}
                                        <LinkVariant {color} {size} />
                                    {:else}
                                        <OpenInNew {color} {size} />
                                    {/if}
                                {/snippet}
                                <Translatable
                                    resourceKey={i18nKey(
                                        needsPairing ? "aiApps.connect" : "aiApps.openSetup",
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
                                    <Translatable resourceKey={i18nKey("aiApps.reconnect")} />
                                </CommonButton>
                            {/if}
                            <CommonButton
                                onClick={() => disconnectApp(app)}
                                loading={disconnecting.has(app.id)}
                                size={"small_text"}>
                                {#snippet icon(color, size)}
                                    <LinkOff {color} {size} />
                                {/snippet}
                                <Translatable resourceKey={i18nKey("aiApps.disconnect")} />
                            </CommonButton>
                        {/if}
                    </div>
                </Container>
            </Container>
        {/each}
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
