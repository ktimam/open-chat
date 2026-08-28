<script lang="ts">
    // Detail sheet for one published AI app (opened from its explorer card). Everything shown is
    // manifest data, and the actions are the user's OWN connection lifecycle — Connect/Reconnect
    // (delegated up so the pairing sheet can replace this one) and Disconnect (removes this
    // user's delivery key; the app's registration and other users are untouched). Per-chat
    // enablement stays where it lives: each chat's Apps settings.
    import { i18nKey } from "@src/i18n/i18n";
    import { toastStore } from "@src/stores/toast";
    import { homeSurfaceOpening, type SurfaceOpening } from "@utils/aiAppSurfaces";
    import { Body, BodySmall, CommonButton, Container, Sheet, Title } from "component-lib";
    import type { AiAppRegistration, OpenChat } from "@client";
    import { getContext } from "svelte";
    import LinkOff from "svelte-material-icons/LinkOff.svelte";
    import LinkVariant from "svelte-material-icons/LinkVariant.svelte";
    import Web from "svelte-material-icons/Web.svelte";
    import Translatable from "../../../Translatable.svelte";
    import AiAppIcon from "./AiAppIcon.svelte";

    const client = getContext<OpenChat>("client");

    interface Props {
        app: AiAppRegistration;
        connected: boolean;
        onDismiss: () => void;
        // Open the pairing (link-code) sheet for this app — the caller swaps the sheets.
        onConnect: () => void;
        // The user's key was removed — the caller refreshes its connected set.
        onDisconnected: () => void;
        // Embed a "sheet"-display surface (the in-window browser) — the caller swaps the sheets.
        onOpenSurface: (opening: SurfaceOpening) => void;
    }

    let { app, connected, onDismiss, onConnect, onDisconnected, onOpenSurface }: Props = $props();

    // The app's own webpage, when its manifest declares a "home" surface.
    let homeSurface = $derived(homeSurfaceOpening(app));

    function openHome() {
        if (homeSurface === undefined) return;
        onOpenSurface(homeSurface);
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

<Sheet {onDismiss}>
    <Container height={"hug"} padding={"xl"} gap={"lg"} direction={"vertical"}>
        <Container crossAxisAlignment={"center"} gap={"sm"}>
            <AiAppIcon iconUrl={app.manifest.iconUrl} size={"2.5rem"} />
            <Title fontWeight={"bold"}>{app.manifest.name}</Title>
            {#if connected}
                <BodySmall colour={"secondary"} width={"hug"}>
                    <Translatable resourceKey={i18nKey("aiApps.connectedBadge")} />
                </BodySmall>
            {/if}
        </Container>

        {#if app.manifest.description.length > 0}
            <Body colour={"textSecondary"}>{app.manifest.description}</Body>
        {/if}

        {#if homeSurface !== undefined}
            <Container mainAxisAlignment={"start"}>
                <CommonButton onClick={openHome} size={"small_text"}>
                    {#snippet icon(color, size)}
                        <Web {color} {size} />
                    {/snippet}
                    <Translatable resourceKey={i18nKey("aiApps.website")} />
                </CommonButton>
            </Container>
        {/if}

        <Container direction={"vertical"} gap={"sm"}>
            <BodySmall colour={"textSecondary"} fontWeight={"bold"}>
                <Translatable resourceKey={i18nKey("aiApps.actionsHeading")} />
            </BodySmall>
            {#each app.manifest.actions as action (action.name)}
                <Container direction={"vertical"} gap={"xs"}>
                    <Body fontWeight={"bold"}>{action.name}</Body>
                    {#if action.description.length > 0}
                        <BodySmall colour={"textSecondary"}>{action.description}</BodySmall>
                    {/if}
                </Container>
            {/each}
        </Container>

        <BodySmall colour={"textSecondary"}>
            <Translatable resourceKey={i18nKey("aiApps.enableHint")} />
        </BodySmall>

        {#if app.manifest.perUserKeys}
            <Container gap={"md"} mainAxisAlignment={"end"} crossAxisAlignment={"center"}>
                {#if connected}
                    <CommonButton onClick={disconnect} loading={disconnecting} size={"medium"}>
                        {#snippet icon(color, size)}
                            <LinkOff {color} {size} />
                        {/snippet}
                        <Translatable resourceKey={i18nKey("aiApps.disconnect")} />
                    </CommonButton>
                {/if}
                <CommonButton mode={"active"} onClick={onConnect} size={"medium"}>
                    {#snippet icon(color, size)}
                        <LinkVariant {color} {size} />
                    {/snippet}
                    <Translatable
                        resourceKey={i18nKey(connected ? "aiApps.reconnect" : "aiApps.connect")}
                    />
                </CommonButton>
            </Container>
        {/if}
    </Container>
</Sheet>
