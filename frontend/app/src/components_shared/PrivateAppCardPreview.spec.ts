// @vitest-environment jsdom
import { flushSync, mount, tick, unmount } from "svelte";
import { fromStore, writable } from "svelte/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import PrivateAppCardPreview from "./PrivateAppCardPreview.svelte";
import { localAppCardPreview } from "../utils/localAppCardPreview";
import type { LocalAppAction } from "../utils/localAppCatalog";
import type { LocalDraftSchema } from "../utils/localAppDrafts";

const itemSchema: LocalDraftSchema = {
    type: "object",
    additionalProperties: false,
    required: ["value", "count"],
    properties: {
        value: { type: "string" },
        count: { type: "integer", minimum: 0 },
        optional: { type: "string" },
        nil: { type: "null" },
        enabled: { type: "boolean" },
        empty: { type: "string" },
        other: { type: "string" },
        nested: {
            type: "object",
            additionalProperties: false,
            required: ["items"],
            properties: { items: { type: "array", items: { type: "string" } } },
        },
    },
};
const listSchema: LocalDraftSchema = {
    type: "array",
    items: itemSchema,
    minItems: 1,
    maxItems: 32,
};

function action(handoff: LocalAppAction["handoff"] = { kind: "single" }): LocalAppAction {
    return {
        definition: {
            name: "synthetic.review",
            description: "Synthetic action",
            promptTemplate: "Copy supplied data",
            responseSchema: { type: "object" },
            card: {
                title: "App-authored title",
                disclosure: "App-authored disclosure",
                confirmLabel: "Preview only",
                cancelLabel: "Hide",
                rows: [
                    { label: "Count first", valueKey: "count" },
                    { label: "Value second", valueKey: "value" },
                    { label: "Optional", valueKey: "optional" },
                    { label: "Null", valueKey: "nil" },
                    { label: "Boolean", valueKey: "enabled" },
                    { label: "Empty", valueKey: "empty" },
                    { label: "Nested", valueKey: "nested" },
                ],
            },
        },
        handoff,
        draftSchema:
            handoff.kind === "single"
                ? itemSchema
                : handoff.kind === "list"
                  ? listSchema
                  : {
                        type: "object",
                        additionalProperties: false,
                        required: [handoff.field],
                        properties: {
                            [handoff.field]: listSchema,
                            envelopeNote: { type: "string" },
                        },
                    },
    };
}

const item = (value = "SYNTHETIC VALUE") => ({
    value,
    count: 0,
    nil: null,
    enabled: false,
    empty: "",
    nested: { items: ["one", "two"] },
    other: "ADDITIONAL ITEM FIELD",
});

let instances: ReturnType<typeof mount>[] = [];
function render(definition: LocalAppAction, initial: string) {
    const target = document.createElement("div");
    document.body.append(target);
    const editor = writable(initial);
    const reactiveEditor = fromStore(editor);
    instances.push(
        mount(PrivateAppCardPreview, {
            target,
            props: {
                action: definition,
                get editorJson() {
                    return reactiveEditor.current;
                },
            },
        }),
    );
    flushSync();
    return {
        target,
        update: async (next: string) => {
            editor.set(next);
            await tick();
            flushSync();
        },
    };
}
afterEach(async () => {
    for (const instance of instances) await unmount(instance);
    instances = [];
    document.body.replaceChildren();
    vi.unstubAllGlobals();
});

