<script lang="ts">
    import type { LocalAppAction } from "../utils/localAppCatalog";
    import { formatLocalDraftJson } from "../utils/localAppDrafts";
    import {
        editLocalAppDraftField,
        localAppDraftFields,
        localDraftNumericInput,
        type LocalAppDraftField,
        type LocalAppDraftScalar,
    } from "../utils/localAppDraftFields";

    let {
        action,
        editorJson,
        disabled = false,
        onchange,
        onblocked,
    }: {
        action: LocalAppAction;
        editorJson: string;
        disabled?: boolean;
        onchange: (nextJson: string) => void;
        onblocked: (blocked: boolean) => void;
    } = $props();

    const fields = $derived(localAppDraftFields(action, editorJson));
    let pending = $state<{ item: number; key: string; text: string; source: string }>();

    $effect(() => {
        if (pending && pending.source !== editorJson) {
            pending = undefined;
            onblocked(false);
        }
    });

    function choices(field: LocalAppDraftField): readonly LocalAppDraftScalar[] | undefined {
        return (
            field.schema.enum ??
            (field.schema.type === "boolean"
                ? [false, true]
                : field.schema.type === "null"
                  ? [null]
                  : undefined)
        );
    }

    function selection(field: LocalAppDraftField): string {
        if (!field.present) return "absent";
        const index = choices(field)?.findIndex((value) => value === field.value) ?? -1;
        return index < 0 ? "invalid" : `option-${index}`;
    }

    function inputValue(field: LocalAppDraftField, item: number): string {
        if (pending?.item === item && pending.key === field.key) return pending.text;
        if (!field.present) return "";
        return typeof field.value === "string" ? field.value : formatLocalDraftJson(field.value);
    }

    function fieldDisabled(field: LocalAppDraftField, item: number): boolean {
        return disabled || !!(pending && (pending.item !== item || pending.key !== field.key));
    }

    function change(
        field: LocalAppDraftField,
        item: number,
        value: LocalAppDraftScalar | undefined,
        text = "",
    ) {
        if (fieldDisabled(field, item)) return;
        let next: string;
        try {
            next = editLocalAppDraftField(action, editorJson, item, field.key, value);
        } catch {
            // Keep a too-large edit visible, but revoke approval synchronously. The host must block
            // review/delivery while pending; it must never send the old canonical payload instead.
            pending = { item, key: field.key, text, source: editorJson };
            onblocked(true);
            return;
        }
        pending = undefined;
        onchange(next);
        onblocked(false);
    }

    function select(field: LocalAppDraftField, item: number, value: string) {
        if (value === "absent") change(field, item, undefined);
        else if (value.startsWith("option-")) {
            const index = Number(value.slice(7));
            const options = choices(field);
            if (options && Number.isSafeInteger(index) && index >= 0 && index < options.length)
                change(field, item, options[index]);
        }
    }
</script>

