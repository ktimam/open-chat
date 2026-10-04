<script lang="ts">
    import { untrack } from "svelte";
    import {
        localAppCardAnchors,
        type LocalAppCardAnchorNamespace,
        type LocalAppCardAnchorSource,
    } from "../utils/localAppCardAnchors";

    let {
        namespace,
        source,
    }: {
        namespace: LocalAppCardAnchorNamespace;
        source: LocalAppCardAnchorSource;
    } = $props();
    let node = $state<HTMLDivElement>();

    $effect(() => {
        const capturedNamespace = { account: namespace.account, backend: namespace.backend };
        const capturedSource = { ...source };
        const capturedNode = node;
        if (capturedNode) {
            return untrack(() => {
                try {
                    return localAppCardAnchors.register(
                        capturedNamespace,
                        capturedSource,
                        capturedNode,
                    );
                } catch {
                    // An invalid/detached/capacity-limited anchor is not a card destination.
                    // Let the global host retain its fallback; never break the source message UI.
                    return undefined;
                }
            });
        }
    });
</script>

<!-- The single host editor may occupy this node; virtualizing a message only removes its anchor. -->
<div class="local-app-card-anchor" bind:this={node}></div>

<style>
    .local-app-card-anchor {
        width: 100%;
        min-width: 0;
        max-width: 100%;
    }
    .local-app-card-anchor:empty {
        display: none;
    }
</style>
