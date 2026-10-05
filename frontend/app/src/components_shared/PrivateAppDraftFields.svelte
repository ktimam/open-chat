<script lang="ts">
    import { untrack } from "svelte";
    import type { LocalAppAction } from "../utils/localAppCatalog";
    import { localAppDraftChoiceCompanionFields } from "../utils/localAppDraftChoices";
    import { formatLocalDraftJson } from "../utils/localAppDrafts";
    import {
        validateLocalAppView,
        type LocalAppViewNode,
        type LocalAppViewPalette,
    } from "../utils/localAppView";
    import {
        isValidLocalDraftIsoDate,
        validateLocalAppDraftPresentation,
    } from "../utils/localAppDraftPresentation";
    import PrivateAppCardPreview from "./PrivateAppCardPreview.svelte";
    import {
        editLocalAppDraftField,
        localAppDraftFields,
        localAppDraftSource,
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
        view,
        readOnly = false,
        reviewing = true,
        viewTheme = "light",
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
        /** Optional app-owned presentation; always revalidated against the current action. */
        view?: unknown;
        /** Host-owned mode, never accepted from app view metadata. */
        readOnly?: boolean;
        /** Host approval lifecycle only: app metadata can never suppress full review. */
        reviewing?: boolean;
        viewTheme?: "light" | "dark";
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
    const validatedView = $derived.by(() => {
        if (view === undefined) return undefined;
        try {
            return validateLocalAppView(view, action.draftSchema, action.handoff);
        } catch {
            return undefined;
        }
    });
    const invalidView = $derived(view !== undefined && !validatedView);
    const exactViewPayload = $derived.by(() => {
        if (!validatedView) return undefined;
        try {
            return formatLocalDraftJson(localAppDraftSource(action, editorJson).payload);
        } catch {
            return undefined;
        }
    });
    const viewFields = $derived.by(() => {
        const result = new Map<string, Extract<LocalAppViewNode, { kind: "field" }>>();
        function collect(nodes: readonly LocalAppViewNode[]) {
            for (const node of nodes) {
                if (node.kind === "field") result.set(node.field, node);
                else if (node.kind !== "text") collect(node.children);
            }
        }
        if (validatedView) collect(validatedView.view.nodes);
        return result;
    });
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
        const blocked = !!pending || invalidDate || invalidView;
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
        const original = presentation?.controls?.find((control) => control.field === field.key);
        // Layout cannot remove date validation, suggestions or named-choice/default semantics.
        const hint = viewFields.get(field.key)?.control;
        if (!hint || original?.kind === "date" || original?.kind === "select") return original;
        return {
            ...original,
            field: field.key,
            kind: hint === "single-line" ? ("text" as const) : ("multiline" as const),
        };
    }

    function paletteStyle(palette: LocalAppViewPalette | undefined): string {
        if (!palette) return "";
        // Keys and exact hex values came from the strict validator, not arbitrary CSS.
        return Object.entries(palette)
            .map(([key, value]) => `--app-view-${key}:${value}`)
            .join(";");
    }

    function groupStyle(node: Extract<LocalAppViewNode, { kind: "group" | "row" }>): string {
        const spacing = { none: 0, small: 8, medium: 16 };
        const radius = { none: 0, small: 10, medium: 14 };
        return `gap:${spacing[node.gap ?? "small"]}px;padding:${spacing[node.padding ?? "none"]}px;border-radius:${radius[node.radius ?? "none"]}px`;
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

    function changeTextInput(field: LocalAppDraftField, item: number, input: HTMLInputElement) {
        const text = input.value;
        // An optional date's empty control means omission, through the same host removal
        // callback as Field options. Incomplete native input is not an intentional clear.
        // Required dates and unrelated text retain their explicit empty-string semantics.
        const remove =
            controlHint(field)?.kind === "date" &&
            !field.required &&
            text === "" &&
            !input.validity.badInput;
        change(field, item, remove ? undefined : text, text);
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

    function readOnlyValue(field: LocalAppDraftField): string {
        if (!field.present) return "Not supplied";
        const label =
            namedChoice(field)?.options.find((option) => option.value === field.value)?.label ??
            presentation?.enumLabels
                .find((mapping) => mapping.field === field.key)
                ?.options.find((option) => option.value === field.value)?.label;
        if (label !== undefined) return label;
        const exact = formatLocalDraftJson(field.value);
        // Preserve visible control-character escapes, while ordinary strings need no JSON quotes.
        return typeof field.value === "string" &&
            !/[\p{Cc}\p{Cf}\u2028\u2029\ud800-\udfff]/u.test(field.value)
            ? field.value
            : exact;
    }

    function companionOwner(field: LocalAppDraftField) {
        return action.draftEditor?.choices.find((choice) =>
            localAppDraftChoiceCompanionFields(choice).includes(field.key),
        );
    }

    function hasChoiceCompanion(field: LocalAppDraftField, item: number): boolean {
        const choice = namedChoice(field);
        if (!choice) return false;
        const companions = localAppDraftChoiceCompanionFields(choice);
        return (
            fields?.items[item]?.some(
                (candidate) => candidate.present && companions.includes(candidate.key),
            ) ?? false
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
        return (
            disabled ||
            readOnly ||
            invalidView ||
            !!(pending && (pending.item !== item || pending.key !== field.key))
        );
    }

    function fieldAction(field: LocalAppDraftField, item: number): "remove" | "empty" | undefined {
        if (readOnly) return undefined;
        if (companionOwner(field)) return undefined;
        if (
            !field.required &&
            (field.present ||
                hasChoiceCompanion(field, item) ||
                (pending?.key === field.key && pending.item === item))
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
            invalidView ||
                (localAppDraftFields(action, next)?.items.some((fields) =>
                    fields.some((candidate) => dateInvalid(candidate)),
                ) ??
                    false),
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

{#snippet renderField(field: LocalAppDraftField, index: number)}
    <div class="field" class:full-width={controlHint(field)?.fullWidth}>
        {#if readOnly}
            <span>{fieldLabel(field)}</span>
            <output aria-label={`Item ${index + 1} — ${fieldLabel(field)}`}>
                {readOnlyValue(field)}
            </output>
        {:else if compact && companionOwner(field)}
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
                    {#if field.required}<span class="required">Required</span>{/if}</span
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
                        onchange={(event) => selectNamed(field, index, event.currentTarget.value)}
                    >
                        <option value="absent">{namedChoice(field)?.noneLabel}</option>
                        {#if namedSelection(field) === "invalid"}<option value="invalid" disabled
                                >Unknown supplied choice</option
                            >{/if}
                        {#each namedChoice(field)?.options ?? [] as option, optionIndex}
                            <option value={`option-${optionIndex}`}>{option.label}</option>
                        {/each}
                    </select>
                {:else if choices(field)}
                    <select
                        aria-label={`Item ${index + 1} — ${field.label}`}
                        aria-invalid={!field.valid}
                        disabled={fieldDisabled(field, index)}
                        value={selection(field)}
                        onchange={(event) => select(field, index, event.currentTarget.value)}
                    >
                        <option value="absent"
                            >Not supplied{field.required ? " (required)" : ""}</option
                        >
                        {#if selection(field) === "invalid"}<option value="invalid" disabled
                                >Invalid supplied value</option
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
                        oninput={(event) => changeTextInput(field, index, event.currentTarget)}
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
                This edit exceeds the draft limit. Shorten it or remove this field before review.
            </small>
        {/if}
        {#if dateInvalid(field)}<small class="invalid"
                >Enter a real date in YYYY-MM-DD format before review. The supplied text has not
                been changed.</small
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
                >Unrecognized supplied value: <code>{formatLocalDraftJson(field.value)}</code
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
{/snippet}

{#snippet renderViewNodes(
    nodes: readonly LocalAppViewNode[],
    item: LocalAppDraftField[],
    index: number,
)}
    {#each nodes as node}
        {#if node.kind === "field"}
            {@const field = item.find((candidate) => candidate.key === node.field)}
            {#if field}
                <div
                    class="view-field"
                    class:view-full-width={node.fullWidth}
                    style={`--view-field-width:${node.fullWidth ? "100%" : `${node.minWidth ?? 120}px`}`}
                >
                    {@render renderField(field, index)}
                </div>
            {/if}
        {:else if node.kind === "text"}
            <p
                class="view-text"
                class:view-muted={node.tone === "muted"}
                class:view-accent={node.tone === "accent"}
                class:view-small={node.size === "small"}
                class:view-heading={node.size === "heading"}
            >
                {node.text}
            </p>
        {:else}
            <div
                class="view-group"
                class:view-row={node.kind === "row"}
                class:view-card={node.surface === "card"}
                style={groupStyle(node)}
            >
                {@render renderViewNodes(node.children, item, index)}
            </div>
        {/if}
    {/each}
{/snippet}

<section class="draft-fields" class:compact aria-label="Edit private app draft fields">
    {#if showTitle}<h3>{action.definition.card.title}</h3>{/if}
    {#if action.definition.card.disclosure}<p class="disclosure">
            {action.definition.card.disclosure}
        </p>{/if}
    {#if invalidView}<p role="alert">
            The app view could not be verified for this action. Review is blocked; canonical fields
            are shown below.
        </p>{/if}
    {#if fields}
        {#each fields.items as item, index}
            <fieldset {disabled} aria-label={`Draft fields for item ${index + 1}`}>
                <legend class:single-item={fields.items.length === 1}
                    >{fields.items.length > 1 ? `Item ${index + 1}` : "Draft fields"}</legend
                >
                {#if validatedView}
                    <div
                        class="app-owned-view"
                        aria-label={`App presentation for item ${index + 1}`}
                        style={paletteStyle(validatedView.view.theme?.[viewTheme])}
                        style:color-scheme={viewTheme === "dark" ? "dark" : "light"}
                    >
                        {@render renderViewNodes(validatedView.view.nodes, item, index)}
                    </div>
                    {#if item.some((field) => !viewFields.has(field.key))}
                        <div
                            class="host-additional-fields"
                            aria-label={`Additional canonical fields for item ${index + 1}`}
                        >
                            <p>Additional fields for complete review</p>
                            {#each item.filter((field) => !viewFields.has(field.key)) as field (field.key)}
                                {@render renderField(field, index)}
                            {/each}
                        </div>
                    {/if}
                {:else}
                    {#each item as field (field.key)}
                        {@render renderField(field, index)}
                    {/each}
                {/if}
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
            {#if validatedView && reviewing}<p class="host-review-notice">
                    Review every canonical value below before approving. App presentation is not a
                    substitute for complete host review.
                </p>{/if}
            <PrivateAppCardPreview
                {action}
                {editorJson}
                additionalOnly={!validatedView || !reviewing}
            />
            {#if validatedView && reviewing && exactViewPayload !== undefined}
                <section class="host-exact-review" aria-label="Complete canonical outgoing values">
                    <h4>Exact outgoing values</h4>
                    <pre>{exactViewPayload}</pre>
                </section>
            {/if}
        {/if}
    {:else}
        <p role="status">
            Field editing is unavailable for this JSON structure. Correct the complete payload in
            advanced JSON. No previous values are shown.
        </p>
    {/if}
</section>

<style>
    /* Only validated app presentation is themed. Host review and delivery stay outside it. */
    .app-owned-view,
    .host-additional-fields,
    .host-exact-review {
        grid-column: 1 / -1;
        min-width: 0;
    }
    .app-owned-view {
        display: flex;
        flex-direction: column;
        gap: 8px;
        color: var(--app-view-text, var(--txt, #1b1b1b));
        background: var(--app-view-background, transparent);
    }
    .view-group,
    .host-additional-fields {
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-width: 0;
    }
    .view-row {
        flex-direction: row;
        flex-wrap: wrap;
        align-items: flex-start;
    }
    .view-card {
        border: 1px solid var(--app-view-border, #888888);
        background: var(--app-view-surface, transparent);
    }
    .view-field {
        min-width: 0;
        max-width: 100%;
    }
    .view-row > .view-field {
        flex: 1 1 var(--view-field-width, 120px);
    }
    .view-full-width {
        width: 100%;
    }
    .app-owned-view .field,
    .app-owned-view label {
        gap: 4px;
    }
    .app-owned-view label > span {
        font-size: 11px;
    }
    .app-owned-view .field input,
    .app-owned-view .field select,
    .app-owned-view .field textarea {
        min-height: 44px;
        font-size: 15px;
        padding: 7px 10px;
        border-radius: 10px;
        color: var(--app-view-text, var(--txt, #1b1b1b));
        border-color: var(--app-view-border, #888888);
        background: var(--app-view-field, var(--bg, #ffffff));
    }
    .view-muted {
        color: var(--app-view-muted, inherit);
    }
    .view-accent {
        color: var(--app-view-accent, inherit);
    }
    .view-small {
        font-size: 12px;
    }
    .view-heading {
        font-size: 18px;
        font-weight: 600;
    }
    .host-exact-review pre {
        margin: 0;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
    }
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
    output {
        display: block;
        min-width: 0;
        max-width: 100%;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
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