<section class="draft-fields" aria-label="Edit private app draft fields">
    <h3>{action.definition.card.title}</h3>
    {#if fields}
        {#each fields.items as item, index}
            <fieldset {disabled} aria-label={`Draft fields for item ${index + 1}`}>
                <legend>{fields.items.length > 1 ? `Item ${index + 1}` : "Draft fields"}</legend>
                {#each item as field (field.key)}
                    <div class="field">
                        <label>
                            <span
                                >{field.label} <code>({field.displayKey})</code>{field.required
                                    ? " — required"
                                    : " — optional"}</span
                            >
                            {#if choices(field)}
                                <select
                                    aria-label={`Item ${index + 1} — ${field.label}`}
                                    aria-invalid={!field.valid}
                                    disabled={fieldDisabled(field, index)}
                                    value={selection(field)}
                                    onchange={(event) =>
                                        select(field, index, event.currentTarget.value)}
                                >
                                    <option value="absent"
                                        >Not supplied{field.required ? " (required)" : ""}</option
                                    >
                                    {#if selection(field) === "invalid"}<option
                                            value="invalid"
                                            disabled>Invalid supplied value</option
                                        >{/if}
                                    {#each choices(field) ?? [] as option, optionIndex}
                                        <option value={`option-${optionIndex}`}
                                            >{formatLocalDraftJson(option)}</option
                                        >
                                    {/each}
                                </select>
                            {:else if field.schema.type === "string"}
                                <textarea
                                    aria-label={`Item ${index + 1} — ${field.label}`}
                                    aria-invalid={!field.valid ||
                                        (pending?.item === index && pending.key === field.key)}
                                    autocomplete="off"
                                    spellcheck={false}
                                    disabled={fieldDisabled(field, index)}
                                    rows="2"
                                    value={inputValue(field, index)}
                                    oninput={(event) =>
                                        change(
                                            field,
                                            index,
                                            event.currentTarget.value,
                                            event.currentTarget.value,
                                        )}
                                ></textarea>
                            {:else}
                                <input
                                    type="text"
                                    inputmode="decimal"
                                    aria-label={`Item ${index + 1} — ${field.label}`}
                                    aria-invalid={!field.valid ||
                                        (pending?.item === index && pending.key === field.key)}
                                    autocomplete="off"
                                    spellcheck={false}
                                    disabled={fieldDisabled(field, index)}
                                    value={inputValue(field, index)}
                                    oninput={(event) =>
                                        change(
                                            field,
                                            index,
                                            localDraftNumericInput(event.currentTarget.value),
                                            event.currentTarget.value,
                                        )}
                                />
                            {/if}
                        </label>
                        <small class="current-value">
                            {#if pending?.item === index && pending.key === field.key}
                                This edit exceeds the draft limit. Shorten it or remove this field
                                before review.
                            {:else if field.present}
                                Supplied value: <code>{formatLocalDraftJson(field.value)}</code>
                            {:else}Not supplied.{/if}
                        </small>
                        {#if !field.valid}<small class="invalid"
                                >{field.present
                                    ? "This value does not match the app's field schema."
                                    : "A value is required."}</small
                            >{/if}
                        {#if !field.required && (field.present || (pending?.key === field.key && pending.item === index))}
                            <button
                                type="button"
                                disabled={fieldDisabled(field, index)}
                                onclick={() => change(field, index, undefined)}
                                >Remove {field.label}</button
                            >
                        {:else if !field.present && field.schema.type === "string" && !field.schema.enum}
                            <button
                                type="button"
                                disabled={fieldDisabled(field, index)}
                                onclick={() => change(field, index, "")}
                                >Set {field.label} to empty text</button
                            >
                        {/if}
                    </div>
                {/each}
            </fieldset>
        {/each}
        {#if pending}<p role="alert">
                The pending field edit cannot be reviewed or sent. Correct it first.
            </p>{/if}
        {#if !fields.valid}<p role="status">
                The current draft does not match the app's schema. Correct the fields or advanced
                JSON before review.
            </p>{/if}
        {#if fields.hasOtherFields || fields.items.every((item) => item.length === 0)}
            <p>
                Complex and additional values are preserved. Inspect the complete preview and use
                advanced JSON to edit them.
            </p>
        {/if}
    {:else}
        <p role="status">
            Field editing is unavailable for this JSON structure. Correct the complete payload in
            advanced JSON. No previous values are shown.
        </p>
    {/if}
</section>

<style>
    .draft-fields,
    fieldset,
    .field,
    label {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        min-width: 0;
    }
    fieldset {
        border: 1px solid #888;
        border-radius: 0.5rem;
        padding: 0.75rem;
        gap: 1rem;
    }
    input,
    textarea,
    select {
        width: 100%;
        min-width: 0;
        box-sizing: border-box;
        font: inherit;
        padding: 0.6rem;
        border: 1px solid #888;
        border-radius: 0.4rem;
        background: var(--bg, #fff);
        color: var(--txt, #1b1b1b);
    }
    textarea {
        resize: vertical;
    }
    small,
    code,
    label,
    p {
        overflow-wrap: anywhere;
        white-space: pre-wrap;
    }
    button {
        align-self: flex-start;
        max-width: 100%;
        overflow-wrap: anywhere;
        font: inherit;
        padding: 0.5rem 0.65rem;
        border: 1px solid #888;
        border-radius: 0.4rem;
        cursor: pointer;
    }
    code {
        font-size: 0.85em;
    }
    h3,
    p {
        margin: 0;
    }
    button:disabled {
        cursor: default;
        opacity: 0.5;
    }
    [aria-invalid="true"] {
        outline: 1px solid #b44;
    }
</style>
