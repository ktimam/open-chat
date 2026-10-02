<script lang="ts">
    import type { Snippet } from "svelte";
    let {
        children,
        header,
        body,
        footer,
        onClick,
        resourceKey,
        disabled = false,
    }: {
        children?: Snippet;
        header?: Snippet;
        body?: Snippet;
        footer?: Snippet;
        onClick?: () => void;
        resourceKey?: string;
        disabled?: boolean;
    } = $props();
</script>

{#if onClick}
    <button type="button" {disabled} onclick={onClick}
        >{resourceKey ?? ""}{@render children?.()}</button
    >
{:else}
    <div>
        {resourceKey ??
            ""}{@render header?.()}{@render body?.()}{@render children?.()}{@render footer?.()}
    </div>
{/if}
