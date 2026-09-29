import { describe, expect, it } from "vitest";
import type { LocalAppAction } from "./localAppCatalog";
import type { LocalDraftSchema } from "./localAppDrafts";
import type { LocalAppDraftScalar } from "./localAppDraftFields";
import {
    assertLocalAppDraftChoiceConsistency as consistent,
    editLocalAppDraftScalar as edit,
    initializeLocalAppDraftChoices as initialize,
    resetLocalAppDraftChoices as reset,
    selectLocalAppDraftChoice as select,
    validateLocalAppDraftEditor as validate,
    type DraftEditorV1,
} from "./localAppDraftChoices";

function fixture(kind: LocalAppAction["handoff"]["kind"] = "single"): LocalAppAction {
    const schema: LocalDraftSchema = {
        type: "object",
        additionalProperties: false,
        properties: {
            presetId: { type: "string" },
            presetLabel: { type: "string" },
            side: { type: "string" },
            category: { type: "string" },
            nil: { type: "null" },
            count: { type: "integer" },
            note: { type: "string" },
            nested: {
                type: "object",
                additionalProperties: false,
                properties: { keep: { type: "boolean" } },
            },
        },
    };
    const options = ["a", "b"].map((value) => ({
        value,
        label: `Choice ${value}`,
        assign: [{ field: "presetLabel", value: `Name ${value}` }],
        defaults: [
            { field: "side", value },
            { field: "nil", value: null },
        ],
    }));
    return {
        definition: {
            name: "sample",
            description: "Sample",
            promptTemplate: "Copy",
            responseSchema: {},
            card: {
                title: "Sample",
                rows: [{ label: "Side", valueKey: "side" }],
                confirmLabel: "Review",
                cancelLabel: "Cancel",
            },
        },
        handoff: kind === "wrapped-list" ? { kind, field: "records" } : { kind },
        draftSchema:
            kind === "single"
                ? schema
                : kind === "list"
                  ? { type: "array", items: schema }
                  : {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            records: { type: "array", items: schema },
                            envelope: { type: "string" },
                        },
                    },
        draftEditor: {
            version: 1,
            choices: [{ field: "presetId", label: "Preset", noneLabel: "None", options }],
        },
    };
}
const json = (value: unknown) => JSON.stringify(value);
const data = (state: { editorJson: string }) => JSON.parse(state.editorJson);
type MutableEditor = {
    version: number;
    extra?: boolean;
    choices: {
        field: string;
        label: string;
        noneLabel: string;
        extra?: boolean;
        options: {
            value: string;
            label: string;
            assign: { field: string; value: LocalAppDraftScalar }[];
            defaults: { field: string; value: LocalAppDraftScalar }[];
        }[];
    }[];
};

