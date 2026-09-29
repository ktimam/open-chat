<script lang="ts">
    import type { Snippet } from "svelte";
    let {
        children,
        body,
        header,
        onClose,
        value = $bindable("en"),
    }: {
        children?: Snippet;
        body?: Snippet;
        header?: Snippet;
        onClose?: () => void;
        value?: string;
    } = $props();
</script>

<section data-native-sign-in-layout={value}>
    {@render header?.()}
    {@render body?.()}
    {@render children?.()}
    {#if onClose}<button type="button" onclick={onClose}>Dismiss synthetic layout</button>{/if}
</section>
