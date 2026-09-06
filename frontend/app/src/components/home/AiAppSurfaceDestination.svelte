<script lang="ts">
    import {
        aiAppSurfaceDestinationOrigin,
        type AiAppSurfaceDataDisclosure,
    } from "../../utils/aiAppSurfaces";

    interface Props {
        title?: string;
        displayUrl: string;
        dataDisclosures?: AiAppSurfaceDataDisclosure[];
    }

    let { title, displayUrl, dataDisclosures = [] }: Props = $props();

    let destinationOrigin = $derived(aiAppSurfaceDestinationOrigin(displayUrl));
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
            case "chat_display_name":
                return "the chat name currently shown in OpenChat";
            case "chat_id":
                return "a stable chat identifier";
            case "direct_participant_ids":
                return "both direct-chat participant identifiers";
        }
    }
</script>

{#if title !== undefined}
    <strong>{title}</strong>
{/if}
<span>Destination: <code>{destinationOrigin}</code></span>
<details>
    <summary>Privacy details</summary>
    <div class="privacy-details">
        {#if dataDisclosures.length > 0}
            <span>Opening this setup shares:</span>
            <ul>
                {#each dataDisclosures as disclosure (disclosure)}
                    <li>{label(disclosure)}</li>
                {/each}
            </ul>
        {/if}
        {#if requestLoggedDisclosures.length > 0}
            <span>
                The non-token values above are shared with the external app only after it redeems
                the token. OpenChat sends no referrer.
            </span>
        {/if}
        {#if hasOneTimeToken}
            <span>
                The token is opaque and expires shortly. The destination page, browser history, and
                local software that handles the URL can observe it. Because it is in the URL
                fragment, browsers do not send it in HTTP requests. This URL contains no raw chat or
                user identifiers.
            </span>
        {/if}
        <span>
            Opening shares the full destination URL with your browser. Nothing opens until you
            continue.
        </span>
    </div>
</details>

<style>
    code {
        overflow-wrap: anywhere;
    }

    ul {
        margin: 0;
        padding-inline-start: 1.25rem;
    }

    details {
        width: 100%;
    }

    summary {
        cursor: pointer;
        font-weight: 600;
    }

    .privacy-details {
        display: flex;
        flex-direction: column;
        gap: var(--pad-sm);
        margin-block-start: var(--pad-sm);
    }
</style>