describe("generic named draft choice sessions", () => {
    it("initializes known choice once, preserving unrelated values and original baseline", () => {
        const action = fixture();
        const before = {
            presetId: "a",
            presetLabel: "untrusted",
            side: "original",
            category: "other",
            nested: { keep: true },
        };
        const state = initialize(action, json(before));
        expect(data(state)).toEqual({ ...before, presetLabel: "Name a", side: "a", nil: null });
        expect(data(select(select(state, 0, "presetId", "b"), 0, "presetId", undefined))).toEqual({
            side: "original",
            category: "other",
            nested: { keep: true },
        });
        expect(before.side).toBe("original");
        expect(Object.isFrozen(state)).toBe(true);
        expect(Object.isFrozen(state.rows[0].baseline)).toBe(true);
        expect(() => consistent(action, state.editorJson)).not.toThrow();
    });
    it("restores absence separately from null and remembers same-value human edits", () => {
        const action = fixture();
        const state = initialize(action, json({ presetId: "a", nil: null }));
        const cleared = data(select(state, 0, "presetId", undefined));
        expect(cleared).toEqual({ nil: null });
        const manual = edit(state, 0, "side", "a");
        expect(data(select(select(manual, 0, "presetId", "b"), 0, "presetId", undefined))).toEqual({
            nil: null,
            side: "a",
        });
    });
    it("preserves manual values entered before choosing, including absence", () => {
        const action = fixture();
        let state = initialize(action, json({ side: "original" }));
        state = edit(state, 0, "side", undefined);
        state = select(state, 0, "presetId", "b");
        expect(data(state)).not.toHaveProperty("side");
        expect(data(select(state, 0, "presetId", undefined))).not.toHaveProperty("side");
    });
    it.each(["list", "wrapped-list"] as const)(
        "isolates second item and preserves %s envelope",
        (kind) => {
            const action = fixture(kind);
            const records = [{ side: "first", nested: { keep: true } }, { side: "second" }];
            const state = initialize(
                action,
                json(kind === "list" ? records : { records, envelope: "retained" }),
            );
            const changed = data(select(state, 1, "presetId", "b"));
            const rows = kind === "list" ? changed : changed.records;
            expect(rows[0]).toEqual(records[0]);
            expect(rows[1]).toMatchObject({ side: "b", presetLabel: "Name b" });
            if (kind === "wrapped-list") expect(changed.envelope).toBe("retained");
            expect(
                data(select(select(state, 1, "presetId", "b"), 1, "presetId", undefined)),
            ).toEqual(data(state));
        },
    );
    it("preserves unknown selections and inconsistent missing choices but blocks review", () => {
        const action = fixture();
        for (const value of [
            { presetId: "foreign", presetLabel: "foreign", side: "keep" },
            { presetLabel: "orphan" },
        ]) {
            const state = initialize(action, json(value));
            expect(data(state)).toEqual(value);
            expect(() => consistent(action, state.editorJson)).toThrow();
            expect(() => select(state, 0, "presetId", "foreign")).toThrow();
            expect(() =>
                consistent(action, select(state, 0, "presetId", undefined).editorJson),
            ).not.toThrow();
        }
        for (const value of [{ presetId: "a" }, { presetId: "a", presetLabel: "wrong" }])
            expect(() => consistent(action, json(value))).toThrow();
    });
    it("forbids scalar edits of selector/companions but retains partial numbers", () => {
        const state = initialize(fixture(), json({ presetId: "a", count: 1 }));
        expect(() => edit(state, 0, "presetId", "b")).toThrow();
        expect(() => edit(state, 0, "presetLabel", "wrong")).toThrow();
        expect(data(edit(state, 0, "count", "-"))).toHaveProperty("count", "-");
        expect(data(edit(state, 0, "category", "manual"))).toHaveProperty("category", "manual");
    });
    it("invalid and oversized manual JSON reset history without reapplying defaults", () => {
        const action = fixture();
        const initial = initialize(action, json({ presetId: "a", side: "original" }));
        for (const invalid of ["{", "x".repeat(70_000)]) {
            const broken = reset(initial, invalid);
            expect(broken.editorJson).toBe(invalid);
            expect(broken.manual).toBe(true);
            expect(() => select(broken, 0, "presetId", "b")).toThrow();
            const recovered = reset(broken, initial.editorJson);
            expect(data(select(recovered, 0, "presetId", "b"))).toHaveProperty("side", "a");
            expect(data(select(recovered, 0, "presetId", undefined))).toHaveProperty("side", "a");
        }
    });
    it("row reorder and insertion never transfer another row's baseline", () => {
        const action = fixture("list");
        const initial = initialize(
            action,
            json([{ presetId: "a", side: "first" }, { side: "second" }]),
        );
        const reordered = reset(
            initial,
            json([{ side: "new" }, { side: "second" }, data(initial)[0]]),
        );
        expect(data(select(reordered, 2, "presetId", undefined))[2].side).toBe("a");
        expect(data(select(reordered, 0, "presetId", "b"))[0].side).toBe("new");
    });
    it("failed oversized choice edits are atomic and do not consume baseline state", () => {
        const action = fixture();
        const initial = initialize(action, json({ side: "original", note: "x".repeat(65_465) }));
        expect(() => select(initial, 0, "presetId", "a")).toThrow();
        expect(data(initial)).not.toHaveProperty("presetId");
        const recovered = edit(initial, 0, "note", "short");
        expect(
            data(select(select(recovered, 0, "presetId", "a"), 0, "presetId", undefined)).side,
        ).toBe("original");
    });
    it("detects mutation of bound action/schema and rejects invalid row indexes", () => {
        const action = fixture();
        const state = initialize(action, "{}");
        expect(() =>
            select({ ...state, editorJson: '{"side":"replaced"}' }, 0, "presetId", "a"),
        ).toThrow();
        for (const index of [-1, 1, 0.5, NaN])
            expect(() => select(state, index, "presetId", "a")).toThrow();
        Object.assign(action, { handoff: { kind: "list" } });
        expect(() => select(state, 0, "presetId", "a")).toThrow();
        expect(() => reset(state, "[]")).toThrow();
    });
    it("preserves legacy JSON shapes and raw text byte-for-byte without an editor", () => {
        const action = { ...fixture(), draftEditor: undefined };
        for (const value of ["null", "[1,2]", '"scalar"', "{invalid", "x".repeat(70_000)]) {
            expect(initialize(action, value).editorJson).toBe(value);
            expect(() => consistent(action, value)).not.toThrow();
        }
    });
});

