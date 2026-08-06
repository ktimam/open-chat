<script lang="ts">
    import type { AiAppSurfaceDataDisclosure } from "../../utils/aiAppSurfaces";

    interface Props {
        title: string;
        displayUrl: string;
        dataDisclosures?: AiAppSurfaceDataDisclosure[];
    }

    let { title, displayUrl, dataDisclosures = [] }: Props = $props();

    let hasOneTimeToken = $derived(dataDisclosures.includes("one_time_chat_link_token"));
    let requestLoggedDisclosures = $derived(
        dataDisclosures.filter((disclosure) => disclosure !== "one_time_chat_link_token"),
    );

    function label(disclosure: AiAppSurfaceDataDisclosure): string {
        switch (disclosure) {
            case "app_id":
                return "the registered app identifier";
            case "one_time_chat_link_token":
                return "an expiring one-time token scoped to this chat";
            case "chat_id":
                return "a stable chat identifier";
            case "direct_participant_ids":
                return "both direct-chat participant identifiers";
        }
    }
</script>

<strong>{title}</strong>
<span>Destination: <code>{displayUrl}</code></span>
{#if dataDisclosures.length > 0}
    <span>The destination URL shares:</span>
    <ul>
        {#each dataDisclosures as disclosure (disclosure)}
            <li>{label(disclosure)}</li>
        {/each}
    </ul>
    {#if requestLoggedDisclosures.length > 0}
        <span>
            The stable identifiers above can appear in the external app's request logs. OpenChat
            sends no referrer.
        </span>
    {/if}
{/if}
{#if hasOneTimeToken}
    <span>
        The token is opaque and expires shortly. The destination page, browser history, and local
        software that handles the URL can observe it. Because it is in the URL fragment, browsers do
        not send it in HTTP requests. This URL contains no raw chat or user identifiers.
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
