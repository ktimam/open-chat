<script lang="ts">
    import type { Snippet } from "svelte";

    // Presentation only: the caller owns identity, review, approval and delivery. In particular,
    // this layout does not assert backend verification or load an app document.
    let {
        title,
        identity,
        children,
        actions,
        status = "",
        consumed = false,
        wide = false,
    }: {
        title: string;
        identity: Snippet;
        children: Snippet;
        actions?: Snippet;
        status?: string;
        consumed?: boolean;
        wide?: boolean;
    } = $props();

    // Match the PR card: a consumed card initially collapses; its header can reopen it.
    let collapsed = $state(false);
    $effect(() => {
        if (consumed) collapsed = true;
    });

    function toggleCollapsed(e: Event) {
        if (!consumed) return;
        e.stopPropagation();
        collapsed = !collapsed;
    }
</script>

<div class="action-card-layout">
    <!-- has-frame reuses only the original wider card dimension, not an iframe capability. -->
    <div class="action-card" class:collapsed class:has-frame={wide}>
        <div class="app-identity" aria-live="polite">
            {@render identity()}
        </div>
        <!-- The role and tab stop are enabled together only for a consumed card. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div
            class="header"
            class:clickable={consumed}
            role={consumed ? "button" : undefined}
            tabindex={consumed ? 0 : undefined}
            onclick={toggleCollapsed}
            onkeydown={(e) => {
                if (consumed && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    toggleCollapsed(e);
                }
            }}
        >
            <div class="sender-title">
                <span class="title">{title}</span>
            </div>
            {#if consumed}
                <div class="state state-{status}">{status}</div>
                <span class="chevron" class:collapsed>▾</span>
            {/if}
        </div>
        {#if !collapsed}
            {@render children()}
            {#if actions}
                <div class="actions">
                    {@render actions()}
                </div>
            {/if}
        {/if}
    </div>
</div>

<style lang="scss">
    @use "../styles/actionCard";

    .action-card-layout {
        display: contents;

        // Bound the shared rules to this component, including caller-owned snippet elements.
        // A normally scoped rule would not style buttons rendered by the caller's snippet.
        :global {
            @include actionCard.actionCardStyles();
            .actions:empty {
                display: none;
            }
        }
    }
</style>
