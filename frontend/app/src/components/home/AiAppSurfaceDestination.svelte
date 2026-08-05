<script lang="ts">
    import type { AiAppSurfaceDataDisclosure } from "../../utils/aiAppSurfaces";

    interface Props {
        title: string;
        normalizedUrl: string;
        dataDisclosures?: AiAppSurfaceDataDisclosure[];
    }

    let { title, normalizedUrl, dataDisclosures = [] }: Props = $props();

    function label(disclosure: AiAppSurfaceDataDisclosure): string {
        switch (disclosure) {
            case "app_id":
                return "the registered app identifier";
            case "chat_id":
                return "a stable chat identifier";
            case "direct_participant_ids":
                return "both direct-chat participant identifiers";
        }
    }
</script>

<strong>{title}</strong>
<span>Exact destination: <code>{normalizedUrl}</code></span>
{#if dataDisclosures.length > 0}
    <span>The destination URL shares:</span>
    <ul>
        {#each dataDisclosures as disclosure (disclosure)}
            <li>{label(disclosure)}</li>
        {/each}
    </ul>
    <span>
        These identifiers can appear in the external app's request logs. OpenChat sends no referrer.
    </span>
{/if}

<style>
    code {
        overflow-wrap: anywhere;
    }

    ul {
        margin: 0;
        padding-inline-start: 1.25rem;
    }
</style>
