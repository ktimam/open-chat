<script lang="ts">
    import { onMount, type Snippet } from "svelte";

    let {
        target,
        inline = false,
        open = true,
        onClose,
        children,
    }: {
        target?: HTMLElement;
        inline?: boolean;
        open?: boolean;
        onClose: () => void;
        children: Snippet;
    } = $props();
    let placedInline = $state(false);

    // Move the one host-owned editor; never create an editor per virtualized message.
    // Losing a message anchor returns the same live controls to their hidden home.
    function place(node: HTMLElement, destination: HTMLElement | undefined) {
        const home = document.createComment("private-card-editor-home");
        node.before(home);
        function move(next: HTMLElement | undefined) {
            if (next?.isConnected && next !== node && !node.contains(next)) {
                next.appendChild(node);
                placedInline = true;
            } else {
                home.parentNode?.insertBefore(node, home.nextSibling);
                placedInline = false;
            }
        }
        move(destination);
        return {
            update: move,
            destroy() {
                node.remove();
                home.remove();
            },
        };
    }

    function dismissOutside(event: MouseEvent) {
        if (!inline && open && event.target === event.currentTarget) onClose();
    }
    function escape(event: KeyboardEvent) {
        if (open && event.key === "Escape") onClose();
    }
    function popState() {
        onClose();
    }
    onMount(() => {
        window.addEventListener("popstate", popState);
        return () => window.removeEventListener("popstate", popState);
    });
</script>

<svelte:window onkeydown={escape} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    use:place={inline ? target : undefined}
    class="card-surface"
    class:inline
    class:modal={!inline}
    hidden={!open || (inline && !placedInline)}
    onmousedown={dismissOutside}
>
    {@render children()}
</div>

<style lang="scss">
    .card-surface[hidden] {
        display: none;
    }
    .inline {
        width: min(420px, 100%);
        max-width: 100%;
        min-width: 0;
        box-sizing: border-box;
    }
    .modal {
        @include z-index("overlay");
        position: fixed;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        backdrop-filter: var(--modal-filter);
        background: rgba(0, 0, 0, 0.5);
    }
    @include mobile() {
        .inline {
            width: 100%;
        }
        .modal {
            align-items: flex-end;
        }
    }
</style>
