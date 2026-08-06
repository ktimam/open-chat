<script lang="ts">
    // Hosts an app-declared "sheet" surface: the (already-substituted) surface URL inside an iframe
    // in a modal, with a title bar and an always-present "Open in browser" escape hatch. The escape
    // hatch is unconditional because an app that refuses framing (X-Frame-Options / frame-ancestors)
    // just renders an empty iframe — a cross-origin host cannot detect that — so the user must
    // always have a way out to the real page.
    import { i18nKey } from "@src/i18n/i18n";
    import {
        openSurfaceExternally,
        redactedAiAppSurfaceDisplayUrl,
        type AiAppSurfaceDataDisclosure,
    } from "@utils/aiAppSurfaces";
    import { normalizeAiAppSurfaceUrl } from "@utils/cardBridge";
    import type { OpenChat } from "@client";
    import { getContext } from "svelte";
    import OpenInNew from "svelte-material-icons/OpenInNew.svelte";
    import Button from "../Button.svelte";
    import ButtonGroup from "../ButtonGroup.svelte";
    import ModalContent from "../ModalContent.svelte";
    import Overlay from "../Overlay.svelte";
    import Translatable from "../Translatable.svelte";
    import AiAppSurfaceDestination from "./AiAppSurfaceDestination.svelte";
    import HardenedAiAppSurface from "./HardenedAiAppSurface.svelte";

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

<Overlay dismissible onClose={onDismiss}>
    <ModalContent closeIcon fill onClose={onDismiss}>
        {#snippet header()}
            <div class="hdr">{title}</div>
        {/snippet}
        {#snippet body()}
            {#if display === "sheet"}
                <HardenedAiAppSurface {title} {url} {dataDisclosures} {onConsent} />
            {:else if normalizedUrl !== undefined}
                <div class="external-prompt">
                    <AiAppSurfaceDestination {title} {displayUrl} {dataDisclosures} />
                    <span>
                        Opening hands the full destination URL to your browser. No navigation occurs
                        until you choose Open.
                    </span>
                </div>
            {:else}
                <div class="blocked" role="alert">This external app URL is not allowed.</div>
            {/if}
        {/snippet}
        {#snippet footer()}
            <div class="footer">
                {#if display === "sheet" && normalizedUrl !== undefined}
                    <span class="destination">Browser destination: <code>{displayUrl}</code></span>
                {/if}
                <ButtonGroup>
                    {#if display === "external"}
                        <Button hollow small onClick={onDismiss}>Not now</Button>
                    {/if}
                    <Button
                        hollow
                        small
                        disabled={normalizedUrl === undefined}
                        onClick={openBrowser}
                    >
                        <OpenInNew size="1em" color="currentColor" />
                        <Translatable resourceKey={i18nKey("aiApps.openInBrowser")} />
                    </Button>
                </ButtonGroup>
            </div>
        {/snippet}
    </ModalContent>
</Overlay>

<style>
    .hdr {
        font-weight: 700;
    }

    .external-prompt,
    .blocked,
    .footer {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: var(--pad-sm);
    }

    .external-prompt,
    .blocked {
        padding: var(--pad-md);
        border: var(--bw) solid var(--bd);
        border-radius: var(--rd);
    }

    .destination {
        overflow-wrap: anywhere;
        text-align: start;
    }
</style>
