<script lang="ts">
    // Hosts an app-declared "sheet" surface: the (already-substituted) surface URL inside an
    // iframe in a bottom sheet, with a title bar + close and an always-present "Open in browser"
    // escape hatch. The escape hatch is unconditional because an app that refuses framing
    // (X-Frame-Options / frame-ancestors) just renders an empty iframe — a cross-origin host
    // cannot detect that — so the user must always have a way out to the real page.
    import { i18nKey } from "@src/i18n/i18n";
    import {
        openSurfaceExternally,
        redactedAiAppSurfaceDisplayUrl,
        type AiAppSurfaceDataDisclosure,
    } from "@utils/aiAppSurfaces";
    import { normalizeAiAppSurfaceUrl } from "@utils/cardBridge";
    import { BodySmall, CommonButton, Container, Sheet, Title } from "component-lib";
    import type { OpenChat } from "@client";
    import { getContext } from "svelte";
    import Close from "svelte-material-icons/Close.svelte";
    import OpenInNew from "svelte-material-icons/OpenInNew.svelte";
    import Translatable from "../Translatable.svelte";
    import AiAppSurfaceDestination from "../../components/home/AiAppSurfaceDestination.svelte";
    import HardenedAiAppSurface from "../../components/home/HardenedAiAppSurface.svelte";

    const client = getContext<OpenChat>("client");

    interface Props {
        // Title-bar label — normally the owning app's manifest name.
        title: string;
        // The surface URL with its placeholders already substituted (see utils/aiAppSurfaces.ts).
        url: string;
        display?: "sheet" | "external";
        dataDisclosures?: AiAppSurfaceDataDisclosure[];
        onDismiss: () => void;
        onConsent?: () => void;
    }

    let {
        title,
        url,
        display = "sheet",
        dataDisclosures = [],
        onDismiss,
        onConsent,
    }: Props = $props();
    let normalizedUrl = $derived(
        normalizeAiAppSurfaceUrl(url, { allowLocalDevelopment: import.meta.env.DEV }),
    );
    let displayUrl = $derived(redactedAiAppSurfaceDisplayUrl(normalizedUrl ?? "", dataDisclosures));

    function openBrowser() {
        if (normalizedUrl === undefined) return;
        onConsent?.();
        if (openSurfaceExternally(client, normalizedUrl) && display === "external") onDismiss();
    }
</script>

<Sheet {onDismiss}>
    <Container height={"hug"} padding={"lg"} gap={"md"} direction={"vertical"}>
        <Container mainAxisAlignment={"spaceBetween"} crossAxisAlignment={"center"} gap={"md"}>
            <Title fontWeight={"bold"}>{title}</Title>
            <CommonButton onClick={onDismiss} size={"small"}>
                {#snippet icon(color, size)}
                    <Close {color} {size} />
                {/snippet}
                <Translatable resourceKey={i18nKey("aiApps.close")} />
            </CommonButton>
        </Container>

        {#if display === "sheet"}
            <HardenedAiAppSurface {title} {url} {dataDisclosures} {onConsent} />
        {:else if normalizedUrl !== undefined}
            <div class="external-prompt">
                <AiAppSurfaceDestination {title} {displayUrl} {dataDisclosures} />
                <BodySmall>
                    Opening hands the full destination URL to your browser. No navigation occurs
                    until you choose Open.
                </BodySmall>
            </div>
        {:else}
            <BodySmall colour={"textSecondary"}>This external app URL is not allowed.</BodySmall>
        {/if}

        {#if display === "sheet" && normalizedUrl !== undefined}
            <BodySmall>Browser destination: <code>{displayUrl}</code></BodySmall>
        {/if}
        <Container mainAxisAlignment={"center"} crossAxisAlignment={"center"} gap={"md"}>
            {#if display === "external"}
                <CommonButton onClick={onDismiss} size={"small_text"}>Not now</CommonButton>
            {/if}
            <CommonButton
                onClick={openBrowser}
                disabled={normalizedUrl === undefined}
                size={"small_text"}
            >
                {#snippet icon(color, size)}
                    <OpenInNew {color} {size} />
                {/snippet}
                <Translatable resourceKey={i18nKey("aiApps.openInBrowser")} />
            </CommonButton>
        </Container>
    </Container>
</Sheet>

<style>
    .external-prompt {
        display: flex;
        flex-direction: column;
        gap: var(--pad-sm);
        padding: var(--pad-md);
        border: var(--bw) solid var(--bd);
        border-radius: var(--rd);
    }

    code {
        overflow-wrap: anywhere;
    }
</style>
