import type { LocalAppAction } from "./localAppCatalog";
import { localAppDraftRowSchema, type LocalAppDraftScalar } from "./localAppDraftFields";
import {
    snapshotLocalDraftJson,
    snapshotLocalDraftPayload,
    snapshotLocalDraftSchema,
    type LocalDraftSchema,
} from "./localAppDrafts";

/** Labels only: never add, remove, coerce or default a draft value. */
export interface DraftPresentationV1 {
    readonly version: 1;
    readonly enumLabels: readonly Readonly<{
        field: string;
        options: readonly Readonly<{ value: LocalAppDraftScalar; label: string }>[];
    }>[];
}

function invalid(): never {
    throw new Error("Invalid local draft presentation");
}

function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
    )
        invalid();
}

function list(value: unknown, max: number): asserts value is unknown[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > max) invalid();
}

/** Every mapped enum is covered exactly once; unmapped fields retain their existing raw display. */
export function validateLocalAppDraftPresentation(
    value: unknown,
    schema: LocalDraftSchema,
    handoff: LocalAppAction["handoff"],
): DraftPresentationV1 {
    // Shared snapshot rejects executable/non-JSON values and enforces the 64 KiB tree budget.
    // Its recursively frozen copy prevents later mutation of imported labels or enum identities.
    const copied = snapshotLocalDraftJson(value);
    exact(copied, ["version", "enumLabels"]);
    if (copied.version !== 1) invalid();
    list(copied.enumLabels, 32);
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
    return copied as unknown as DraftPresentationV1;
}
