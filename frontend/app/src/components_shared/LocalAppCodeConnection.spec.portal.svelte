<script lang="ts">
    import { onDestroy, type Snippet } from "svelte";
    let {
        children,
        onDismiss,
        onClose,
    }: {
        children?: Snippet;
        onDismiss?: () => void;
        onClose?: () => void;
    } = $props();
    // Both production portals notify dismissal during programmatic teardown:
    // Sheet.closeBeforeUnmount -> collapse and Overlay.internalClose.
    onDestroy(() => (onDismiss ?? onClose)?.());
</script>

<div>{@render children?.()}</div>
