<script lang="ts">
    import type { Writable } from "svelte/store";
    import LocalAppCardSurface from "./LocalAppCardSurface.svelte";

    let {
        view,
        onClose,
        onEditorMount,
        onEditorDestroy,
        onEditorClick,
    }: {
        view: Writable<{
            target?: HTMLElement;
            inline: boolean;
            open: boolean;
            onClose?: () => void;
        }>;
        onClose: () => void;
        onEditorMount: (node: HTMLElement) => void;
        onEditorDestroy: () => void;
        onEditorClick: () => void;
    } = $props();
    let value = $state("Initial draft value");

    function observeEditor(node: HTMLElement) {
        onEditorMount(node);
        return { destroy: onEditorDestroy };
    }
</script>

<LocalAppCardSurface
    target={$view.target}
    inline={$view.inline}
    open={$view.open}
    onClose={$view.onClose ?? onClose}
>
    <section
        data-test-editor
        use:observeEditor
        role={$view.inline ? "region" : "dialog"}
        aria-modal={$view.inline ? undefined : true}
        tabindex="-1"
    >
        <label>Draft value <input aria-label="Draft value" bind:value /></label>
        <output aria-label="Bound draft value">{value}</output>
        <button type="button" onclick={onEditorClick}>Editor action</button>
        <button type="button" onclick={$view.onClose ?? onClose}>Close card</button>
    </section>
</LocalAppCardSurface>