describe("generic app-declared preview projection", () => {
    it("keeps declared order and distinguishes missing, null, false, zero and empty without coercion", () => {
        const input = item();
        const preview = localAppCardPreview(action(), JSON.stringify(input));
        expect(preview?.items[0]).toEqual([
            { label: "Count first", key: "count", value: "0", declared: true },
            { label: "Value second", key: "value", value: '"SYNTHETIC VALUE"', declared: true },
            { label: "Optional", key: "optional", value: "Not supplied", declared: true },
            { label: "Null", key: "nil", value: "null", declared: true },
            { label: "Boolean", key: "enabled", value: "false", declared: true },
            { label: "Empty", key: "empty", value: '""', declared: true },
            {
                label: "Nested",
                key: "nested",
                value: JSON.stringify(input.nested, null, 2),
                declared: true,
            },
            { label: "other", key: "other", value: '"ADDITIONAL ITEM FIELD"', declared: false },
        ]);
        expect(preview?.envelope).toEqual([]);
        expect(input).toEqual(item());
    });

    it.each(["single", "list", "wrapped-list"] as const)(
        "maps %s without knowing application field names",
        (kind) => {
            const definition = action(
                kind === "wrapped-list" ? { kind, field: "customRecords" } : { kind },
            );
            const records = [item("FIRST"), item("SECOND")];
            const payload =
                kind === "single"
                    ? records[0]
                    : kind === "list"
                      ? records
                      : { customRecords: records, envelopeNote: "VISIBLE ENVELOPE FIELD" };
            const preview = localAppCardPreview(definition, JSON.stringify(payload));
            expect(preview?.items).toHaveLength(kind === "single" ? 1 : 2);
            expect(
                preview?.items.map((rows) => rows.find((row) => row.key === "value")?.value),
            ).toEqual(kind === "single" ? ['"FIRST"'] : ['"FIRST"', '"SECOND"']);
            expect(preview?.envelope).toEqual(
                kind === "wrapped-list"
                    ? [
                          {
                              label: "envelopeNote",
                              key: "envelopeNote",
                              value: '"VISIBLE ENVELOPE FIELD"',
                              declared: false,
                          },
                      ]
                    : [],
            );
        },
    );

    it.each([
        "{invalid",
        "null",
        "[]",
        JSON.stringify({ value: "missing count" }),
        JSON.stringify({ ...item(), count: "0" }),
        JSON.stringify({ ...item(), hidden: "not in schema" }),
    ])("returns no preview for malformed or schema-invalid editor data (%#)", (editorJson) => {
        expect(localAppCardPreview(action(), editorJson)).toBeUndefined();
    });

    it("rejects a wrong wrapper, empty list and oversize input without fallback to prior data", () => {
        const definition = action({ kind: "wrapped-list", field: "customRecords" });
        expect(
            localAppCardPreview(definition, JSON.stringify({ entries: [item()] })),
        ).toBeUndefined();
        expect(localAppCardPreview(action({ kind: "list" }), "[]")).toBeUndefined();
        expect(
            localAppCardPreview(action(), JSON.stringify(item("x".repeat(65536)))),
        ).toBeUndefined();
    });

    it("escapes hidden controls visibly without normalizing their underlying value", () => {
        const value = "before\u202eafter\u200b";
        const preview = localAppCardPreview(action(), JSON.stringify(item(value)));
        const displayed = preview?.items[0].find((row) => row.key === "value")?.value;
        expect(displayed).toBe('"before\\u202eafter\\u200b"');
        expect(JSON.parse(displayed!)).toBe(value);
    });
});

