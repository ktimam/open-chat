<script lang="ts">
    import type { Snippet } from "svelte";
    let {
        children,
        header,
        body,
        text,
        onclick,
        onClick,
        title,
        name,
        resourceKey,
        disabled = false,
        value = $bindable(),
        error = $bindable(),
    }: {
        children?: Snippet;
        header?: Snippet;
        body?: Snippet;
        text?: Snippet | string;
        onclick?: () => void;
        onClick?: () => void;
        title?: string;
        name?: string;
        resourceKey?: string;
        disabled?: boolean;
        value?: string;
        error?: string;
    } = $props();
    void value;
    void error;
</script>

{#if onclick || onClick}
    <button type="button" {disabled} onclick={onclick ?? onClick}>
        {title ??
            name ??
            resourceKey ??
            ""}{#if typeof text === "string"}{text}{:else}{@render text?.()}{/if}{@render children?.()}
    </button>
{:else}
    <div>
        {title ??
            name ??
            resourceKey ??
            ""}{@render header?.()}{@render body?.()}{#if typeof text === "string"}{text}{:else}{@render text?.()}{/if}{@render children?.()}
    </div>
{/if}
