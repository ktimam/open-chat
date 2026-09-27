<script lang="ts">
    import type { LocalAppAction } from "../utils/localAppCatalog";
    import { localAppCardPreview } from "../utils/localAppCardPreview";

    let { action, editorJson }: { action: LocalAppAction; editorJson: string } = $props();
    const preview = $derived(localAppCardPreview(action, editorJson));
</script>

<section class="card-preview" aria-label="App-declared draft preview">
    <h3>{action.definition.card.title}</h3>
    <p>
        Labels and description supplied by the imported app. Review the complete payload and exact
        destination below before sending.
    </p>
    {#if action.definition.card.disclosure}
        <p class="disclosure">{action.definition.card.disclosure}</p>
    {/if}
    {#if preview}
        {#each preview.items as rows, index}
            <section class="item" aria-label={`Draft item ${index + 1}`}>
                {#if preview.items.length > 1}<h4>Item {index + 1}</h4>{/if}
                <dl>
                    {#each rows as row}
                        <div class="row">
                            <dt>
                                {row.label}
                                {#if row.declared}<code>({row.key})</code>{:else}<span
                                        class="additional">— additional field</span
                                    >{/if}
                            </dt>
                            <dd><pre>{row.value}</pre></dd>
                        </div>
                    {/each}
                </dl>
            </section>
        {/each}
        {#if preview.envelope.length}
            <section aria-label="Additional envelope fields">
                <h4>Additional envelope fields</h4>
                <dl>
                    {#each preview.envelope as row}
                        <div class="row">
                            <dt>{row.key}</dt>
                            <dd><pre>{row.value}</pre></dd>
                        </div>
                    {/each}
                </dl>
            </section>
        {/if}
    {:else}
        <p role="status">
            Preview unavailable: correct the complete JSON payload below to match this app's schema.
            No previous values are shown.
        </p>
    {/if}
</section>

<style>
    .card-preview,
    .item {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        min-width: 0;
    }
    .card-preview {
        border: 1px solid #888;
        border-radius: 0.5rem;
        padding: 0.75rem;
    }
    h3,
    h4,
    p,
    dl,
    dd,
    pre {
        margin: 0;
    }
    dl {
        display: grid;
        gap: 0.75rem;
    }
    .row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
        gap: 0.5rem;
    }
    dt,
    dd,
    pre,
    p {
        min-width: 0;
        overflow-wrap: anywhere;
    }
    pre,
    .disclosure {
        white-space: pre-wrap;
    }
    dt code,
    .additional {
        font-size: 0.8em;
    }
    @media (max-width: 480px) {
        .row {
            grid-template-columns: minmax(0, 1fr);
        }
    }
</style>