describe("actual mounted app-declared preview", () => {
    it.each(["single", "list", "wrapped-list"] as const)(
        "renders %s title, disclosure, item rows and every additional field",
        (kind) => {
            const definition = action(
                kind === "wrapped-list" ? { kind, field: "customRecords" } : { kind },
            );
            const records = [item("FIRST"), item("SECOND")];
            const payload =
                kind === "single"
                    ? records[0]
                    : kind === "list"
                      ? records
                      : { customRecords: records, envelopeNote: "VISIBLE ENVELOPE FIELD" };
            const { target } = render(definition, JSON.stringify(payload));
            expect(target.querySelector("h3")?.textContent).toBe("App-authored title");
            expect(target.querySelector(".disclosure")?.textContent).toBe(
                "App-authored disclosure",
            );
            expect(target.querySelectorAll(".item")).toHaveLength(kind === "single" ? 1 : 2);
            const firstRows = [...target.querySelectorAll(".item:first-of-type dt")].map(
                (node) => node.textContent,
            );
            expect(firstRows[0]).toContain("Count first");
            expect(firstRows[1]).toContain("Value second");
            const values = [...target.querySelectorAll(".item")][0].querySelectorAll("pre");
            expect([...values].map((node) => node.textContent)).toEqual([
                "0",
                '"FIRST"',
                "Not supplied",
                "null",
                "false",
                '""',
                JSON.stringify(records[0].nested, null, 2),
                '"ADDITIONAL ITEM FIELD"',
            ]);
            expect(target.textContent).toContain("additional field");
            const envelope = target.querySelector('[aria-label="Additional envelope fields"]');
            if (kind === "wrapped-list")
                expect(envelope?.textContent).toContain("VISIBLE ENVELOPE FIELD");
            else expect(envelope).toBeNull();
        },
    );

    it("reacts to edits and removes old values for invalid JSON or invalid schema, then recovers", async () => {
        const { target, update } = render(action(), JSON.stringify(item("OLD_PRIVATE_VALUE")));
        expect(target.textContent).toContain("OLD_PRIVATE_VALUE");
        await update(JSON.stringify(item("NEW_PRIVATE_VALUE")));
        expect(target.textContent).toContain("NEW_PRIVATE_VALUE");
        expect(target.textContent).not.toContain("OLD_PRIVATE_VALUE");
        for (const invalid of [
            "{broken",
            JSON.stringify({ ...item("INVALID_PRIVATE_VALUE"), count: -1 }),
        ]) {
            await update(invalid);
            expect(target.querySelector('[role="status"]')?.textContent).toContain(
                "Preview unavailable",
            );
            expect(target.querySelectorAll(".item, pre")).toHaveLength(0);
            expect(target.textContent).not.toContain("PRIVATE_VALUE");
        }
        await update(JSON.stringify(item("RECOVERED_VALUE")));
        expect(target.textContent).toContain("RECOVERED_VALUE");
        expect(target.querySelector('[role="status"]')).toBeNull();
    });

    it("renders imported HTML-looking content only as text and never executes or sends it", () => {
        const fetchSpy = vi.fn();
        const workerSpy = vi.fn();
        const socketSpy = vi.fn();
        vi.stubGlobal("fetch", fetchSpy);
        vi.stubGlobal("Worker", workerSpy);
        vi.stubGlobal("WebSocket", socketSpy);
        const definition = action();
        definition.definition.card.title =
            '<img src="https://example.invalid/title" onerror="alert(1)">';
        definition.definition.card.disclosure =
            '<script>fetch("https://example.invalid/disclosure")</script>';
        definition.definition.card.rows[0].label =
            '<iframe src="https://example.invalid/label"></iframe>';
        const value = '<a href="javascript:alert(1)">PRIVATE HTML VALUE</a>';
        const { target } = render(definition, JSON.stringify(item(value)));
        expect(target.querySelector("h3")?.textContent).toBe(definition.definition.card.title);
        expect(target.querySelector(".disclosure")?.textContent).toBe(
            definition.definition.card.disclosure,
        );
        expect(target.textContent).toContain(definition.definition.card.rows[0].label);
        expect(target.textContent).toContain(JSON.stringify(value));
        expect(target.querySelector("img, script, iframe, a, button, input, form")).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(workerSpy).not.toHaveBeenCalled();
        expect(socketSpy).not.toHaveBeenCalled();
    });

    it("shows hidden payload controls as escaped text in the actual component", () => {
        const { target } = render(action(), JSON.stringify(item("before\u202eafter\u200b")));
        expect(target.textContent).toContain("before\\u202eafter\\u200b");
        expect(target.textContent).not.toContain("\u202e");
        expect(target.textContent).not.toContain("\u200b");
    });

    it("escapes additional item and envelope keys without changing the canonical payload", () => {
        const itemKey = "item\u202ename\u200b";
        const envelopeKey = "envelope\u202ename\u200b";
        const controlledItemSchema: LocalDraftSchema = {
            type: "object",
            additionalProperties: false,
            required: ["value", "count", itemKey],
            properties: {
                value: { type: "string" },
                count: { type: "integer" },
                [itemKey]: { type: "string" },
            },
        };
        const definition: LocalAppAction = {
            ...action({ kind: "wrapped-list", field: "customRecords" }),
            draftSchema: {
                type: "object",
                additionalProperties: false,
                required: ["customRecords", envelopeKey],
                properties: {
                    customRecords: { type: "array", items: controlledItemSchema, minItems: 1 },
                    [envelopeKey]: { type: "string" },
                },
            },
        };
        const payload = {
            customRecords: [{ value: "CONTROLLED KEY ITEM", count: 1, [itemKey]: "ITEM EXTRA" }],
            [envelopeKey]: "ENVELOPE EXTRA",
        };
        const editorJson = JSON.stringify(payload);
        const preview = localAppCardPreview(definition, editorJson);
        expect(preview?.items[0].find((row) => !row.declared)).toEqual({
            label: "item\\u202ename\\u200b",
            key: "item\\u202ename\\u200b",
            value: '"ITEM EXTRA"',
            declared: false,
        });
        expect(preview?.envelope).toEqual([
            {
                label: "envelope\\u202ename\\u200b",
                key: "envelope\\u202ename\\u200b",
                value: '"ENVELOPE EXTRA"',
                declared: false,
            },
        ]);
        const { target } = render(definition, editorJson);
        expect(target.textContent).toContain("item\\u202ename\\u200b");
        expect(target.textContent).toContain("envelope\\u202ename\\u200b");
        expect(target.textContent).not.toContain("\u202e");
        expect(target.textContent).not.toContain("\u200b");
        expect(JSON.parse(editorJson)).toEqual(payload);
        expect(Object.hasOwn(payload.customRecords[0], itemKey)).toBe(true);
        expect(Object.hasOwn(payload, envelopeKey)).toBe(true);
    });
});
