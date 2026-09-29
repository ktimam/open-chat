import type { LocalAppAction } from "./localAppCatalog";
import {
    snapshotLocalDraftJson,
    snapshotLocalDraftPayload,
    snapshotLocalDraftSchema,
    type LocalDraftSchema,
} from "./localAppDrafts";
import {
    editLocalAppDraftField,
    localAppDraftRowSchema,
    localAppDraftSource,
    replaceLocalAppDraftRecords,
    type LocalAppDraftObject,
    type LocalAppDraftScalar,
} from "./localAppDraftFields";

type Assignment = Readonly<{ field: string; value: LocalAppDraftScalar }>;
export interface DraftEditorV1 {
    readonly version: 1;
    readonly choices: readonly Readonly<{
        field: string;
        label: string;
        noneLabel: string;
        options: readonly Readonly<{
            value: string;
            label: string;
            assign: readonly Assignment[];
            defaults: readonly Assignment[];
        }>[];
    }>[];
}
type Choice = DraftEditorV1["choices"][number];
type Baseline = Readonly<{ field: string; present: boolean; value?: LocalAppDraftScalar }>;
type RowState = Readonly<{ edited: readonly string[]; baseline: readonly Baseline[] }>;
/** Ephemeral only: never serialize this session into setup, drafts, approvals or handoff. */
export interface LocalAppDraftChoiceSession {
    readonly action: LocalAppAction;
    readonly editorJson: string;
    readonly manual: boolean;
    readonly rows: readonly RowState[];
    readonly binding: string;
}
function fail(): never {
    throw new Error("Invalid local draft choice");
}
// eslint-disable-next-line no-control-regex -- Imported labels must not contain hidden controls.
const HIDDEN = /[\p{Cf}\u0000-\u001f\u007f]/u;
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
    )
        fail();
}
function text(value: unknown): asserts value is string {
    if (typeof value !== "string" || !value.trim() || value.length > 128 || HIDDEN.test(value))
        fail();
}
function field(value: unknown): asserts value is string {
    if (
        typeof value !== "string" ||
        !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ||
        ["__proto__", "constructor", "prototype"].includes(value)
    )
        fail();
}
function list(value: unknown, max: number, min = 0): asserts value is unknown[] {
    if (!Array.isArray(value) || value.length < min || value.length > max) fail();
}
function freeze<T>(value: T): T {
    if (value && typeof value === "object") {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    }
    return value;
}

/** Strict, bounded data only. Targets cannot overlap, chain or escape their object row. */
export function validateLocalAppDraftEditor(
    value: unknown,
    schema: LocalDraftSchema,
    handoff: LocalAppAction["handoff"],
): DraftEditorV1 {
    const copied = snapshotLocalDraftJson(value);
    if (new TextEncoder().encode(JSON.stringify(copied)).byteLength > 64 * 1024) fail();
    exact(copied, ["version", "choices"]);
    if (copied.version !== 1) fail();
    list(copied.choices, 8, 1);
    const row = localAppDraftRowSchema(snapshotLocalDraftSchema(schema), handoff);
    const targets = new Set<string>();
    const target = (key: unknown, optional = false) => {
        field(key);
        if (!Object.hasOwn(row.properties, key)) fail();
        const property = row.properties[key];
        if (
            property.type === "object" ||
            property.type === "array" ||
            (optional && row.required?.includes(key))
        )
            fail();
        return property;
    };
    for (const choice of copied.choices) {
        exact(choice, ["field", "label", "noneLabel", "options"]);
        if (target(choice.field, true).type !== "string") fail();
        field(choice.field);
        text(choice.label);
        text(choice.noneLabel);
        list(choice.options, 64, 1);
        const values = new Set<string>(),
            labels = new Set<string>();
        let expected: string | undefined;
        for (const option of choice.options) {
            exact(option, ["value", "label", "assign", "defaults"]);
            text(option.value);
            text(option.label);
            if (
                values.has(option.value) ||
                labels.has(option.label) ||
                option.label === choice.noneLabel
            )
                fail();
            values.add(option.value);
            labels.add(option.label);
            snapshotLocalDraftPayload(option.value, row.properties[choice.field]);
            const optionTargets = new Set([choice.field]);
            const sets: string[][] = [];
            for (const key of ["assign", "defaults"] as const) {
                list(option[key], 8);
                const names: string[] = [];
                for (const assignment of option[key]) {
                    exact(assignment, ["field", "value"]);
                    const property = target(assignment.field, key === "assign");
                    field(assignment.field);
                    if (optionTargets.has(assignment.field)) fail();
                    optionTargets.add(assignment.field);
                    names.push(assignment.field);
                    snapshotLocalDraftPayload(assignment.value, property);
                }
                sets.push(names.sort());
            }
            const signature = JSON.stringify(sets);
            if (expected !== undefined && signature !== expected) fail();
            if (expected === undefined) {
                for (const name of optionTargets) {
                    if (targets.has(name)) fail();
                    targets.add(name);
                }
            }
            expected = signature;
        }
    }
    return freeze(copied) as unknown as DraftEditorV1;
}

