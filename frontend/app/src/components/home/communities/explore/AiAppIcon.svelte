<script lang="ts">
    // Generic icon for an AI app: the manifest's iconUrl when it declares one (and the image
    // loads), otherwise a neutral fallback badge. Shared by the explorer card and the detail
    // modal so the fallback logic lives in one place (mirrors BotAvatar). Fully manifest-driven —
    // nothing app-specific here.
    import AutoFix from "svelte-material-icons/AutoFix.svelte";
    import { deriveCardOrigin } from "../../../../utils/cardBridge";

    interface Props {
        iconUrl?: string;
        // Diameter, e.g. "3rem" (card) or "2.5rem" (modal header).
        size?: string;
    }

    let { iconUrl, size = "3rem" }: Props = $props();

    // A broken / CSP-blocked image reveals the fallback badge instead of a broken-image glyph.
    let failed = $state(false);
    let remoteAllowed = $state(false);
    let safeIconUrl = $derived(
        iconUrl !== undefined &&
            deriveCardOrigin(iconUrl, { allowLocalDevelopment: import.meta.env.DEV }) !== undefined
            ? iconUrl
            : undefined,
    );
    let safeIconOrigin = $derived(
        safeIconUrl === undefined ? undefined : new URL(safeIconUrl).origin,
    );
    // Reset the failed flag when the URL changes (the same component instance is reused per app).
    $effect(() => {
        iconUrl;
        failed = false;
        remoteAllowed = false;
    });

    function allowRemoteIcon(event: MouseEvent) {
        event.stopPropagation();
        remoteAllowed = true;
    }
</script>

{#if safeIconUrl && remoteAllowed && !failed}
    <img
        class="app-icon"
        style={`width:${size};height:${size}`}
        src={safeIconUrl}
        alt=""
        crossorigin="anonymous"
        referrerpolicy="no-referrer"
        onerror={() => (failed = true)} />
{:else if safeIconUrl && !failed}
    <button
        class="badge icon-consent"
        style={`width:${size};height:${size}`}
        aria-label={`Load external app icon from ${safeIconOrigin}`}
        title={`Load external app icon from ${safeIconOrigin}`}
        onclick={allowRemoteIcon}>
        <AutoFix size={"1.5rem"} color={"var(--button-txt)"} />
    </button>
{:else}
    <div class="badge" style={`width:${size};height:${size}`}>
        <AutoFix size={"1.5rem"} color={"var(--button-txt)"} />
    </div>
{/if}

<style lang="scss">
    .app-icon {
        flex-shrink: 0;
        border-radius: 50%;
        object-fit: cover;
        background-color: var(--background-1, var(--panel-bg));
    }

    .badge {
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        border-radius: 50%;
        background-color: var(--primary);
        border: 0;
        padding: 0;
    }

    .icon-consent {
        cursor: pointer;
    }
</style>
