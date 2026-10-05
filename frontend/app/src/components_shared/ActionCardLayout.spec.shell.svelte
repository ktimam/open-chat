<script lang="ts">
    import type { Writable } from "svelte/store";
    import ActionCardLayout from "./ActionCardLayout.svelte";

    let {
        view,
        onConfirm,
        onCancel,
        onOuterClick,
        onOuterKey,
    }: {
        view: Writable<{
            title: string;
            appName: string;
            appId: string;
            status?: string;
            consumed?: boolean;
            wide?: boolean;
            showActions?: boolean;
            disabled?: boolean;
        }>;
        onConfirm: () => void;
        onCancel: () => void;
        onOuterClick: () => void;
        onOuterKey: () => void;
    } = $props();
</script>

{#snippet identity()}
    <div class="app-identity-text">
        <span class="app-name">{$view.appName}</span>
        <span class="app-id">{$view.appId}</span>
    </div>
{/snippet}

{#snippet buttons()}
    <button type="button" class="cancel" onclick={onCancel}>Cancel</button>
    <button type="button" class="confirm" disabled={$view.disabled} onclick={onConfirm}>
        Confirm
    </button>
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div onclick={onOuterClick} onkeydown={onOuterKey}>
    <ActionCardLayout
        title={$view.title}
        {identity}
        status={$view.status}
        consumed={$view.consumed}
        wide={$view.wide}
        actions={$view.showActions === false ? undefined : buttons}
    >
        <table class="rows" data-test-body>
            <tbody><tr><td class="label">Field</td><td class="value">Value</td></tr></tbody>
        </table>
    </ActionCardLayout>
</div>
