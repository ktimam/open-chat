import { describe, expect, it } from "vitest";
import {
    parseLocalAppCatalog,
    projectLocalAppPayload,
    type LocalAppAction,
} from "./localAppCatalog";
import { validateLocalAppDraftEditor } from "./localAppDraftChoices";
import { validateLocalAppDraftPresentation as validate } from "./localAppDraftPresentation";
import type { LocalDraftSchema } from "./localAppDrafts";

type Scalar = string | number | boolean | null;
type Presentation = {
    version: number;
    enumLabels: { field: string; options: { value: Scalar; label: string }[] }[];
};
const single = { kind: "single" } as const;
const rowSchema: LocalDraftSchema = {
    type: "object",
    additionalProperties: false,
    required: ["side", "category"],
    properties: {
        side: { type: "string", enum: ["incoming", "outgoing"] },
        category: { type: "string", enum: ["planned", "complete"] },
        preset: { type: "string" },
        presetName: { type: "string" },
        note: { type: "string" },
        nested: {
            type: "object",
            additionalProperties: false,
            properties: { side: { type: "string", enum: ["incoming", "outgoing"] } },
        },
        list: { type: "array", items: { type: "string" } },
    },
};
function presentation(): Presentation {
    return {
        version: 1,
        enumLabels: [
            {
                field: "side",
                options: [
                    { value: "incoming", label: "Incoming funds" },
                    { value: "outgoing", label: "Outgoing funds" },
                ],
            },
            {
                field: "category",
                options: [
                    { value: "planned", label: "Planned" },
                    { value: "complete", label: "Complete" },
                ],
            },
        ],
    };
}
function schemaFor(handoff: LocalAppAction["handoff"]): LocalDraftSchema {
    if (handoff.kind === "single") return rowSchema;
    const list: LocalDraftSchema = { type: "array", items: rowSchema, minItems: 1 };
    return handoff.kind === "list"
        ? list
        : {
              type: "object",
              additionalProperties: false,
              required: [handoff.field],
              properties: { [handoff.field]: list },
          };
}
function catalog(handoff: LocalAppAction["handoff"] = single) {
    return {
        version: 1,
        apps: [
            {
                id: "sample",
                revision: "v1",
                name: "Sample",
                description: "Synthetic app",
                destination: "https://example.invalid/import",
                actions: [
                    {
                        definition: {
                            name: "sample.save",
                            description: "Synthetic action",
                            promptTemplate: "Copy the visible values.",
                            responseSchema: rowSchema,
                            card: {
                                title: "Review",
                                rows: [{ label: "Side", valueKey: "side" }],
                                confirmLabel: "Send",
                                cancelLabel: "Cancel",
                            },
                        },
                        draftSchema: schemaFor(handoff),
                        handoff,
                    },
                ],
            },
        ],
    };
}
function scalarCase(property: LocalDraftSchema, values: Scalar[]) {
    return {
        schema: {
            type: "object",
            additionalProperties: false,
            required: ["value"],
            properties: { value: property },
        } satisfies LocalDraftSchema,
        declaration: {
            version: 1,
            enumLabels: [
                {
                    field: "value",
                    options: values.map((value, index) => ({ value, label: `Option ${index}` })),
                },
            ],
        },
    };
}
function boundedCase(fields: number, options: number) {
    const values = Array.from({ length: options }, (_, index) => `v${index}`);
    const names = Array.from({ length: fields }, (_, index) => `field${index}`);
    return {
        schema: {
            type: "object",
            additionalProperties: false,
            properties: Object.fromEntries(
                names.map((name) => [name, { type: "string", enum: values }]),
            ),
        } as LocalDraftSchema,
        declaration: {
            version: 1,
            enumLabels: names.map((field) => ({
                field,
                options: values.map((value) => ({ value, label: `Label ${value}` })),
            })),
        },
    };
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe("generic label-only draft presentation", () => {
    it.each(["single", "list", "wrapped-list"] as const)(
        "allows required scalar enums in the %s row without changing their schema",
        (kind) => {
            const handoff = kind === "wrapped-list" ? { kind, field: "records" } : { kind };
            const schema = schemaFor(handoff);
            const before = JSON.stringify(schema);
            expect(validate(presentation(), schema, handoff)).toEqual(presentation());
            expect(JSON.stringify(schema)).toBe(before);
        },
    );
    it.each([
        { type: "string", values: ["", "0", "false", "null"] },
        { type: "number", values: [-1.5, 0, 2.5] },
        { type: "integer", values: [-2, 0, 2] },
        { type: "boolean", values: [false, true] },
        { type: "null", values: [null] },
    ] as const)("preserves exact $type scalar values", ({ type, values }) => {
        const fixture = scalarCase({ type, enum: values }, [...values]);
        expect(validate(fixture.declaration, fixture.schema, single)).toEqual(fixture.declaration);
    });
    it("accepts exact coverage in an app-declared order and a subset of enum fields", () => {
        const value = presentation();
        value.enumLabels = [value.enumLabels[0]];
        value.enumLabels[0].options.reverse();
        expect(validate(value, rowSchema, single)).toEqual(value);
    });
    it("clones and deeply freezes safe JSON without freezing caller-owned data", () => {
        const input = presentation();
        const result = validate(input, rowSchema, single);
        expect(result).toEqual(input);
        expect(result).not.toBe(input);
        expect(result.enumLabels).not.toBe(input.enumLabels);
        for (const value of [
            result,
            result.enumLabels,
            result.enumLabels[0],
            result.enumLabels[0].options,
            result.enumLabels[0].options[0],
        ])
            expect(Object.isFrozen(value)).toBe(true);
        expect(Object.isFrozen(input)).toBe(false);
        input.enumLabels[0].options[0].label = "Changed later";
        expect(result.enumLabels[0].options[0].label).toBe("Incoming funds");
        expect(
            validate(Object.assign(Object.create(null), presentation()), rowSchema, single),
        ).toEqual(presentation());
    });
    it("permits ordinary Unicode and markup only as inert label text", () => {
        const value = presentation();
        value.enumLabels[0].options[0].label = "مبلغ مستحق — 金額 <b>text</b>";
        expect(validate(value, rowSchema, single)).toEqual(value);
    });

    it.each([
        ["wrong version", (x: Presentation): unknown => (x.version = 2)],
        ["extra root key", (x: Presentation) => Object.assign(x, { extra: true })],
        ["extra field key", (x: Presentation) => Object.assign(x.enumLabels[0], { label: "Side" })],
        [
            "extra option key",
            (x: Presentation) => Object.assign(x.enumLabels[0].options[0], { assign: [] }),
        ],
        [
            "missing options",
            (x: Presentation) => Reflect.deleteProperty(x.enumLabels[0], "options"),
        ],
        [
            "missing label",
            (x: Presentation) => Reflect.deleteProperty(x.enumLabels[0].options[0], "label"),
        ],
        [
            "missing value",
            (x: Presentation) => Reflect.deleteProperty(x.enumLabels[0].options[0], "value"),
        ],
        ["unknown field", (x: Presentation): unknown => (x.enumLabels[0].field = "absent")],
        ["non-enum scalar", (x: Presentation): unknown => (x.enumLabels[0].field = "note")],
        ["object field", (x: Presentation): unknown => (x.enumLabels[0].field = "nested")],
        ["array field", (x: Presentation): unknown => (x.enumLabels[0].field = "list")],
        ["nested path", (x: Presentation): unknown => (x.enumLabels[0].field = "nested.side")],
        ["forbidden field", (x: Presentation): unknown => (x.enumLabels[0].field = "__proto__")],
        ["duplicate fields", (x: Presentation) => x.enumLabels.push(x.enumLabels[0])],
        ["missing enum value", (x: Presentation) => x.enumLabels[0].options.pop()],
        [
            "foreign enum value",
            (x: Presentation): unknown => (x.enumLabels[0].options[0].value = "foreign"),
        ],
        [
            "wrong scalar type",
            (x: Presentation): unknown => (x.enumLabels[0].options[0].value = false),
        ],
        [
            "duplicate values",
            (x: Presentation): unknown => (x.enumLabels[0].options[1].value = "incoming"),
        ],
        [
            "duplicate labels",
            (x: Presentation): unknown => (x.enumLabels[0].options[1].label = "Incoming funds"),
        ],
        ["empty fields", (x: Presentation) => (x.enumLabels = [])],
        ["empty options", (x: Presentation) => (x.enumLabels[0].options = [])],
        [
            "non-string label",
            (x: Presentation) => Object.assign(x.enumLabels[0].options[0], { label: 1 }),
        ],
    ] as const)("rejects %s", (_name, mutate) => {
        const value = presentation();
        mutate(value);
        expect(() => validate(value, rowSchema, single)).toThrow();
    });
    it.each([null, false, 1, "presentation", [], {}, { version: 1, enumLabels: null }])(
        "rejects non-declarations %#",
        (value) => expect(() => validate(value, rowSchema, single)).toThrow(),
    );
    it.each([
        "",
        " ",
        " leading",
        "trailing ",
        "tab\tlabel",
        "line\nlabel",
        "null\u0000label",
        "delete\u007flabel",
        "c1\u0085label",
        "hidden\u200blabel",
        "bidi\u202elabel",
        "x".repeat(129),
    ])("rejects empty, untrimmed, controlled or oversized labels %#", (label) => {
        const value = presentation();
        value.enumLabels[0].options[0].label = label;
        expect(() => validate(value, rowSchema, single)).toThrow();
    });
    it.each([
        { property: { type: "string", enum: ["short"], minLength: 6 }, values: ["short"] },
        { property: { type: "string", enum: ["long"], maxLength: 3 }, values: ["long"] },
        { property: { type: "number", enum: [-1], minimum: 0 }, values: [-1] },
        { property: { type: "number", enum: [2], maximum: 1 }, values: [2] },
        { property: { type: "integer", enum: [0.5] }, values: [0.5] },
        { property: { type: "boolean", enum: ["false"] }, values: ["false"] },
        { property: { type: "null", enum: ["null"] }, values: ["null"] },
    ] satisfies { property: LocalDraftSchema; values: Scalar[] }[])(
        "rejects enum members violating the field's actual schema %#",
        ({ property, values }) => {
            const fixture = scalarCase(property, values);
            expect(() => validate(fixture.declaration, fixture.schema, single)).toThrow();
        },
    );
    it("does not coerce numeric, boolean or null enum options from strings", () => {
        for (const [property, values] of [
            [{ type: "number", enum: [0] }, ["0"]],
            [{ type: "boolean", enum: [false] }, ["false"]],
            [{ type: "null", enum: [null] }, ["null"]],
        ] as [LocalDraftSchema, Scalar[]][]) {
            const fixture = scalarCase(property, values);
            expect(() => validate(fixture.declaration, fixture.schema, single)).toThrow();
        }
    });
    it("rejects non-object rows and a wrapper field mistaken for a row field", () => {
        expect(() => validate(presentation(), { type: "string" }, single)).toThrow();
        expect(() =>
            validate(
                presentation(),
                { type: "array", items: { type: "string" } },
                { kind: "list" },
            ),
        ).toThrow();
        const value = presentation();
        value.enumLabels[0].field = "records";
        const handoff = { kind: "wrapped-list", field: "records" } as const;
        expect(() => validate(value, schemaFor(handoff), handoff)).toThrow();
    });
});

describe("draft presentation safe JSON and resource bounds", () => {
    it.each([
        ["custom prototype", (x: Presentation) => Object.setPrototypeOf(x, { inherited: true })],
        [
            "option prototype",
            (x: Presentation) =>
                Object.setPrototypeOf(x.enumLabels[0].options[0], { inherited: true }),
        ],
        [
            "symbol key",
            (x: Presentation) => Object.defineProperty(x, Symbol("hidden"), { value: 1 }),
        ],
        ["hidden own key", (x: Presentation) => Object.defineProperty(x, "hidden", { value: 1 })],
        [
            "own proto key",
            (x: Presentation) =>
                Object.defineProperty(x, "__proto__", { value: {}, enumerable: true }),
        ],
        ["sparse fields", (x: Presentation) => Reflect.deleteProperty(x.enumLabels, "0")],
        [
            "sparse options",
            (x: Presentation) => Reflect.deleteProperty(x.enumLabels[0].options, "0"),
        ],
        [
            "array extra key",
            (x: Presentation) => Object.assign(x.enumLabels[0].options, { extra: true }),
        ],
        ["nonfinite value", (x: Presentation) => (x.enumLabels[0].options[0].value = Infinity)],
        [
            "undefined value",
            (x: Presentation) => Object.assign(x.enumLabels[0].options[0], { value: undefined }),
        ],
        [
            "object value",
            (x: Presentation) => Object.assign(x.enumLabels[0].options[0], { value: {} }),
        ],
        [
            "array value",
            (x: Presentation) => Object.assign(x.enumLabels[0].options[0], { value: [] }),
        ],
    ] as const)("rejects unsafe JSON: %s", (_name, mutate) => {
        const value = presentation();
        mutate(value);
        expect(() => validate(value, rowSchema, single)).toThrow();
    });
    it("rejects accessors without executing them, including array indexes", () => {
        for (const location of ["root", "option", "index"] as const) {
            const value = presentation();
            let reads = 0;
            const target =
                location === "root"
                    ? value
                    : location === "option"
                      ? value.enumLabels[0].options[0]
                      : value.enumLabels[0].options;
            const key = location === "root" ? "version" : location === "option" ? "label" : "0";
            Object.defineProperty(target, key, {
                enumerable: true,
                get() {
                    reads++;
                    throw new Error("Accessor must not execute");
                },
            });
            expect(() => validate(value, rowSchema, single)).toThrow();
            expect(reads).toBe(0);
        }
    });
    it("accepts the field, option and label limits and rejects one beyond each", () => {
        for (const [fields, options] of [
            [32, 1],
            [1, 64],
        ]) {
            const fixture = boundedCase(fields, options);
            fixture.declaration.enumLabels[0].options[0].label = "x".repeat(128);
            expect(validate(fixture.declaration, fixture.schema, single)).toEqual(
                fixture.declaration,
            );
        }
        for (const [fields, options] of [
            [33, 1],
            [1, 65],
        ]) {
            const fixture = boundedCase(fields, options);
            expect(() => validate(fixture.declaration, fixture.schema, single)).toThrow();
        }
    });
    it("enforces the exact 64 KiB serialized declaration boundary", () => {
        const fixture = boundedCase(8, 64);
        let remaining = 65_536 - bytes(fixture.declaration);
        for (const field of fixture.declaration.enumLabels) {
            for (const option of field.options) {
                const added = Math.min(128 - option.label.length, remaining);
                option.label += "x".repeat(added);
                remaining -= added;
            }
        }
        expect(remaining).toBe(0);
        expect(bytes(fixture.declaration)).toBe(65_536);
        expect(validate(fixture.declaration, fixture.schema, single)).toEqual(fixture.declaration);
        const spare = fixture.declaration.enumLabels
            .flatMap((field) => field.options)
            .find((option) => option.label.length < 128)!;
        spare.label += "x";
        expect(bytes(fixture.declaration)).toBe(65_537);
        expect(() => validate(fixture.declaration, fixture.schema, single)).toThrow();
    });
    it("counts UTF-8 bytes rather than JavaScript character count", () => {
        const fixture = boundedCase(4, 64);
        for (const field of fixture.declaration.enumLabels)
            for (const option of field.options) option.label += "界".repeat(100);
        expect(JSON.stringify(fixture.declaration).length).toBeLessThan(65_536);
        expect(bytes(fixture.declaration)).toBeGreaterThan(65_536);
        expect(() => validate(fixture.declaration, fixture.schema, single)).toThrow();
    });
});

describe("draft presentation catalog compatibility", () => {
    it.each(["single", "list", "wrapped-list"] as const)(
        "imports %s presentation as immutable metadata, never projected DTO data",
        (kind) => {
            const handoff = kind === "wrapped-list" ? { kind, field: "records" } : { kind };
            const input = catalog(handoff);
            const original = input.apps[0].actions[0];
            const oldAction = parseLocalAppCatalog(JSON.stringify(input)).apps[0].actions[0];
            expect(oldAction).not.toHaveProperty("draftPresentation");
            Object.assign(original, { draftPresentation: presentation() });
            const action = parseLocalAppCatalog(JSON.stringify(input)).apps[0].actions[0];
            expect(action.draftPresentation).toEqual(presentation());
            expect(Object.isFrozen(action.draftPresentation?.enumLabels[0].options[0])).toBe(true);
            expect(action.definition).toEqual(oldAction.definition);
            expect(action.draftSchema).toEqual(oldAction.draftSchema);
            const records = [{ side: "incoming", category: "planned", note: "Keep exact source" }];
            const payload = projectLocalAppPayload(action, records);
            expect(payload).toEqual(projectLocalAppPayload(oldAction, records));
            expect(payload).toEqual(
                kind === "single" ? records[0] : kind === "list" ? records : { records },
            );
            expect(JSON.stringify(payload)).not.toContain("Incoming funds");
            expect(JSON.stringify(payload)).not.toContain("draftPresentation");
            expect(() =>
                projectLocalAppPayload(action, [{ ...records[0], side: "Incoming funds" }]),
            ).toThrow();
            expect(() =>
                projectLocalAppPayload(action, [
                    { ...records[0], draftPresentation: presentation() },
                ]),
            ).toThrow();
        },
    );
    it("rejects invalid presentation when parsing a catalog instead of silently dropping it", () => {
        for (const invalid of [null, {}, { ...presentation(), version: 2 }]) {
            const input = catalog();
            Object.assign(input.apps[0].actions[0], { draftPresentation: invalid });
            expect(() => parseLocalAppCatalog(JSON.stringify(input))).toThrow();
        }
        const input = catalog();
        const incomplete = presentation();
        incomplete.enumLabels[0].options.pop();
        Object.assign(input.apps[0].actions[0], { draftPresentation: incomplete });
        expect(() => parseLocalAppCatalog(JSON.stringify(input))).toThrow();
    });
    it("coexists with a named choice's direction-like defaults without relaxing choice rules", () => {
        const input = catalog();
        const editor = {
            version: 1,
            choices: [
                {
                    field: "preset",
                    label: "Saved preset",
                    noneLabel: "None",
                    options: [
                        {
                            value: "saved",
                            label: "Saved name",
                            assign: [{ field: "presetName", value: "Saved name" }],
                            defaults: [{ field: "side", value: "outgoing" }],
                        },
                    ],
                },
            ],
        };
        Object.assign(input.apps[0].actions[0], {
            draftPresentation: presentation(),
            draftEditor: editor,
        });
        const action = parseLocalAppCatalog(JSON.stringify(input)).apps[0].actions[0];
        expect(action.draftEditor).toEqual(editor);
        expect(action.draftPresentation).toEqual(presentation());
        const requiredSelector = {
            version: 1,
            choices: [
                {
                    field: "side",
                    label: "Side",
                    noneLabel: "None",
                    options: [
                        { value: "incoming", label: "Incoming funds", assign: [], defaults: [] },
                    ],
                },
            ],
        };
        expect(() =>
            validateLocalAppDraftEditor(requiredSelector, action.draftSchema, single),
        ).toThrow();
        Object.assign(input.apps[0].actions[0], { draftEditor: requiredSelector });
        expect(() => parseLocalAppCatalog(JSON.stringify(input))).toThrow();
    });
});
