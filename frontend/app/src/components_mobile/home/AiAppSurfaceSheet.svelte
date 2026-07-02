<script lang="ts">
    // Hosts an app-declared "sheet" surface: the (already-substituted) surface URL inside an
    // iframe in a bottom sheet, with a title bar + close and an always-present "Open in browser"
    // escape hatch. The escape hatch is unconditional because an app that refuses framing
    // (X-Frame-Options / frame-ancestors) just renders an empty iframe — a cross-origin host
    // cannot detect that — so the user must always have a way out to the real page.
    import { i18nKey } from "@src/i18n/i18n";
    import { openSurfaceExternally } from "@utils/aiAppSurfaces";
    import { CommonButton, Container, Sheet, Title } from "component-lib";
    import type { OpenChat } from "openchat-client";
    import { getContext } from "svelte";
    import Close from "svelte-material-icons/Close.svelte";
    import OpenInNew from "svelte-material-icons/OpenInNew.svelte";
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

        <iframe {title} src={url}></iframe>

        <Container mainAxisAlignment={"center"} crossAxisAlignment={"center"}>
            <CommonButton onClick={() => openSurfaceExternally(client, url)} size={"small_text"}>
                {#snippet icon(color, size)}
                    <OpenInNew {color} {size} />
                {/snippet}
                <Translatable resourceKey={i18nKey("aiApps.openInBrowser")} />
            </CommonButton>
        </Container>
    </Container>
</Sheet>

<style>
    /* An iframe has no intrinsic size, so the content-sized sheet needs an explicit tall height;
       SheetBehavior caps the sheet as a whole at 80% of the visual viewport. */
    iframe {
        width: 100%;
        height: 60vh;
        border: none;
        border-radius: var(--rad-md);
        background: var(--background-1);
    }
</style>
