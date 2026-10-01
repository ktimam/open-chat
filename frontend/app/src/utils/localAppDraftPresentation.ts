import type { LocalAppAction } from "./localAppCatalog";
import { localAppDraftRowSchema, type LocalAppDraftScalar } from "./localAppDraftFields";
import {
    snapshotLocalDraftJson,
    snapshotLocalDraftPayload,
    snapshotLocalDraftSchema,
    type LocalDraftSchema,
} from "./localAppDrafts";

/** Presentation only: never add, remove, coerce or default a draft value. */
export interface DraftPresentationV1 {
    readonly version: 1;
    readonly enumLabels: readonly Readonly<{
        field: string;
        options: readonly Readonly<{ value: LocalAppDraftScalar; label: string }>[];
    }>[];
    readonly controls?: readonly Readonly<{
        field: string;
        kind: "text" | "multiline" | "date";
        fullWidth?: boolean;
        /** Suggestions are not an enum: existing schema-valid values remain editable. */
        suggestions?: readonly string[];
    }>[];
}

function invalid(): never {
    throw new Error("Invalid local draft presentation");
}

function exact(
    value: unknown,
    keys: readonly string[],
    optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        keys.some((key) => !Object.hasOwn(value, key)) ||
        Object.keys(value).some((key) => !keys.includes(key) && !optional.includes(key))
    )
        invalid();
}

function list(value: unknown, max: number, min = 1): asserts value is unknown[] {
    if (!Array.isArray(value) || value.length < min || value.length > max) invalid();
}

/** Test without normalizing, trimming or replacing the supplied date text. */
export function isValidLocalDraftIsoDate(value: unknown): value is string {
    if (typeof value !== "string" || value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(value))
        return false;
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    if (year < 1 || month < 1 || month > 12 || day < 1) return false;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** Every mapped enum is covered exactly once; hints never hide or constrain other fields. */
export function validateLocalAppDraftPresentation(
    value: unknown,
    schema: LocalDraftSchema,
    handoff: LocalAppAction["handoff"],
): DraftPresentationV1 {
    // Shared snapshot rejects executable/non-JSON values and enforces the 64 KiB tree budget.
    // Its recursively frozen copy prevents later mutation of imported labels or enum identities.
    const copied = snapshotLocalDraftJson(value);
    exact(copied, ["version", "enumLabels"], ["controls"]);
    if (copied.version !== 1) invalid();
    list(copied.enumLabels, 32, Object.hasOwn(copied, "controls") ? 0 : 1);
    const row = localAppDraftRowSchema(snapshotLocalDraftSchema(schema), handoff);
    const fields = new Set<string>();
    for (const mapping of copied.enumLabels) {
        exact(mapping, ["field", "options"]);
        if (
            typeof mapping.field !== "string" ||
            !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(mapping.field) ||
            ["__proto__", "constructor", "prototype"].includes(mapping.field) ||
            !Object.hasOwn(row.properties, mapping.field) ||
            fields.has(mapping.field)
        )
            invalid();
        fields.add(mapping.field);
        const property = row.properties[mapping.field];
        if (property.type === "object" || property.type === "array" || !property.enum) invalid();
        list(mapping.options, 64);
        if (mapping.options.length !== property.enum.length) invalid();
        const values = new Set<LocalAppDraftScalar>();
        const labels = new Set<string>();
        for (const option of mapping.options) {
            exact(option, ["value", "label"]);
            if (
                typeof option.label !== "string" ||
                !option.label.trim() ||
                option.label !== option.label.trim() ||
                option.label.length > 128 ||
                /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(option.label) ||
                labels.has(option.label)
            )
                invalid();
            // Enforce both exact enum identity and its declared scalar type/bounds.
            snapshotLocalDraftPayload(option.value, property);
            const scalar = option.value as LocalAppDraftScalar;
            if (values.has(scalar)) invalid();
            values.add(scalar);
            labels.add(option.label);
        }
        if (property.enum.some((scalar) => !values.has(scalar))) invalid();
    }
    if (Object.hasOwn(copied, "controls")) {
        list(copied.controls, 32);
        const controlled = new Set<string>();
        for (const control of copied.controls) {
            exact(control, ["field", "kind"], ["fullWidth", "suggestions"]);
            if (
                typeof control.field !== "string" ||
                !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(control.field) ||
                ["__proto__", "constructor", "prototype"].includes(control.field) ||
                !Object.hasOwn(row.properties, control.field) ||
                controlled.has(control.field) ||
                !["text", "multiline", "date"].includes(control.kind as string) ||
                (Object.hasOwn(control, "fullWidth") && typeof control.fullWidth !== "boolean")
            )
                invalid();
            controlled.add(control.field);
            const property = row.properties[control.field];
            if (property.type !== "string" || property.enum) invalid();
            if (Object.hasOwn(control, "suggestions")) {
                if (control.kind !== "text") invalid();
                list(control.suggestions, 256);
                const seen = new Set<string>();
                for (const suggestion of control.suggestions) {
                    if (
                        typeof suggestion !== "string" ||
                        !suggestion.trim() ||
                        suggestion !== suggestion.trim() ||
                        suggestion.length > 128 ||
                        /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(suggestion) ||
                        seen.has(suggestion)
                    )
                        invalid();
                    snapshotLocalDraftPayload(suggestion, property);
                    seen.add(suggestion);
                }
            }
        }
    }
    return copied as unknown as DraftPresentationV1;
}