function declarations(action: LocalAppAction): readonly Choice[] {
    return action.draftEditor === undefined
        ? []
        : validateLocalAppDraftEditor(action.draftEditor, action.draftSchema, action.handoff)
              .choices;
}
function binding(action: LocalAppAction, editorJson: string): string {
    return JSON.stringify([action.handoff, action.draftSchema, action.draftEditor, editorJson]);
}
function check(current: LocalAppDraftChoiceSession): void {
    if (current.binding !== binding(current.action, current.editorJson)) fail();
}
function session(
    action: LocalAppAction,
    editorJson: string,
    manual: boolean,
    rows: readonly RowState[],
): LocalAppDraftChoiceSession {
    // Do not freeze the caller's action as a side effect; catalogs are already immutable snapshots.
    return Object.freeze({
        action,
        editorJson,
        manual,
        rows: freeze(rows),
        binding: binding(action, editorJson),
    });
}
function apply(
    record: LocalAppDraftObject,
    choice: Choice,
    value: string | undefined,
    state: RowState,
    manual: boolean,
) {
    const result = { ...record };
    const option =
        value === undefined ? undefined : choice.options.find((item) => item.value === value);
    if (value !== undefined && !option) fail();
    if (option) {
        result[choice.field] = option.value;
        for (const assignment of option.assign) result[assignment.field] = assignment.value;
        for (const assignment of option.defaults)
            if (!manual && !state.edited.includes(assignment.field))
                result[assignment.field] = assignment.value;
    } else {
        delete result[choice.field];
        for (const assignment of choice.options[0].assign) delete result[assignment.field];
        for (const assignment of choice.options[0].defaults) {
            if (manual || state.edited.includes(assignment.field)) continue;
            const previous = state.baseline.find((item) => item.field === assignment.field);
            if (!previous) fail();
            if (previous.present) result[assignment.field] = previous.value!;
            else delete result[assignment.field];
        }
    }
    return result;
}

export function initializeLocalAppDraftChoices(
    action: LocalAppAction,
    editorJson: string,
): LocalAppDraftChoiceSession {
    const choices = declarations(action);
    if (!choices.length) return session(action, editorJson, false, []);
    const { payload, records } = localAppDraftSource(action, editorJson);
    snapshotLocalDraftPayload(payload, action.draftSchema);
    const rows = records.map(
        (record): RowState => ({
            edited: [],
            baseline: choices.flatMap((choice) =>
                choice.options[0].defaults.map(
                    ({ field }): Baseline => ({
                        field,
                        present: Object.hasOwn(record, field),
                        ...(Object.hasOwn(record, field)
                            ? { value: record[field] as LocalAppDraftScalar }
                            : {}),
                    }),
                ),
            ),
        }),
    );
    const updated = records.map((record, index) =>
        choices.reduce((row, choice) => {
            const value = row[choice.field];
            // Unknown/absent selections are visible and review-blocking if inconsistent, never erased.
            return typeof value === "string" &&
                choice.options.some((option) => option.value === value)
                ? apply(row, choice, value, rows[index], false)
                : row;
        }, record),
    );
    return session(action, replaceLocalAppDraftRecords(action, payload, updated), false, rows);
}

export function selectLocalAppDraftChoice(
    current: LocalAppDraftChoiceSession,
    itemIndex: number,
    field: string,
    value: string | undefined,
): LocalAppDraftChoiceSession {
    check(current);
    const choices = declarations(current.action);
    const choice = choices.find((item) => item.field === field);
    const { payload, records } = localAppDraftSource(current.action, current.editorJson);
    if (!choice || !Number.isSafeInteger(itemIndex) || itemIndex < 0 || itemIndex >= records.length)
        fail();
    const state = current.manual ? { edited: [], baseline: [] } : current.rows[itemIndex];
    if (!state || (!current.manual && current.rows.length !== records.length)) fail();
    const updated = records.map((record, index) =>
        index === itemIndex ? apply(record, choice, value, state, current.manual) : record,
    );
    return session(
        current.action,
        replaceLocalAppDraftRecords(current.action, payload, updated),
        current.manual,
        current.rows,
    );
}

export function editLocalAppDraftScalar(
    current: LocalAppDraftChoiceSession,
    itemIndex: number,
    field: string,
    value: LocalAppDraftScalar | undefined,
): LocalAppDraftChoiceSession {
    check(current);
    const choices = declarations(current.action);
    if (
        choices.some(
            (choice) =>
                choice.field === field ||
                choice.options[0].assign.some((item) => item.field === field),
        )
    )
        fail();
    const json = editLocalAppDraftField(
        current.action,
        current.editorJson,
        itemIndex,
        field,
        value,
    );
    const rows = current.rows.map((row, index) =>
        index !== itemIndex ? row : { ...row, edited: [...new Set([...row.edited, field])] },
    );
    return session(current.action, json, current.manual, rows);
}

/** Manual JSON is authoritative, including invalid input; never infer row identities or defaults. */
export function resetLocalAppDraftChoices(
    current: LocalAppDraftChoiceSession,
    editorJson: string,
): LocalAppDraftChoiceSession {
    check(current);
    return session(current.action, editorJson, true, []);
}

/** Additional semantic guard only; callers must still apply the complete payload schema. */
export function assertLocalAppDraftChoiceConsistency(
    action: LocalAppAction,
    editorJson: string,
): void {
    const choices = declarations(action);
    if (!choices.length) return;
    const { records } = localAppDraftSource(action, editorJson);
    for (const record of records)
        for (const choice of choices) {
            const present = Object.hasOwn(record, choice.field);
            const option = present
                ? choice.options.find((item) => item.value === record[choice.field])
                : undefined;
            if (present && !option) fail();
            for (const assignment of option?.assign ?? choice.options[0].assign) {
                if (
                    option
                        ? !Object.hasOwn(record, assignment.field) ||
                          record[assignment.field] !== assignment.value
                        : Object.hasOwn(record, assignment.field)
                )
                    fail();
            }
        }
}
