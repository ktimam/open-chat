import { describe, expect, it } from "vitest";
import type { LocalAppAction } from "./localAppCatalog";
import type { LocalDraftSchema } from "./localAppDrafts";
import { validateLocalAppView as validate } from "./localAppView";

const single = { kind: "single" } as const;
const row: LocalDraftSchema = {
    type: "object",
    additionalProperties: false,
    required: ["quantity", "state"],
    properties: {
        quantity: { type: "number", minimum: 1 },
        state: { type: "string", enum: ["open", "closed"] },
        memo: { type: "string" },
        enabled: { type: "boolean" },
        empty: { type: "null" },
        detail: { type: "object", properties: {}, additionalProperties: false },
        tags: { type: "array", items: { type: "string" } },
    },
};
const field = (name: string) => ({ kind: "field", field: name });
const tree = (nodes: unknown[] = [field("quantity")]) => ({ version: 1, nodes });

describe("app-owned inert view contract", () => {
    it("preserves layout hints and canonical field bindings, not app-supplied values", () => {
        const input = {
            ...tree([
                { kind: "text", text: "Review these records", tone: "muted", size: "heading" },
                {
                    kind: "group",
                    surface: "card",
                    radius: "medium",
                    padding: "small",
                    gap: "medium",
                    children: [
                        {
                            kind: "row",
                            gap: "small",
                            children: [
                                { ...field("quantity"), minWidth: 96 },
                                { ...field("state"), minWidth: 124 },
                            ],
                        },
                        { ...field("memo"), fullWidth: true, control: "single-line" },
                    ],
                },
            ]),
            theme: { dark: { surface: "#181c22", text: "#EAF0F0", accent: "#5fe3b3" } },
        };
        const before = JSON.stringify(row);
        const result = validate(input, row, single);
        expect(result.view).toEqual(input);
        expect(result.referencedFields).toEqual(["quantity", "state", "memo"]);
        expect(result.unrepresentedRowFields).toEqual(["detail", "empty", "enabled", "tags"]);
        expect(result.unrepresentedEnvelopeFields).toEqual([]);
        expect(result.requiresCompleteHostReview).toBe(true);
        expect(JSON.stringify(row)).toBe(before);
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.view.nodes)).toBe(true);
        expect(Object.isFrozen(result.view.theme?.dark)).toBe(true);
        expect(Object.isFrozen(result.referencedFields)).toBe(true);
        input.theme.dark.accent = "#ffffff";
        input.nodes.push(field("enabled"));
        expect(result.view.theme?.dark?.accent).toBe("#5fe3b3");
        expect(result.view.nodes).toHaveLength(2);
    });

    it.each(["single", "list", "wrapped-list"] as const)(
        "treats references as per-entry bindings, not whole-payload coverage: %s",
        (kind) => {
            const mapping = kind === "wrapped-list" ? { kind, field: "records" } : { kind };
            const schema: LocalDraftSchema =
                kind === "single"
                    ? row
                    : kind === "list"
                      ? { type: "array", items: row }
                      : {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                                records: { type: "array", items: row },
                                envelopeLabel: { type: "string" },
                                privateContext: { type: "array", items: { type: "string" } },
                            },
                        };
            const result = validate(
                tree([field("quantity"), field("enabled"), field("empty")]),
                schema,
                mapping,
            );
            expect(result.referencedFields).toEqual(["quantity", "enabled", "empty"]);
            expect(result.unrepresentedRowFields).toContain("detail");
            expect(result.unrepresentedRowFields).toContain("tags");
            expect(result.unrepresentedEnvelopeFields).toEqual(
                kind === "wrapped-list" ? ["envelopeLabel", "privateContext"] : [],
            );
            expect(result.requiresCompleteHostReview).toBe(true);
            expect(() => validate(tree([field("envelopeLabel")]), schema, mapping)).toThrow();
        },
    );

    it("requires complete host review even for full coverage or a text-only view", () => {
        const schema = {
            type: "object",
            additionalProperties: false,
            properties: { memo: { type: "string" } },
        } as const;
        expect(validate(tree([field("memo")]), schema, single)).toMatchObject({
            unrepresentedRowFields: [],
            requiresCompleteHostReview: true,
        });
        expect(
            validate(tree([{ kind: "text", text: "No editable fields" }]), schema, single),
        ).toMatchObject({
            unrepresentedRowFields: ["memo"],
            requiresCompleteHostReview: true,
        });
    });

    it.each([
        { ...field("quantity"), value: 500 },
        { ...field("quantity"), default: 500 },
        { ...field("quantity"), label: "Something else" },
        { ...field("quantity"), hidden: true },
        { ...field("quantity"), disabled: false },
        { ...field("quantity"), readonly: false },
        { ...field("quantity"), onClick: "send" },
        { ...field("quantity"), event: "confirm" },
        { ...field("quantity"), src: "https://example.invalid/" },
        { ...field("quantity"), href: "javascript:alert(1)" },
        { ...field("quantity"), style: { color: "red" } },
        { kind: "html", html: "<input>" },
        { kind: "script", text: "alert(1)" },
        { kind: "button", action: "send" },
        { kind: "iframe", src: "https://example.invalid/" },
        { kind: "row", children: [field("quantity")], action: "submit" },
        { kind: "text", text: "Label", value: "secret" },
    ])("rejects executable, network, action or value override keys %#", (node) => {
        expect(() => validate(tree([node]), row, single)).toThrow();
    });

    it.each([
        field("unknown"),
        field("detail"),
        field("tags"),
        field("detail.value"),
        field("__proto__"),
        field("constructor"),
        field("prototype"),
        { ...field("quantity"), minWidth: 79 },
        { ...field("quantity"), minWidth: 321 },
        { ...field("quantity"), minWidth: 96.5 },
        { ...field("quantity"), minWidth: "96" },
        { ...field("quantity"), fullWidth: "true" },
        { ...field("quantity"), control: "single-line" },
        { ...field("state"), control: "multiline" },
        { ...field("memo"), control: "html" },
        { kind: "row", children: [field("quantity")], gap: "1px" },
        { kind: "group", children: [field("quantity")], surface: "url(x)" },
        { kind: "text", text: "x", size: "100px" },
    ])("rejects invalid references and layout/control hints %#", (node) => {
        expect(() => validate(tree([node]), row, single)).toThrow();
    });

    it("rejects duplicate references across nested groups, but permits all scalar types", () => {
        expect(() =>
            validate(
                tree([field("memo"), { kind: "row", children: [field("memo")] }]),
                row,
                single,
            ),
        ).toThrow();
        expect(
            validate(
                tree([
                    field("quantity"),
                    field("state"),
                    field("enabled"),
                    field("empty"),
                    { ...field("memo"), control: "multiline", minWidth: 320, fullWidth: false },
                ]),
                row,
                single,
            ).referencedFields,
        ).toHaveLength(5);
    });

    it.each([
        {},
        { light: {} },
        { light: { unknown: "#000000" } },
        { dark: { text: "red" } },
        { dark: { text: "#fff" } },
        { dark: { text: "#00000000" } },
        { dark: { text: "url(https://example.invalid/)" } },
        { dark: { text: "#000000;display:none" } },
        { dark: { text: "var(--secret)" } },
        { dark: { text: 123 } },
        { dark: { text: "#ffffff\n" } },
        { contrast: "normal" },
    ])("rejects unknown or non-hex theme values %#", (theme) => {
        expect(() => validate({ ...tree(), theme }, row, single)).toThrow();
    });

    it("does not treat a valid palette as accessibility or review authorization", () => {
        const result = validate(
            {
                ...tree(),
                theme: {
                    light: { field: "#ffffff", text: "#ffffff" },
                    dark: { background: "#000000", muted: "#000000", border: "#111111" },
                },
            },
            row,
            single,
        );
        expect(result.requiresCompleteHostReview).toBe(true);
    });

    it.each([
        "",
        " ",
        "x".repeat(513),
        "hidden\u200b",
        "reverse\u202e",
        "line\ntext",
        "nul\0",
        "\ud800",
    ])("rejects oversized/invisible/control app text %#", (text) => {
        expect(() => validate(tree([{ kind: "text", text }]), row, single)).toThrow();
    });

    it("preserves international and markup-looking text only as inert data", () => {
        const text = "<b>مرحبا 世界 😀</b> https://example.invalid/";
        expect(validate(tree([{ kind: "text", text }]), row, single).view.nodes[0]).toEqual({
            kind: "text",
            text,
        });
    });

    it("bounds depth, total nodes, sibling count and aggregate app text", () => {
        const text = () => ({ kind: "text", text: "x" });
        const nested = (depth: number): unknown =>
            depth === 1 ? text() : { kind: "group", children: [nested(depth - 1)] };
        expect(() => validate(tree([nested(6)]), row, single)).not.toThrow();
        expect(() => validate(tree([nested(7)]), row, single)).toThrow();
        expect(() => validate(tree(Array.from({ length: 32 }, text)), row, single)).not.toThrow();
        expect(() => validate(tree(Array.from({ length: 33 }, text)), row, single)).toThrow();
        const many = (last: number) =>
            tree(
                [31, 31, 31, last].map((count) => ({
                    kind: "row",
                    children: Array.from({ length: count }, text),
                })),
            );
        expect(() => validate(many(31), row, single)).not.toThrow(); // 4 + 124 = 128
        expect(() => validate(many(32), row, single)).toThrow();
        const texts = (count: number) =>
            tree(Array.from({ length: count }, () => ({ kind: "text", text: "x".repeat(512) })));
        expect(() => validate(texts(8), row, single)).not.toThrow();
        expect(() => validate(texts(9), row, single)).toThrow();
        expect(() => validate(tree([]), row, single)).toThrow();
        expect(() => validate(tree([{ kind: "row", children: [] }]), row, single)).toThrow();
    });

    it("rejects accessors without invoking them, including in schema and handoff", () => {
        let reads = 0;
        const node = Object.defineProperty({ kind: "field" }, "field", {
            enumerable: true,
            get() {
                reads++;
                return "quantity";
            },
        });
        expect(() => validate(tree([node]), row, single)).toThrow();
        const input = Object.defineProperty(tree(), "theme", {
            enumerable: true,
            get() {
                reads++;
                return {};
            },
        });
        expect(() => validate(input, row, single)).toThrow();
        const schema = Object.defineProperty({}, "type", {
            enumerable: true,
            get() {
                reads++;
                return "object";
            },
        });
        expect(() => validate(tree(), schema as LocalDraftSchema, single)).toThrow();
        const mapping = Object.defineProperty({}, "kind", {
            enumerable: true,
            get() {
                reads++;
                return "single";
            },
        });
        expect(() => validate(tree(), row, mapping as LocalAppAction["handoff"])).toThrow();
        expect(reads).toBe(0);
    });

    it("rejects inherited, non-enumerable, cyclic, sparse and non-JSON input", () => {
        const inherited = Object.assign(Object.create({ kind: "field" }), { field: "quantity" });
        const nonenumerable = Object.defineProperty(field("quantity"), "secret", { value: "x" });
        const symbol = { ...field("quantity"), [Symbol("x")]: "hidden" };
        const cycle: Record<string, unknown> = { kind: "group" };
        cycle.children = [cycle];
        for (const node of [
            inherited,
            nonenumerable,
            symbol,
            cycle,
            () => {},
            new Date(),
            { ...field("quantity"), minWidth: Infinity },
        ]) {
            expect(() => validate(tree([node]), row, single)).toThrow();
        }
        expect(() => validate(tree(new Array(1)), row, single)).toThrow();
        expect(() => validate({ ...tree(), version: 2 }, row, single)).toThrow();
        expect(() => validate({ ...tree(), mode: "editable" }, row, single)).toThrow();
        expect(() => validate({ ...tree(), onSend: "automatic" }, row, single)).toThrow();
    });

    it("requires a strict matching handoff and schema, without leaking field names in errors", () => {
        for (const mapping of [
            { kind: "single", field: "memo" },
            { kind: "unknown" },
            { kind: "wrapped-list", field: "missing" },
        ]) {
            expect(() => validate(tree(), row, mapping as LocalAppAction["handoff"])).toThrow();
        }
        expect(() => validate(tree([field("PRIVATE_MISSING_FIELD")]), row, single)).toThrow(
            "Invalid local app view",
        );
    });
});
