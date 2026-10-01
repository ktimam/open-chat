<script lang="ts">
    import type { LocalAppAction } from "../utils/localAppCatalog";
    import { localAppCardPreview } from "../utils/localAppCardPreview";
    import { localAppDraftFields, localAppDraftSource } from "../utils/localAppDraftFields";
    import { formatLocalDraftJson, type LocalDraftJson } from "../utils/localAppDrafts";
    import { validateLocalAppDraftPresentation } from "../utils/localAppDraftPresentation";

    let {
        action,
        editorJson,
        additionalOnly = false,
    }: { action: LocalAppAction; editorJson: string; additionalOnly?: boolean } = $props();
    function isRecord(value: LocalDraftJson): value is { readonly [key: string]: LocalDraftJson } {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }
    const preview = $derived.by(() => {
        if (!additionalOnly) return localAppCardPreview(action, editorJson);
        try {
            // Even schema-invalid additional values must stay visible while the user repairs
            // them. This bounded structural projection never supplies a sendable payload.
            const { payload, records } = localAppDraftSource(action, editorJson);
            const rows = (record: { readonly [key: string]: LocalDraftJson }) =>
                Object.entries(record).map(([key, value]) => {
                    const declared = action.definition.card.rows.find(
                        (row) => row.valueKey === key,
                    );
                    const displayKey = formatLocalDraftJson(key).slice(1, -1);
                    return {
                        key: displayKey,
                        label: declared?.label ?? displayKey,
                        value: formatLocalDraftJson(value),
                        declared: !!declared,
                    };
                });
            return {
                items: records.map(rows),
                envelope:
                    action.handoff.kind === "wrapped-list" && isRecord(payload)
                        ? rows(payload).filter(
                              (row) =>
                                  action.handoff.kind === "wrapped-list" &&
                                  row.key !== action.handoff.field,
                          )
                        : [],
            };
        } catch {
            return undefined;
        }
    });
    const fields = $derived(localAppDraftFields(action, editorJson));
    const presentation = $derived.by(() => {
        try {
            return action.draftPresentation === undefined
                ? undefined
                : validateLocalAppDraftPresentation(
                      action.draftPresentation,
                      action.draftSchema,
                      action.handoff,
                  );
        } catch {
            return undefined;
        }
    });
    const items = $derived(
        preview?.items.map((rows, index) =>
            additionalOnly
                ? rows.filter(
                      (row) => !fields?.items[index]?.some((field) => field.displayKey === row.key),
                  )
                : rows,
        ),
    );
    const hasRows = $derived(items?.some((rows) => rows.length > 0) || !!preview?.envelope.length);

    function displayValue(key: string, value: string): string {
        let scalar: unknown;
        try {
            scalar = JSON.parse(value);
        } catch {
            return value;
        }
        const choice = action.draftEditor?.choices.find((choice) => choice.field === key);
        const label =
            choice?.options.find((option) => option.value === scalar)?.label ??
            presentation?.enumLabels
                .find((mapping) => mapping.field === key)
                ?.options.find((option) => option.value === scalar)?.label;
        return label ?? value;
    }
</script>

{#if !additionalOnly || hasRows || !preview}
    <section
        class="card-preview"
        aria-label={additionalOnly ? "Additional outgoing fields" : "App-declared draft preview"}
    >
        {#if !additionalOnly}
            <h3>{action.definition.card.title}</h3>
            <p>
                Labels and description supplied by the imported app. Review the complete payload and
                exact destination below before sending.
            </p>
            {#if action.definition.card.disclosure}
                <p class="disclosure">{action.definition.card.disclosure}</p>
            {/if}
        {:else}<h4>Additional outgoing fields</h4>{/if}
        {#if preview}
            {#each items ?? [] as rows, index}
                {#if rows.length}
                    <section class="item" aria-label={`Draft item ${index + 1}`}>
                        {#if preview.items.length > 1}<h4>Item {index + 1}</h4>{/if}
                        <dl>
                            {#each rows as row}
                                <div class="row">
                                    <dt>
                                        {action.draftEditor?.choices.find(
                                            (choice) => choice.field === row.key,
                                        )?.label ?? row.label}
                                        {#if !row.declared}<span class="additional"
                                                >— additional field</span
                                            >{/if}
                                    </dt>
                                    <dd><pre>{displayValue(row.key, row.value)}</pre></dd>
                                </div>
                            {/each}
                        </dl>
                    </section>
                {/if}
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
                Preview unavailable: correct the complete JSON payload below to match this app's
                schema. No previous values are shown.
            </p>
        {/if}
    </section>
{/if}

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
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 10rem), 1fr));
        gap: 0.75rem;
    }
    .row {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
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
    .additional {
        font-size: 0.8em;
    }
    @media (max-width: 480px) {
        .row {
            grid-template-columns: minmax(0, 1fr);
        }
    }
</style>
