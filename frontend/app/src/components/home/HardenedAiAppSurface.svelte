<script lang="ts">
    import {
        isEmbeddedSurfaceConsentCurrent,
        normalizeAiAppSurfaceUrl,
        supportsCredentiallessIframe,
    } from "../../utils/cardBridge";
    import {
        redactedAiAppSurfaceDisplayUrl,
        type AiAppSurfaceDataDisclosure,
    } from "../../utils/aiAppSurfaces";
    import { onMount } from "svelte";
    import AiAppSurfaceDestination from "./AiAppSurfaceDestination.svelte";

    interface Props {
        title: string;
        url: string;
        dataDisclosures?: AiAppSurfaceDataDisclosure[];
        onConsent?: () => void;
    }

    let { title, url, dataDisclosures = [], onConsent }: Props = $props();
    let loadRequested = $state(false);
    let consentedUrl = $state<string | undefined>(undefined);
    let credentiallessSupported = $state(false);
    // Compile-time Vite mode only: URL/query/app input can never opt production into private hosts.
    let normalizedUrl = $derived(
        normalizeAiAppSurfaceUrl(url, { allowLocalDevelopment: import.meta.env.DEV }),
    );
    let displayUrl = $derived(redactedAiAppSurfaceDisplayUrl(normalizedUrl ?? "", dataDisclosures));
    let allowed = $derived(normalizedUrl !== undefined);
    let consentCurrent = $derived(
        loadRequested && isEmbeddedSurfaceConsentCurrent(consentedUrl, normalizedUrl),
    );

    function consentToLoad() {
        if (normalizedUrl === undefined) return;
        consentedUrl = normalizedUrl;
        loadRequested = true;
        onConsent?.();
    }

    onMount(() => {
        credentiallessSupported = supportsCredentiallessIframe();
    });
</script>

{#if !allowed}
    <div class="blocked" role="alert">This embedded app URL is not allowed.</div>
{:else if !credentiallessSupported}
    <div class="blocked" role="alert">
        Secure embedded loading is unavailable in this browser. Use “Open in browser” instead.
    </div>
{:else if !consentCurrent}
    <div class="load-gate">
        <AiAppSurfaceDestination {title} {displayUrl} {dataDisclosures} />
        <span>
            Loading contacts this external origin and may share your IP address. Supported embedded
            mode omits destination credentials and referrer, and runs the page in an opaque sandbox.
        </span>
        <button onclick={consentToLoad}>Load app</button>
    </div>
{:else}
    <!-- Origin inheritance is disabled: redirects (including to OpenChat itself) remain opaque and
         cannot acquire the host session/storage. credentialless and no-referrer further reduce the
         ambient authority of literal-IP and DNS-rebinding destinations after the explicit click. -->
    <iframe
        {title}
        src={normalizedUrl}
        credentialless
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
    ></iframe>
{/if}

<style>
    iframe {
        width: 100%;
        min-width: min(80vw, 640px);
        height: 60vh;
        border: none;
        border-radius: var(--rd);
        background: var(--input-bg);
    }

    .load-gate,
    .blocked {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: var(--pad-xs);
        min-height: 8rem;
        justify-content: center;
        padding: var(--pad-md);
        border: var(--bw) solid var(--bd);
        border-radius: var(--rd);
    }
</style>
