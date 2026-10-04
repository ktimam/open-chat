<script lang="ts">
    import { untrack } from "svelte";
    import type { LocalAppAction } from "../utils/localAppCatalog";
    import { formatLocalDraftJson } from "../utils/localAppDrafts";
    import {
        isValidLocalDraftIsoDate,
        validateLocalAppDraftPresentation,
    } from "../utils/localAppDraftPresentation";
    import PrivateAppCardPreview from "./PrivateAppCardPreview.svelte";
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
        showTitle = true,
        compact = false,
        onchange,
        onblocked,
        onfieldedit,
        onchoiceedit,
    }: {
        action: LocalAppAction;
        editorJson: string;
        disabled?: boolean;
        showTitle?: boolean;
        compact?: boolean;
        onchange: (nextJson: string) => void;
        onblocked: (blocked: boolean) => void;
        onfieldedit?: (
            item: number,
            field: string,
            value: LocalAppDraftScalar | undefined,
        ) => string;
        onchoiceedit?: (item: number, field: string, value: string | undefined) => string;
    } = $props();

    const fields = $derived(localAppDraftFields(action, editorJson));
    const presentation = $derived.by(() => {
        if (action.draftPresentation === undefined) return undefined;
        try {
            return validateLocalAppDraftPresentation(
                action.draftPresentation,
                action.draftSchema,
                action.handoff,
            );
        } catch {
            // Imported catalogs reject this metadata. Direct callers still get inert raw values.
            return undefined;
        }
    });
    let pending = $state<{ item: number; key: string; text: string; source: string }>();
    const controlId = $props.id();
    const invalidDate = $derived(
        fields?.items.some((item) =>
            item.some(
                (field) =>
                    controlHint(field)?.kind === "date" &&
                    field.present &&
                    !isValidLocalDraftIsoDate(field.value),
            ),
        ) ?? false,
    );

    $effect(() => {
        const blocked = !!pending || invalidDate;
        // The host revokes approval by publishing workspace state. That state is not an input
        // to this field validity check and must not create a reactive invalidation loop.
        untrack(() => onblocked(blocked));
    });

    $effect(() => {
        if (pending && pending.source !== editorJson) {
            pending = undefined;
        }
    });

    function controlHint(field: LocalAppDraftField) {
        if (namedChoice(field)) return undefined;
        return presentation?.controls?.find((control) => control.field === field.key);
    }

    function dateInvalid(field: LocalAppDraftField): boolean {
        return (
            controlHint(field)?.kind === "date" &&
            field.present &&
            !isValidLocalDraftIsoDate(field.value)
        );
    }

    function dateInputType(field: LocalAppDraftField, item: number): "text" | "date" {
        // Native date controls erase invalid strings. Keep those exact edits visible instead.
        return dateInvalid(field) || (pending?.item === item && pending.key === field.key)
            ? "text"
            : "date";
    }

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

    function namedChoice(field: LocalAppDraftField) {
        return action.draftEditor?.choices.find((choice) => choice.field === field.key);
    }

    function enumLabel(field: LocalAppDraftField, value: LocalAppDraftScalar): string {
        return (
            presentation?.enumLabels
                .find((mapping) => mapping.field === field.key)
                ?.options.find((option) => option.value === value)?.label ??
            formatLocalDraftJson(value)
        );
    }

    function companionOwner(field: LocalAppDraftField) {
        return action.draftEditor?.choices.find((choice) =>
            choice.options[0]?.assign.some((assignment) => assignment.field === field.key),
        );
    }

    function fieldLabel(field: LocalAppDraftField): string {
        return namedChoice(field)?.label ?? field.label;
    }

    function namedSelection(field: LocalAppDraftField): string {
        if (!field.present) return "absent";
        const index =
            namedChoice(field)?.options.findIndex((option) => option.value === field.value) ?? -1;
        return index < 0 ? "invalid" : `option-${index}`;
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

    function fieldAction(field: LocalAppDraftField, item: number): "remove" | "empty" | undefined {
        if (companionOwner(field)) return undefined;
        if (
            !field.required &&
            (field.present || (pending?.key === field.key && pending.item === item))
        )
            return "remove";
        if (
            !namedChoice(field) &&
            !field.present &&
            field.schema.type === "string" &&
            !field.schema.enum
        )
            return "empty";
        return undefined;
    }

    function change(
        field: LocalAppDraftField,
        item: number,
        value: LocalAppDraftScalar | undefined,
        text = "",
    ) {
        if (fieldDisabled(field, item) || companionOwner(field)) return;
        let next: string;
        try {
            if (namedChoice(field)) {
                if (!onchoiceedit || (value !== undefined && typeof value !== "string"))
                    throw new Error("Named choice editing is unavailable.");
                next = onchoiceedit(item, field.key, value);
            } else if (onfieldedit) next = onfieldedit(item, field.key, value);
            else next = editLocalAppDraftField(action, editorJson, item, field.key, value);
        } catch {
            // Keep a too-large edit visible, but revoke approval synchronously. The host must block
            // review/delivery while pending; it must never send the old canonical payload instead.
            pending = { item, key: field.key, text, source: editorJson };
            onblocked(true);
            return;
        }
        pending = undefined;
        // Workspace-owned operations retain baseline/manual-edit history. Do not turn them into
        // a second Advanced JSON edit, which deliberately resets that history.
        if (!namedChoice(field) && !onfieldedit) onchange(next);
        onblocked(
            localAppDraftFields(action, next)?.items.some((fields) =>
                fields.some((candidate) => dateInvalid(candidate)),
            ) ?? false,
        );
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

    function selectNamed(field: LocalAppDraftField, item: number, value: string) {
        if (value === "absent") change(field, item, undefined);
        else if (value.startsWith("option-")) {
            const index = Number(value.slice(7));
            const options = namedChoice(field)?.options;
            if (options && Number.isSafeInteger(index) && index >= 0 && index < options.length)
                change(field, item, options[index].value, options[index].label);
        }
    }
</script>

{#snippet companionValue(field: LocalAppDraftField, index: number)}
    <output aria-label={`Item ${index + 1} — ${field.label}`}>
        {field.present ? formatLocalDraftJson(field.value) : "Not supplied"}
    </output>
    <small
        >Controlled by {companionOwner(field)?.label}. Its exact value remains part of the outgoing
        payload.</small
    >
{/snippet}

{#snippet fieldActions(field: LocalAppDraftField, index: number)}
    {#if fieldAction(field, index) === "remove"}
        <button
            type="button"
            disabled={fieldDisabled(field, index)}
            onclick={() => change(field, index, undefined)}>Remove {fieldLabel(field)}</button
        >
    {:else if fieldAction(field, index) === "empty"}
        <button
            type="button"
            disabled={fieldDisabled(field, index)}
            onclick={() => change(field, index, "")}>Set {field.label} to empty text</button
        >
    {/if}
{/snippet}

<section class="draft-fields" class:compact aria-label="Edit private app draft fields">
    {#if showTitle}<h3>{action.definition.card.title}</h3>{/if}
    {#if action.definition.card.disclosure}<p class="disclosure">
            {action.definition.card.disclosure}
        </p>{/if}
    {#if fields}
        {#each fields.items as item, index}
            <fieldset {disabled} aria-label={`Draft fields for item ${index + 1}`}>
                <legend class:single-item={fields.items.length === 1}
                    >{fields.items.length > 1 ? `Item ${index + 1}` : "Draft fields"}</legend
                >
                {#each item as field (field.key)}
                    <div class="field" class:full-width={controlHint(field)?.fullWidth}>
                        {#if compact && companionOwner(field)}
                            <details
                                class="field-details"
                                aria-label={`Item ${index + 1} — ${fieldLabel(field)} exact value`}
                            >
                                <summary
                                    >{fieldLabel(field)}{#if field.required}
                                        <span class="required">Required</span>{/if}</summary
                                >
                                {@render companionValue(field, index)}
                            </details>
                        {:else}
                            <label>
                                <span
                                    >{fieldLabel(field)}
                                    {#if field.required}<span class="required">Required</span
                                        >{/if}</span
                                >
                                {#if companionOwner(field)}
                                    {@render companionValue(field, index)}
                                {:else if namedChoice(field)}
                                    <select
                                        aria-label={`Item ${index + 1} — ${fieldLabel(field)}`}
                                        aria-invalid={!field.valid ||
                                            namedSelection(field) === "invalid" ||
                                            (pending?.item === index && pending.key === field.key)}
                                        disabled={fieldDisabled(field, index)}
                                        value={namedSelection(field)}
                                        onchange={(event) =>
                                            selectNamed(field, index, event.currentTarget.value)}
                                    >
                                        <option value="absent"
                                            >{namedChoice(field)?.noneLabel}</option
                                        >
                                        {#if namedSelection(field) === "invalid"}<option
                                                value="invalid"
                                                disabled>Unknown supplied choice</option
                                            >{/if}
                                        {#each namedChoice(field)?.options ?? [] as option, optionIndex}
                                            <option value={`option-${optionIndex}`}
                                                >{option.label}</option
                                            >
                                        {/each}
                                    </select>
                                {:else if choices(field)}
                                    <select
                                        aria-label={`Item ${index + 1} — ${field.label}`}
                                        aria-invalid={!field.valid}
                                        disabled={fieldDisabled(field, index)}
                                        value={selection(field)}
                                        onchange={(event) =>
                                            select(field, index, event.currentTarget.value)}
                                    >
                                        <option value="absent"
                                            >Not supplied{field.required
                                                ? " (required)"
                                                : ""}</option
                                        >
                                        {#if selection(field) === "invalid"}<option
                                                value="invalid"
                                                disabled>Invalid supplied value</option
                                            >{/if}
                                        {#each choices(field) ?? [] as option, optionIndex}
                                            <option value={`option-${optionIndex}`}
                                                >{enumLabel(field, option)}</option
                                            >
                                        {/each}
                                    </select>
                                {:else if field.schema.type === "string" && controlHint(field)?.kind === "select" && (!field.present || typeof field.value === "string")}
                                    <select
                                        aria-label={`Item ${index + 1} — ${field.label}`}
                                        aria-invalid={!field.valid}
                                        disabled={fieldDisabled(field, index)}
                                        value={field.present ? field.value : ""}
                                        onchange={(event) =>
                                            change(
                                                field,
                                                index,
                                                event.currentTarget.value,
                                                event.currentTarget.value,
                                            )}
                                    >
                                        {#if !field.present}<option value="" disabled
                                                >{field.required
                                                    ? "Not supplied (required)"
                                                    : "Not supplied"}</option
                                            >{/if}
                                        {#if field.present && !controlHint(field)?.suggestions?.includes(String(field.value))}
                                            <option value={String(field.value)}
                                                >{String(field.value)} (supplied value)</option
                                            >
                                        {/if}
                                        {#each controlHint(field)?.suggestions ?? [] as suggestion}
                                            <option value={suggestion}>{suggestion}</option>
                                        {/each}
                                    </select>
                                {:else if field.schema.type === "string" && controlHint(field)?.kind !== "multiline" && controlHint(field)}
                                    <input
                                        type={controlHint(field)?.kind === "date"
                                            ? dateInputType(field, index)
                                            : "text"}
                                        aria-label={`Item ${index + 1} — ${field.label}`}
                                        aria-invalid={!field.valid ||
                                            dateInvalid(field) ||
                                            (pending?.item === index && pending.key === field.key)}
                                        autocomplete="off"
                                        spellcheck={false}
                                        disabled={fieldDisabled(field, index)}
                                        list={controlHint(field)?.suggestions?.length
                                            ? `${controlId}-${index}-${field.key}`
                                            : undefined}
                                        value={inputValue(field, index)}
                                        oninput={(event) =>
                                            change(
                                                field,
                                                index,
                                                event.currentTarget.value,
                                                event.currentTarget.value,
                                            )}
                                    />
                                    {#if controlHint(field)?.suggestions?.length}
                                        <datalist id={`${controlId}-${index}-${field.key}`}>
                                            {#each controlHint(field)?.suggestions ?? [] as suggestion}<option
                                                    value={suggestion}
                                                ></option>{/each}
                                        </datalist>
                                    {/if}
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
                        {/if}
                        {#if pending?.item === index && pending.key === field.key}
                            <small class="invalid">
                                This edit exceeds the draft limit. Shorten it or remove this field
                                before review.
                            </small>
                        {/if}
                        {#if dateInvalid(field)}<small class="invalid"
                                >Enter a real date in YYYY-MM-DD format before review. The supplied
                                text has not been changed.</small
                            >{/if}
                        {#if !(pending?.item === index && pending.key === field.key) && field.present && typeof field.value === "string" && formatLocalDraftJson(field.value) !== JSON.stringify(field.value)}
                            <small
                                >Hidden text controls (escaped exact value): <code
                                    >{formatLocalDraftJson(field.value)}</code
                                ></small
                            >
                        {/if}
                        {#if field.present && ((namedChoice(field) && namedSelection(field) === "invalid") || (choices(field) && selection(field) === "invalid"))}
                            <small class="invalid"
                                >Unrecognized supplied value: <code
                                    >{formatLocalDraftJson(field.value)}</code
                                ></small
                            >
                        {/if}
                        {#if !field.valid}<small class="invalid"
                                >{field.present
                                    ? "This value does not match the app's field schema."
                                    : "A value is required."}</small
                            >{/if}
                        {#if compact && fieldAction(field, index)}
                            <details
                                class="field-details"
                                aria-label={`Item ${index + 1} — ${fieldLabel(field)} options`}
                            >
                                <summary>Field options</summary>
                                {@render fieldActions(field, index)}
                            </details>
                        {:else}
                            {@render fieldActions(field, index)}
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
        {#if !pending}
            <PrivateAppCardPreview {action} {editorJson} additionalOnly />
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
    .field,
    label {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        min-width: 0;
    }
    fieldset {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 10rem), 1fr));
        border: 1px solid #888;
        border-radius: 0.5rem;
        padding: 0.75rem;
        gap: 0.75rem;
    }
    .full-width {
        grid-column: 1 / -1;
    }
    .compact {
        gap: 8px;
    }
    .compact fieldset {
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 120px), 1fr));
        min-width: 0;
        margin: 0;
        padding: 0;
        border: 0;
        gap: 8px;
    }
    .compact legend.single-item {
        display: none;
    }
    .compact .field,
    .compact label {
        gap: 4px;
    }
    .compact label > span,
    .compact summary {
        font-size: 11px;
        line-height: 1.4;
    }
    .compact input,
    .compact select,
    .compact textarea {
        min-height: 44px;
        padding: 8px;
        font-size: 14px;
    }
    .field-details {
        min-width: 0;
    }
    .field-details summary {
        cursor: pointer;
        padding: 4px 0;
        overflow-wrap: anywhere;
    }
    .field-details[open] > :not(summary) {
        display: block;
        margin-top: 4px;
    }
    .required {
        font-size: 0.75em;
        opacity: 0.7;
    }
    .disclosure {
        font-size: 0.875rem;
    }
    input,
    textarea,
    select {
        width: 100%;
        min-height: 44px;
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
        min-height: 44px;
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