describe("strict named choice declarations", () => {
    it("returns a frozen independent data snapshot", () => {
        const action = fixture();
        const result = validate(action.draftEditor, action.draftSchema, action.handoff);
        expect(result).toEqual(action.draftEditor);
        expect(result).not.toBe(action.draftEditor);
        expect(Object.isFrozen(result.choices[0].options[0].defaults)).toBe(true);
    });
    it.each([
        (x: MutableEditor) => {
            x.version = 2;
        },
        (x: MutableEditor) => {
            x.extra = true;
        },
        (x: MutableEditor) => {
            x.choices[0].extra = true;
        },
        (x: MutableEditor) => {
            x.choices[0].field = "__proto__";
        },
        (x: MutableEditor) => {
            x.choices[0].label = "hidden\u202e";
        },
        (x: MutableEditor) => {
            x.choices[0].options[1].value = "a";
        },
        (x: MutableEditor) => {
            x.choices[0].options[1].label = "Choice a";
        },
        (x: MutableEditor) => {
            x.choices[0].options[0].assign[0].field = "unknown";
        },
        (x: MutableEditor) => {
            x.choices[0].options[0].assign[0].field = "nested";
        },
        (x: MutableEditor) => {
            x.choices[0].options[0].defaults[0].field = "presetId";
        },
        (x: MutableEditor) => {
            x.choices[0].options[0].defaults[0].value = 1;
        },
        (x: MutableEditor) => {
            x.choices[0].options[1].defaults.pop();
        },
        (x: MutableEditor) => {
            x.choices.push(x.choices[0]);
        },
        (x: MutableEditor) => {
            x.choices[0].options[0].defaults.push(x.choices[0].options[0].defaults[0]);
        },
        (x: MutableEditor) => {
            x.choices[0].options = [];
        },
        (x: MutableEditor) => {
            x.choices = Array(9).fill(x.choices[0]);
        },
        (x: MutableEditor) => {
            x.choices[0].options = Array(65).fill(x.choices[0].options[0]);
        },
    ])("rejects unsafe or ambiguous declarations %d", (change) => {
        const action = fixture();
        const declaration = JSON.parse(json(action.draftEditor));
        change(declaration);
        expect(() => validate(declaration, action.draftSchema, action.handoff)).toThrow();
    });
    it("rejects required selectors/companions and non-object handoffs", () => {
        const action = fixture();
        for (const key of ["presetId", "presetLabel"])
            expect(() =>
                validate(
                    action.draftEditor,
                    { ...action.draftSchema, required: [key] } as LocalDraftSchema,
                    action.handoff,
                ),
            ).toThrow();
        expect(() =>
            validate(
                action.draftEditor,
                { type: "array", items: { type: "string" } },
                { kind: "list" },
            ),
        ).toThrow();
    });
    it("rejects cross-selector target conflicts even when another selector is declared later", () => {
        const action = fixture();
        const declaration = JSON.parse(json(action.draftEditor)) as MutableEditor;
        declaration.choices.push({ ...declaration.choices[0], field: "side" });
        expect(() =>
            validate(declaration as DraftEditorV1, action.draftSchema, action.handoff),
        ).toThrow();
    });
    it("rejects misleading None labels, excess assignments and oversized declarations", () => {
        const action = fixture();
        for (const change of [
            (value: MutableEditor) => {
                value.choices[0].options[0].label = value.choices[0].noneLabel;
            },
            (value: MutableEditor) => {
                value.choices[0].options[0].assign = Array(9).fill({
                    field: "presetLabel",
                    value: "x",
                });
            },
            (value: MutableEditor) => {
                value.choices[0].options[0].defaults[0].value = "x".repeat(65_536);
            },
        ]) {
            const value = JSON.parse(json(action.draftEditor)) as MutableEditor;
            change(value);
            expect(() => validate(value, action.draftSchema, action.handoff)).toThrow();
        }
    });
});
