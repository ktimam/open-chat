import type { LocalAppAction } from "./localAppCatalog";
import {
    formatLocalDraftJson,
    snapshotLocalDraftJson,
    snapshotLocalDraftPayload,
    snapshotLocalDraftSchema,
    type LocalDraftJson,
    type LocalDraftSchema,
} from "./localAppDrafts";

export type LocalAppDraftScalar = null | boolean | number | string;
export type LocalAppDraftObjectSchema = Extract<LocalDraftSchema, { type: "object" }>;
export type LocalAppDraftObject = { readonly [key: string]: LocalDraftJson };
type ObjectSchema = LocalAppDraftObjectSchema;
type DraftObject = LocalAppDraftObject;

export interface LocalAppDraftField {
    key: string;
    label: string;
    displayKey: string;
    schema: LocalDraftSchema;
    required: boolean;
    present: boolean;
    value: LocalDraftJson | undefined;
    valid: boolean;
}

export interface LocalAppDraftFields {
    items: LocalAppDraftField[][];
    valid: boolean;
    hasOtherFields: boolean;
}

function object(value: LocalDraftJson | undefined): value is DraftObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function localDraftFieldLabel(value: string): string {
    return formatLocalDraftJson(value).slice(1, -1);
}

function scalar(schema: LocalDraftSchema): boolean {
    return schema.type !== "object" && schema.type !== "array";
}

function valid(value: LocalDraftJson, schema: LocalDraftSchema): boolean {
    try {
        snapshotLocalDraftPayload(value, schema);
        return true;
    } catch {
        return false;
    }
}

// Read only bounded structural JSON here. Schema-invalid scalar edits must stay recoverable in
// controls, but never display an older valid draft. Review/delivery use the full schema validator.
export function localAppDraftRowSchema(
    schema: LocalDraftSchema,
    mapping: LocalAppAction["handoff"],
): ObjectSchema {
    const itemSchema =
        mapping.kind === "single"
            ? schema
            : mapping.kind === "list"
              ? schema.type === "array"
                  ? schema.items
                  : undefined
              : schema.type === "object" && Object.hasOwn(schema.properties, mapping.field)
                ? schema.properties[mapping.field]
                : undefined;
    const recordSchema =
        mapping.kind === "wrapped-list"
            ? itemSchema?.type === "array"
                ? itemSchema.items
                : undefined
            : itemSchema;
    if (recordSchema?.type !== "object") throw new Error("Invalid draft row schema");
    return recordSchema;
}

export function localAppDraftSource(action: LocalAppAction, editorJson: string) {
    if (new TextEncoder().encode(editorJson).byteLength > 64 * 1024)
        throw new Error("Invalid draft");
    const payload = snapshotLocalDraftJson(JSON.parse(editorJson));
    const schema = snapshotLocalDraftSchema(action.draftSchema);
    const mapping = action.handoff;
    const recordSchema = localAppDraftRowSchema(schema, mapping);
    const records =
        mapping.kind === "single"
            ? [payload]
            : mapping.kind === "list"
              ? payload
              : object(payload) && Object.hasOwn(payload, mapping.field)
                ? payload[mapping.field]
                : undefined;
    if (
        !Array.isArray(records) ||
        records.length < 1 ||
        records.length > 32 ||
        !records.every(object)
    )
        throw new Error("Invalid draft");
    return { payload, schema, records: records as readonly DraftObject[], recordSchema };
}

/** Preserve the complete envelope while replacing only the explicitly supplied row snapshots. */
export function replaceLocalAppDraftRecords(
    action: LocalAppAction,
    payload: LocalDraftJson,
    records: readonly DraftObject[],
): string {
    const mapping = action.handoff;
    if (
        records.length < 1 ||
        records.length > 32 ||
        !records.every(object) ||
        (mapping.kind === "single" && records.length !== 1) ||
        (mapping.kind === "wrapped-list" && !object(payload))
    )
        throw new Error("Invalid draft rows");
    const updated =
        mapping.kind === "single"
            ? records[0]
            : mapping.kind === "list"
              ? records
              : { ...(payload as DraftObject), [mapping.field]: records };
    const serialized = formatLocalDraftJson(snapshotLocalDraftJson(updated));
    if (new TextEncoder().encode(serialized).byteLength > 64 * 1024)
        throw new Error("Invalid draft field edit");
    return serialized;
}

function fields(record: DraftObject, schema: ObjectSchema, action: LocalAppAction) {
    const labels = new Map(action.definition.card.rows.map((row) => [row.valueKey, row.label]));
    const keys = [...new Set([...labels.keys(), ...Object.keys(schema.properties)])];
    return keys.flatMap((key): LocalAppDraftField[] => {
        if (!Object.hasOwn(schema.properties, key) || !scalar(schema.properties[key])) return [];
        const fieldSchema = schema.properties[key];
        const present = Object.hasOwn(record, key);
        const required = schema.required?.includes(key) ?? false;
        return [
            {
                key,
                label: localDraftFieldLabel(labels.get(key) ?? key),
                displayKey: localDraftFieldLabel(key),
                schema: fieldSchema,
                required,
                present,
                value: present ? record[key] : undefined,
                valid: present ? valid(record[key], fieldSchema) : !required,
            },
        ];
    });
}

/** Scalar controls only. Complex and undeclared values remain in the complete draft/JSON review. */
export function localAppDraftFields(
    action: LocalAppAction,
    editorJson: string,
): LocalAppDraftFields | undefined {
    try {
        const { payload, schema, records, recordSchema } = localAppDraftSource(action, editorJson);
        return {
            items: records.map((record) => fields(record, recordSchema, action)),
            valid: valid(payload, schema),
            hasOtherFields:
                records.some((record) =>
                    Object.keys(record).some(
                        (key) =>
                            !Object.hasOwn(recordSchema.properties, key) ||
                            !scalar(recordSchema.properties[key]),
                    ),
                ) ||
                (action.handoff.kind === "wrapped-list" &&
                    object(payload) &&
                    Object.keys(payload).some(
                        (key) =>
                            action.handoff.kind === "wrapped-list" && key !== action.handoff.field,
                    )),
        };
    } catch {
        return undefined;
    }
}

/** No guessed/default business values. A partial numeric edit stays an invalid string, not zero. */
export function localDraftNumericInput(text: string): number | string {
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)) return text;
    const value = Number(text);
    return Number.isFinite(value) ? value : text;
}

/** Copy exactly one explicit scalar change, preserving every other item and envelope field. */
export function editLocalAppDraftField(
    action: LocalAppAction,
    editorJson: string,
    itemIndex: number,
    key: string,
    value: LocalAppDraftScalar | undefined,
): string {
    const { payload, records, recordSchema } = localAppDraftSource(action, editorJson);
    if (
        !Number.isSafeInteger(itemIndex) ||
        itemIndex < 0 ||
        itemIndex >= records.length ||
        !Object.hasOwn(recordSchema.properties, key) ||
        !scalar(recordSchema.properties[key]) ||
        (value !== undefined &&
            value !== null &&
            !["string", "number", "boolean"].includes(typeof value))
    )
        throw new Error("Invalid draft field edit");
    const record = { ...records[itemIndex] };
    if (value === undefined) delete record[key];
    else record[key] = value;
    const updatedRecords = records.map((item, index) => (index === itemIndex ? record : item));
    // This intentionally checks structural safety, not schema validity: typing '-' into a number
    // must revoke review immediately and remain editable until the user finishes the value.
    return replaceLocalAppDraftRecords(action, payload, updatedRecords);
}
