import { describe, expect, it } from "vitest";
import type { LocalAppAction } from "./localAppCatalog";
import { snapshotLocalDraftPayload, type LocalDraftSchema } from "./localAppDrafts";
import {
    editLocalAppDraftField,
    localAppDraftFields,
    localDraftNumericInput,
    localAppDraftSource,
    replaceLocalAppDraftRecords,
} from "./localAppDraftFields";

const itemSchema: LocalDraftSchema = {
    type: "object",
    additionalProperties: false,
    required: ["text", "count"],
    properties: {
        text: { type: "string", minLength: 1 },
        count: { type: "integer", minimum: 0 },
        option: { type: "string", enum: ["first", "second"] },
        enabled: { type: "boolean" },
        numberChoice: { type: "number", enum: [0, 2] },
        empty: { type: "string" },
        nil: { type: "null" },
        nested: {
            type: "object",
            additionalProperties: false,
            properties: { value: { type: "string" } },
        },
    },
};

function action(handoff: LocalAppAction["handoff"] = { kind: "single" }): LocalAppAction {
    const list: LocalDraftSchema = { type: "array", items: itemSchema, minItems: 1, maxItems: 32 };
    return {
        definition: {
            name: "synthetic.edit",
            description: "Synthetic",
            promptTemplate: "Copy",
            responseSchema: {},
            card: {
                title: "Draft",
                confirmLabel: "Review",
                cancelLabel: "Cancel",
                rows: [
                    { label: "Count first", valueKey: "count" },
                    { label: "Text", valueKey: "text" },
                    { label: "Not in schema", valueKey: "absent" },
                ],
            },
        },
        handoff,
        draftSchema:
            handoff.kind === "single"
                ? itemSchema
                : handoff.kind === "list"
                  ? list
                  : {
                        type: "object",
                        additionalProperties: false,
                        required: [handoff.field],
                        properties: { [handoff.field]: list, envelope: { type: "string" } },
                    },
    };
}
const item = () => ({
    text: "original",
    count: 0,
    enabled: false,
    empty: "",
    nil: null,
    nested: { value: "retained" },
});

