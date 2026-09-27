<script lang="ts">
    import type { Snippet } from "svelte";
    let { children, text, onclick, onClick, title, resourceKey, disabled = false }: {
        children?: Snippet; text?: Snippet; onclick?: () => void; onClick?: () => void;
        title?: string; resourceKey?: string; disabled?: boolean;
    } = $props();
</script>

{#if onclick || onClick}
    <button type="button" {disabled} onclick={onclick ?? onClick}>
        {title ?? resourceKey ?? ""}{@render text?.()}{@render children?.()}
    </button>
{:else}
    <div>{title ?? resourceKey ?? ""}{@render text?.()}{@render children?.()}</div>
{/if}
