<script lang="ts">
    // One published AI app in the explorer. Everything shown is manifest data — the card is fully
    // generic. Clicking it opens the app's detail modal (connection lifecycle + full action list);
    // per-chat enablement (the actionable surface) lives in each chat's Apps settings.
    import type { AiAppRegistration } from "@client";
    import { i18nKey } from "../../../../i18n/i18n";
    import Translatable from "../../../Translatable.svelte";
    import AiAppIcon from "./AiAppIcon.svelte";

    interface Props {
        app: AiAppRegistration;
        // The signed-in user already holds a delivery key for this app (per-user-keys pairing).
        connected: boolean;
        // Opens the app's detail modal (connection lifecycle + full action list).
        onSelect: () => void;
    }

    let { app, connected, onSelect }: Props = $props();

    let actionCount = $derived(app.manifest.actions.length);
</script>

<button type="button" class="card" onclick={onSelect}>
    <AiAppIcon iconUrl={app.manifest.iconUrl} size={"3rem"} />
    <div class="details">
        <div class="title-row">
            <span class="name">{app.manifest.name}</span>
            {#if connected}
                <span class="connected">
                    <Translatable resourceKey={i18nKey("aiApps.connectedBadge")} />
                </span>
            {/if}
        </div>
        {#if app.manifest.description.length > 0}
            <span class="desc">{app.manifest.description}</span>
        {/if}
        <span class="desc">
            <Translatable
                resourceKey={i18nKey(
                    actionCount === 1 ? "aiApps.actionCountOne" : "aiApps.actionCount",
                    { count: actionCount.toString() },
                )}
            />
        </span>
    </div>
</button>

<style lang="scss">
    .card {
        display: flex;
        align-items: flex-start;
        gap: $sp4;
        width: 100%;
        padding: $sp3 0;
        background: none;
        border: none;
        text-align: start;
        cursor: pointer;
        color: inherit;

        &:hover {
            background-color: var(--chatSummary-hv);
        }
    }

    .details {
        display: flex;
        flex-direction: column;
        gap: $sp1;
        overflow: hidden;
    }

    .title-row {
        display: flex;
        align-items: center;
        gap: $sp3;
    }

    .name {
        @include font(bold, normal, fs-100);
    }

    .connected {
        @include font(book, normal, fs-70);
        color: var(--primary);
        white-space: nowrap;
    }

    .desc {
        @include font(book, normal, fs-80);
        color: var(--txt-light);
    }
</style>