describe("generic local draft field projection", () => {
    it("shared traversal retains envelope values and enforces row cardinality", () => {
        const definition = action({ kind: "wrapped-list", field: "records" });
        const projected = localAppDraftSource(
            definition,
            JSON.stringify({ records: [item()], envelope: "keep" }),
        );
        expect(
            JSON.parse(
                replaceLocalAppDraftRecords(definition, projected.payload, [
                    { ...projected.records[0], count: 2 },
                ]),
            ),
        ).toMatchObject({ records: [{ count: 2 }], envelope: "keep" });
        expect(() => replaceLocalAppDraftRecords(definition, projected.payload, [])).toThrow();
        expect(() =>
            replaceLocalAppDraftRecords(definition, projected.payload, Array(33).fill(item())),
        ).toThrow();
        expect(() => replaceLocalAppDraftRecords(action(), item(), [item(), item()])).toThrow();
    });
    it.each(["single", "list", "wrapped-list"] as const)(
        "supports %s without inferring values",
        (kind) => {
            const definition = action(
                kind === "wrapped-list" ? { kind, field: "records" } : { kind },
            );
            const records = [item(), { ...item(), text: "second" }];
            const payload =
                kind === "single"
                    ? records[0]
                    : kind === "list"
                      ? records
                      : { records, envelope: "unchanged" };
            const json = JSON.stringify(payload);
            const projected = localAppDraftFields(definition, json)!;
            expect(projected.valid).toBe(true);
            expect(projected.items).toHaveLength(kind === "single" ? 1 : 2);
            expect(projected.items[0].map((field) => field.key).slice(0, 2)).toEqual([
                "count",
                "text",
            ]);
            expect(projected.items[0].find((field) => field.key === "count")).toMatchObject({
                label: "Count first",
                value: 0,
                valid: true,
            });
            expect(projected.items[0].find((field) => field.key === "option")).toMatchObject({
                present: false,
                value: undefined,
                valid: true,
            });
            expect(projected.items[0].find((field) => field.key === "enabled")).toMatchObject({
                present: true,
                value: false,
            });
            expect(projected.items[0].find((field) => field.key === "empty")).toMatchObject({
                present: true,
                value: "",
            });
            expect(projected.items[0].find((field) => field.key === "nil")).toMatchObject({
                present: true,
                value: null,
            });
            expect(
                projected.items[0].some(
                    (field) => field.key === "nested" || field.key === "absent",
                ),
            ).toBe(false);
            expect(projected.hasOtherFields).toBe(true);
            const changed = JSON.parse(
                editLocalAppDraftField(
                    definition,
                    json,
                    kind === "single" ? 0 : 1,
                    "text",
                    "edited",
                ),
            );
            const changedRecords =
                kind === "single" ? [changed] : kind === "list" ? changed : changed.records;
            expect(changedRecords[kind === "single" ? 0 : 1].text).toBe("edited");
            if (kind !== "single") expect(changedRecords[0]).toEqual(records[0]);
            if (kind === "wrapped-list") expect(changed.envelope).toBe("unchanged");
            expect(changedRecords[0].nested).toEqual(records[0].nested);
            expect(JSON.parse(json)).toEqual(payload);
        },
    );

    it("keeps missing/invalid fields editable using only current data", () => {
        const projection = localAppDraftFields(
            action(),
            JSON.stringify({ text: "new", count: "-", option: "missing" }),
        )!;
        expect(projection.valid).toBe(false);
        expect(projection.items[0].find((field) => field.key === "count")).toMatchObject({
            value: "-",
            valid: false,
        });
        expect(projection.items[0].find((field) => field.key === "option")).toMatchObject({
            value: "missing",
            valid: false,
        });
        const missing = localAppDraftFields(action(), "{}")!;
        expect(missing.items[0].find((field) => field.key === "count")).toMatchObject({
            required: true,
            present: false,
            valid: false,
        });
        expect(localAppDraftFields(action(), "{broken")).toBeUndefined();
    });

    it("preserves unknown fields rather than silently dropping invalid data", () => {
        const source = JSON.stringify({ ...item(), unknown: { secret: "keep" } });
        expect(localAppDraftFields(action(), source)).toMatchObject({
            valid: false,
            hasOtherFields: true,
        });
        const changed = JSON.parse(editLocalAppDraftField(action(), source, 0, "count", 12));
        expect(changed.unknown).toEqual({ secret: "keep" });
        expect(() => snapshotLocalDraftPayload(changed, action().draftSchema)).toThrow();
    });

    it("omission differs from false, zero, empty and null", () => {
        let json = JSON.stringify(item());
        for (const [key, value] of [
            ["enabled", false],
            ["count", 0],
            ["empty", ""],
            ["nil", null],
        ] as const) {
            json = editLocalAppDraftField(action(), json, 0, key, undefined);
            expect(Object.hasOwn(JSON.parse(json), key)).toBe(false);
            json = editLocalAppDraftField(action(), json, 0, key, value);
            expect(Object.hasOwn(JSON.parse(json), key)).toBe(true);
            expect(JSON.parse(json)[key]).toBe(value);
        }
    });

    it.each(["", "-", "1.", "1e", "1e+", "01", " ", "Infinity", "1e999"])(
        "does not coerce partial numeric text %j to a number",
        (text) => {
            expect(localDraftNumericInput(text)).toBe(text);
            const json = editLocalAppDraftField(
                action(),
                JSON.stringify(item()),
                0,
                "count",
                localDraftNumericInput(text),
            );
            expect(JSON.parse(json).count).toBe(text);
            expect(localAppDraftFields(action(), json)?.valid).toBe(false);
        },
    );

    it.each([
        ["0", 0],
        ["12.5", 12.5],
        ["-4", -4],
        ["1e2", 100],
    ] as const)("parses complete numeric text %s", (text, value) => {
        expect(localDraftNumericInput(text)).toBe(value);
    });

    it("escapes hidden controls in app labels and raw schema keys", () => {
        const definition = action();
        definition.definition.card.rows[0].label = "Count\u202ehidden\u0001";
        const key = "extra\u200b";
        const schema = {
            ...itemSchema,
            properties: { ...itemSchema.properties, [key]: { type: "string" as const } },
        };
        const projected = localAppDraftFields(
            { ...definition, draftSchema: schema },
            JSON.stringify(item()),
        )!;
        expect(projected.items[0][0].label).toBe("Count\\u202ehidden\\u0001");
        expect(projected.items[0].find((field) => field.key === key)?.label).toBe("extra\\u200b");
    });

    it.each(["null", "[]", "1", '{"constructor":{}}', JSON.stringify({ text: "x".repeat(65536) })])(
        "rejects unsafe or oversized structure",
        (json) => {
            expect(localAppDraftFields(action(), json)).toBeUndefined();
            expect(() => editLocalAppDraftField(action(), json, 0, "count", 1)).toThrow();
        },
    );

    it("rejects oversized edits, dangerous keys and non-scalar/unknown destinations", () => {
        const json = JSON.stringify(item());
        expect(() =>
            editLocalAppDraftField(action(), json, 0, "text", "x".repeat(65536)),
        ).toThrow();
        for (const key of ["__proto__", "constructor", "nested", "unknown"])
            expect(() => editLocalAppDraftField(action(), json, 0, key, "x")).toThrow();
        expect(() => editLocalAppDraftField(action(), json, 1, "count", 1)).toThrow();
        expect(() => editLocalAppDraftField(action(), json, 0, "count", Infinity)).toThrow();
        expect(JSON.parse(json)).toEqual(item());
    });

    it("blocks a small edit when visible escaping would exceed the editor byte limit", () => {
        const json = JSON.stringify({ ...item(), text: "\u200b".repeat(11000) });
        expect(new TextEncoder().encode(json).byteLength).toBeLessThan(64 * 1024);
        expect(localAppDraftFields(action(), json)).toBeDefined();
        expect(() => editLocalAppDraftField(action(), json, 0, "count", 2)).toThrow();
        // The caller retains the original bounded payload and enters its pending-edit guard.
        expect(JSON.parse(json).text).toBe("\u200b".repeat(11000));
    });

    it("rejects inconsistent mappings, mixed lists and excessive item counts", () => {
        expect(
            localAppDraftFields(
                { ...action(), handoff: { kind: "list" } },
                JSON.stringify([item()]),
            ),
        ).toBeUndefined();
        const definition = action({ kind: "list" });
        for (const items of [[], [item(), null], Array.from({ length: 33 }, item)])
            expect(localAppDraftFields(definition, JSON.stringify(items))).toBeUndefined();
    });
});
