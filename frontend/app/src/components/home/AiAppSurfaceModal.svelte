<script lang="ts">
    // Hosts an app-declared "sheet" surface: the (already-substituted) surface URL inside an iframe
    // in a modal, with a title bar and an always-present "Open in browser" escape hatch. The escape
    // hatch is unconditional because an app that refuses framing (X-Frame-Options / frame-ancestors)
    // just renders an empty iframe — a cross-origin host cannot detect that — so the user must
    // always have a way out to the real page.
    import { i18nKey } from "@src/i18n/i18n";
    import { openSurfaceExternally } from "@utils/aiAppSurfaces";
    import type { OpenChat } from "openchat-client";
    import { getContext } from "svelte";
    import OpenInNew from "svelte-material-icons/OpenInNew.svelte";
    import Button from "../Button.svelte";
    import ButtonGroup from "../ButtonGroup.svelte";
    import ModalContent from "../ModalContent.svelte";
    import Overlay from "../Overlay.svelte";
    import Translatable from "../Translatable.svelte";

    const client = getContext<OpenChat>("client");

    interface Props {
        // Title-bar label — normally the owning app's manifest name.
        title: string;
        // The surface URL with its placeholders already substituted (see utils/aiAppSurfaces.ts).
        url: string;
        onDismiss: () => void;
    }

    let { title, url, onDismiss }: Props = $props();
</script>

<Overlay dismissible onClose={onDismiss}>
    <ModalContent closeIcon fill onClose={onDismiss}>
        {#snippet header()}
            <div class="hdr">{title}</div>
        {/snippet}
        {#snippet body()}
            <iframe {title} src={url}></iframe>
        {/snippet}
        {#snippet footer()}
            <ButtonGroup>
                <Button hollow small onClick={() => openSurfaceExternally(client, url)}>
                    <OpenInNew size="1em" color="currentColor" />
                    <Translatable resourceKey={i18nKey("aiApps.openInBrowser")} />
                </Button>
            </ButtonGroup>
        {/snippet}
    </ModalContent>
</Overlay>

<style>
    .hdr {
        font-weight: 700;
    }
    /* An iframe has no intrinsic size, so it needs an explicit tall height. */
    iframe {
        width: 100%;
        min-width: min(80vw, 640px);
        height: 60vh;
        border: none;
        border-radius: var(--rd);
        background: var(--input-bg);
    }
</style>
