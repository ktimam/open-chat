<script lang="ts">
    import { get } from "svelte/store";
    import {
        privateAppWorkspace as workspace,
        privateAppWorkspaceState,
        type PrivateAppWorkspaceState,
    } from "../utils/privateAppWorkspace";
    import {
        localAppCardAnchorKey,
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

    const sourceKey = $derived(localAppCardAnchorKey(namespace, source));
    const state = $derived($privateAppWorkspaceState);
    const cards = $derived(
        sameScope(state) && !preparingHere(state)
            ? state.cards.filter(
                  (card) =>
                      sourceKey !== undefined &&
                      localAppCardAnchorKey(namespace, state.cardSources[card.id]) === sourceKey &&
                      !activeHere(state, card.id),
              )
            : [],
    );

    function sameScope(current: PrivateAppWorkspaceState): boolean {
        return current.account === namespace.account && current.backend === namespace.backend;
    }

    function sourceModeHere(current: PrivateAppWorkspaceState): boolean {
        return (
            sourceKey !== undefined &&
            current.cardPresentation === "source" &&
            localAppCardAnchorKey(namespace, current.presentationSource) === sourceKey
        );
    }

    function activeHere(current: PrivateAppWorkspaceState, id: string): boolean {
        return (
            current.open &&
            sourceModeHere(current) &&
            current.presentationDraftId === id &&
            current.draft?.id === id
        );
    }

    function preparingHere(current: PrivateAppWorkspaceState): boolean {
        return current.busy && current.phase !== undefined && sourceModeHere(current);
    }

    function canReopenBlocked(current: PrivateAppWorkspaceState, id: string): boolean {
        return (
            current.fieldEditBlocked &&
            !current.open &&
            sourceModeHere(current) &&
            current.presentationDraftId === id &&
            current.draft?.id === id
        );
    }

    function viewCard(id: string) {
        // Recheck current guards before changing presentation; a stale button is not authority.
        const current = get(privateAppWorkspaceState);
        if (
            !sameScope(current) ||
            current.busy ||
            current.draftLoading ||
            sourceKey === undefined ||
            !current.cards.some((card) => card.id === id) ||
            localAppCardAnchorKey(namespace, current.cardSources[id]) !== sourceKey ||
            activeHere(current, id) ||
            preparingHere(current)
        )
            return;
        if (current.fieldEditBlocked) {
            // Reopen only the retained hidden editor, without selecting/replacing its invalid text.
            if (canReopenBlocked(current, id)) workspace.open("source");
            return;
        }
        // selectCard revokes the previous card's approval and preserves blocked edits.
        workspace.open("source");
        workspace.selectCard(id);
    }
</script>

{#if cards.length > 0}
    <div class="source-card-links" aria-label="Private cards for this message">
        {#each cards as card, index (card.id)}
            <button
                type="button"
                disabled={state.busy ||
                    state.draftLoading ||
                    (state.fieldEditBlocked && !canReopenBlocked(state, card.id))}
                onclick={(event) => {
                    event.stopPropagation();
                    viewCard(card.id);
                }}>View private card{cards.length > 1 ? ` ${index + 1}` : ""}</button
            >
        {/each}
    </div>
{/if}

<style>
    .source-card-links {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        min-width: 0;
        max-width: 100%;
    }
    button {
        min-height: 44px;
        max-width: 100%;
        padding: 0.5rem 0.75rem;
        border: var(--bw, 1px) solid var(--bd, #888);
        border-radius: var(--rd, 0.5rem);
        background: var(--currentChat-msg-bg, transparent);
        color: var(--currentChat-msg-txt, var(--txt));
        font: inherit;
        cursor: pointer;
        overflow-wrap: anywhere;
    }
    button:disabled {
        opacity: 0.5;
        cursor: default;
    }
</style>
