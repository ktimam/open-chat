// @vitest-environment jsdom
import { flushSync, mount, tick, unmount } from "svelte";
import { fromStore, writable } from "svelte/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalAppAction } from "../utils/localAppCatalog";
import type { LocalDraftSchema } from "../utils/localAppDrafts";
import {
    editLocalAppDraftScalar,
    initializeLocalAppDraftChoices,
    selectLocalAppDraftChoice,
} from "../utils/localAppDraftChoices";
import type { LocalAppDraftScalar } from "../utils/localAppDraftFields";
import PrivateAppDraftFields from "./PrivateAppDraftFields.svelte";

const schema = {
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
} satisfies LocalDraftSchema;
function action(): LocalAppAction {
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
                    { label: "App count", valueKey: "count" },
                    { label: "App text", valueKey: "text" },
                ],
            },
        },
        handoff: { kind: "single" },
        draftSchema: schema,
    };
}
const initial = () => ({
    text: "original",
    count: 0,
    enabled: false,
    empty: "",
    nil: null,
    nested: { value: "retained" },
});
let instances: ReturnType<typeof mount>[] = [];

function render(
    definition = action(),
    payload: unknown = initial(),
    disabled = false,
    operations: {
        onfieldedit?: (
            item: number,
            field: string,
            value: LocalAppDraftScalar | undefined,
        ) => string;
        onchoiceedit?: (item: number, field: string, value: string | undefined) => string;
    } = {},
) {
    const target = document.createElement("div");
    document.body.append(target);
    const json = writable(JSON.stringify(payload));
    const editor = fromStore(json);
    const enabled = writable(!disabled);
    const isEnabled = fromStore(enabled);
    const onchange = vi.fn((next: string) => json.set(next));
    const onblocked = vi.fn();
    instances.push(
        mount(PrivateAppDraftFields, {
            target,
            props: {
                action: definition,
                get editorJson() {
                    return editor.current;
                },
                get disabled() {
                    return !isEnabled.current;
                },
                onchange,
                onblocked,
                ...operations,
            },
        }),
    );
    flushSync();
    return {
        target,
        onchange,
        onblocked,
        payload: () => JSON.parse(editor.current),
        async update(value: string) {
            json.set(value);
            await tick();
        },
        async disable() {
            enabled.set(false);
            await tick();
        },
    };
}
function namedAction(): LocalAppAction {
    return {
        ...action(),
        draftSchema: {
            ...schema,
            properties: {
                ...schema.properties,
                category: { type: "string" },
                categoryLabel: { type: "string" },
            },
        },
        draftEditor: {
            version: 1,
            choices: [
                {
                    field: "category",
                    label: "Saved category",
                    noneLabel: "None — restore extracted values",
                    options: [
                        {
                            value: "raw-alpha",
                            label: "Friendly Alpha",
                            assign: [{ field: "categoryLabel", value: "Assigned Alpha" }],
                            defaults: [{ field: "count", value: 7 }],
                        },
                        {
                            value: "raw-beta",
                            label: "Friendly Beta",
                            assign: [{ field: "categoryLabel", value: "Assigned Beta" }],
                            defaults: [{ field: "count", value: 11 }],
                        },
                    ],
                },
            ],
        },
    };
}
function renderNamed(payload: unknown = initial(), disabled = false, definition = namedAction()) {
    let session = initializeLocalAppDraftChoices(definition, JSON.stringify(payload));
    const onfieldedit = vi.fn(
        (item: number, field: string, value: LocalAppDraftScalar | undefined) => {
            session = editLocalAppDraftScalar(session, item, field, value);
            void view.update(session.editorJson);
            return session.editorJson;
        },
    );
    const onchoiceedit = vi.fn((item: number, field: string, value: string | undefined) => {
        session = selectLocalAppDraftChoice(session, item, field, value);
        void view.update(session.editorJson);
        return session.editorJson;
    });
    const view = render(definition, JSON.parse(session.editorJson), disabled, {
        onfieldedit,
        onchoiceedit,
    });
    return { ...view, onfieldedit, onchoiceedit };
}
function control(target: HTMLElement, label: string) {
    const found = [
        ...target.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
            "input, select, textarea",
        ),
    ].find((node) => node.getAttribute("aria-label") === label);
    expect(found).toBeDefined();
    return found!;
}
async function input(target: HTMLElement, label: string, value: string) {
    const node = control(target, label);
    node.value = value;
    node.dispatchEvent(
        new Event(node instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
    await tick();
}
function button(target: HTMLElement, text: string) {
    const found = [...target.querySelectorAll("button")].find((node) => node.textContent === text);
    expect(found).toBeDefined();
    return found!;
}
afterEach(async () => {
    for (const instance of instances) await unmount(instance);
    instances = [];
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
});

describe("mounted generic private draft fields", () => {
    it("shows named labels with exact raw values and keeps assigned companions read-only", async () => {
        const view = renderNamed();
        const choice = control(view.target, "Item 1 — Saved category") as HTMLSelectElement;
        expect([...choice.options].map((option) => [option.value, option.textContent])).toEqual([
            ["absent", "None — restore extracted values"],
            ["option-0", "Friendly Alpha (raw-alpha)"],
            ["option-1", "Friendly Beta (raw-beta)"],
        ]);
        expect(choice.value).toBe("absent");
        expect(view.onchoiceedit).not.toHaveBeenCalled();
        expect(view.onchange).not.toHaveBeenCalled();
        await input(view.target, "Item 1 — Saved category", "option-1");
        expect(view.onchoiceedit).toHaveBeenCalledExactlyOnceWith(0, "category", "raw-beta");
        expect(view.payload()).toEqual({
            ...initial(),
            count: 11,
            category: "raw-beta",
            categoryLabel: "Assigned Beta",
        });
        const companion = view.target.querySelector('output[aria-label="Item 1 — categoryLabel"]');
        expect(companion?.textContent).toContain('"Assigned Beta"');
        expect(
            view.target.querySelector(
                'input[aria-label="Item 1 — categoryLabel"], textarea[aria-label="Item 1 — categoryLabel"], select[aria-label="Item 1 — categoryLabel"]',
            ),
        ).toBeNull();
        expect(view.target.textContent).toContain("Controlled by Saved category");
        expect(
            [...view.target.querySelectorAll("button")].some(
                (node) => node.textContent === "Remove categoryLabel",
            ),
        ).toBe(false);
        // Workspace callbacks own history; no duplicate Advanced JSON edit may reset it.
        expect(view.onchange).not.toHaveBeenCalled();
    });

    it("uses None to remove the choice and companions and restore untouched extracted values", async () => {
        const view = renderNamed({ ...initial(), category: "raw-alpha" });
        expect(view.payload().count).toBe(7);
        await input(view.target, "Item 1 — Saved category", "absent");
        expect(view.onchoiceedit).toHaveBeenCalledExactlyOnceWith(0, "category", undefined);
        expect(view.payload()).toEqual(initial());
        expect(
            view.target.querySelector('output[aria-label="Item 1 — categoryLabel"]')?.textContent,
        ).toContain("Not supplied");
    });

    it("routes manual field edits without losing their values on later named choices or None", async () => {
        const view = renderNamed({ ...initial(), category: "raw-alpha" });
        await input(view.target, "Item 1 — App count", "99");
        expect(view.onfieldedit).toHaveBeenCalledExactlyOnceWith(0, "count", 99);
        await input(view.target, "Item 1 — Saved category", "option-1");
        expect(view.payload()).toMatchObject({ category: "raw-beta", count: 99 });
        await input(view.target, "Item 1 — Saved category", "absent");
        expect(view.payload()).toEqual({ ...initial(), count: 99 });
        expect(view.onchange).not.toHaveBeenCalled();
    });

    it("keeps unknown raw choices visible without coercion or emission until explicitly corrected", async () => {
        const payload = {
            ...initial(),
            category: "unrecognized-id",
            categoryLabel: "Untrusted label",
        };
        const view = renderNamed(payload);
        const choice = control(view.target, "Item 1 — Saved category") as HTMLSelectElement;
        expect(choice.value).toBe("invalid");
        expect(choice.getAttribute("aria-invalid")).toBe("true");
        expect(choice.selectedOptions[0].textContent).toBe("Unknown supplied choice");
        expect(choice.selectedOptions[0].disabled).toBe(true);
        expect(view.target.textContent).toContain('"unrecognized-id"');
        expect(view.payload()).toEqual(payload);
        expect(view.onchoiceedit).not.toHaveBeenCalled();
        await input(view.target, "Item 1 — Saved category", "option-0");
        expect(view.payload()).toMatchObject({
            category: "raw-alpha",
            categoryLabel: "Assigned Alpha",
            count: 7,
        });
        expect(control(view.target, "Item 1 — Saved category").getAttribute("aria-invalid")).toBe(
            "false",
        );
    });

    it("fails closed when named-choice wiring is absent and ignores disabled synthetic selection", async () => {
        const unwired = render(namedAction());
        await input(unwired.target, "Item 1 — Saved category", "option-0");
        expect(unwired.onblocked).toHaveBeenLastCalledWith(true);
        expect(unwired.onchange).not.toHaveBeenCalled();
        expect(unwired.payload()).toEqual(initial());
        const locked = renderNamed(initial(), true);
        expect(control(locked.target, "Item 1 — Saved category").disabled).toBe(true);
        await input(locked.target, "Item 1 — Saved category", "option-1");
        expect(locked.onchoiceedit).not.toHaveBeenCalled();
        expect(locked.onblocked).not.toHaveBeenCalled();
        expect(locked.payload()).toEqual(initial());
    });

    it("renders imported named labels as inert text", () => {
        const original = namedAction();
        const markup = '<img src="https://example.invalid/leak" onerror="alert(1)">';
        const definition: LocalAppAction = {
            ...original,
            draftEditor: {
                ...original.draftEditor!,
                choices: original.draftEditor!.choices.map((choice) => ({
                    ...choice,
                    label: markup,
                    options: choice.options.map((option, index) => ({
                        ...option,
                        label: index ? option.label : markup,
                    })),
                })),
            },
        };
        const fetchSpy = vi.fn();
        vi.stubGlobal("fetch", fetchSpy);
        const view = renderNamed(initial(), false, definition);
        expect(view.target.textContent).toContain(markup);
        expect(view.target.querySelector("img, script, iframe, a")).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(view.onchoiceedit).not.toHaveBeenCalled();
    });

    it("uses app labels and does not infer values or emit on mount", () => {
        const { target, onchange } = render();
        expect(control(target, "Item 1 — App count").value).toBe("0");
        expect(control(target, "Item 1 — enabled").value).toBe("option-0");
        expect(control(target, "Item 1 — empty").value).toBe("");
        expect(control(target, "Item 1 — option").value).toBe("absent");
        expect(target.textContent).toContain("Complex and additional values are preserved");
        expect(onchange).not.toHaveBeenCalled();
    });

    it("disables browser spell checking and autocomplete for private text and numeric controls", () => {
        const { target } = render();
        for (const field of target.querySelectorAll("input, textarea")) {
            expect(field.getAttribute("spellcheck")).toBe("false");
            expect(field.getAttribute("autocomplete")).toBe("off");
        }
    });

    it("keeps controls and blocks approval when escaped serialization exceeds the limit", async () => {
        const view = render(action(), { ...initial(), text: "\u200b".repeat(11000) });
        await input(view.target, "Item 1 — App count", "2");
        expect(view.onblocked).toHaveBeenLastCalledWith(true);
        expect(view.onchange).not.toHaveBeenCalled();
        expect(control(view.target, "Item 1 — App count").value).toBe("2");
        expect(view.target.querySelector('[role="alert"]')?.textContent).toContain(
            "cannot be reviewed or sent",
        );
        expect(view.payload().count).toBe(0);
    });

    it("immediately emits invalid partial numeric edits and recovers without stale controls", async () => {
        const view = render();
        for (const value of ["", "-", "1e+"]) {
            const node = control(view.target, "Item 1 — App count");
            node.value = value;
            node.dispatchEvent(new Event("input", { bubbles: true }));
            // Host approval invalidation is synchronous with the input, not deferred to an effect.
            expect(view.onchange).toHaveBeenLastCalledWith(expect.any(String));
            expect(JSON.parse(view.onchange.mock.lastCall![0]).count).toBe(value);
            await tick();
            expect(control(view.target, "Item 1 — App count").value).toBe(value);
            expect(control(view.target, "Item 1 — App count").getAttribute("aria-invalid")).toBe(
                "true",
            );
            expect(view.target.textContent).toContain("does not match the app's schema");
        }
        await input(view.target, "Item 1 — App count", "12");
        expect(view.payload().count).toBe(12);
        expect(control(view.target, "Item 1 — App count").getAttribute("aria-invalid")).toBe(
            "false",
        );
        expect(view.target.querySelector('[role="status"]')).toBeNull();
    });

    it("edits typed enum, boolean, number enum and null without stringifying values", async () => {
        const view = render();
        await input(view.target, "Item 1 — option", "option-1");
        await input(view.target, "Item 1 — enabled", "option-1");
        await input(view.target, "Item 1 — numberChoice", "option-0");
        await input(view.target, "Item 1 — nil", "option-0");
        expect(view.payload()).toMatchObject({
            option: "second",
            enabled: true,
            numberChoice: 0,
            nil: null,
        });
        await input(view.target, "Item 1 — enabled", "option-0");
        expect(view.payload().enabled).toBe(false);
        await input(view.target, "Item 1 — option", "absent");
        expect(Object.hasOwn(view.payload(), "option")).toBe(false);
    });

    it("does not coerce a missing/invalid enum to its first option", async () => {
        const view = render(action(), { ...initial(), option: "not-an-option", numberChoice: "0" });
        expect(control(view.target, "Item 1 — option").value).toBe("invalid");
        expect(control(view.target, "Item 1 — numberChoice").value).toBe("invalid");
        expect(view.onchange).not.toHaveBeenCalled();
        await input(view.target, "Item 1 — option", "option-0");
        expect(view.payload().option).toBe("first");
    });

    it("distinguishes an explicit empty string from omission", async () => {
        const view = render();
        button(view.target, "Remove empty").click();
        await tick();
        expect(Object.hasOwn(view.payload(), "empty")).toBe(false);
        button(view.target, "Set empty to empty text").click();
        await tick();
        expect(Object.hasOwn(view.payload(), "empty")).toBe(true);
        expect(view.payload().empty).toBe("");
    });

    it("shows missing required values, invalid replacement data, and removes controls on malformed JSON", async () => {
        const view = render(action(), {});
        expect(control(view.target, "Item 1 — App count").value).toBe("");
        expect(view.target.textContent).toContain("A value is required");
        await input(view.target, "Item 1 — App count", "0");
        await input(view.target, "Item 1 — App text", "new");
        expect(view.payload()).toEqual({ count: 0, text: "new" });
        await view.update(JSON.stringify({ text: "replacement", count: -1 }));
        expect(control(view.target, "Item 1 — App text").value).toBe("replacement");
        expect(control(view.target, "Item 1 — App count").getAttribute("aria-invalid")).toBe(
            "true",
        );
        await view.update("{invalid");
        expect(view.target.querySelector("input, textarea, select")).toBeNull();
        expect(view.target.textContent).not.toContain("replacement");
        await view.update(JSON.stringify(initial()));
        expect(control(view.target, "Item 1 — App text").value).toBe("original");
    });

    it.each(["list", "wrapped-list"] as const)(
        "edits item 2 in %s preserving every other field",
        async (kind) => {
            const list: LocalDraftSchema = { type: "array", items: schema };
            const definition: LocalAppAction = {
                ...action(),
                handoff: kind === "list" ? { kind } : { kind, field: "records" },
                draftSchema:
                    kind === "list"
                        ? list
                        : {
                              type: "object",
                              additionalProperties: false,
                              properties: { records: list, envelope: { type: "string" } },
                          },
            };
            const records = [
                initial(),
                { ...initial(), text: "second", unknown: { retained: true } },
            ];
            const view = render(
                definition,
                kind === "list" ? records : { records, envelope: "keep" },
            );
            await input(view.target, "Item 2 — App text", "edited second");
            const payload = view.payload();
            const updated = kind === "list" ? payload : payload.records;
            expect(updated[0]).toEqual(records[0]);
            expect(updated[1]).toEqual({ ...records[1], text: "edited second" });
            if (kind === "wrapped-list") expect(payload.envelope).toBe("keep");
        },
    );

    it("blocks on oversized pending input synchronously and retains it until corrected", async () => {
        const view = render();
        const value = "x".repeat(65536);
        const node = control(view.target, "Item 1 — App text");
        node.value = value;
        node.dispatchEvent(new Event("input", { bubbles: true }));
        expect(view.onblocked).toHaveBeenLastCalledWith(true);
        expect(view.onchange).not.toHaveBeenCalled();
        await tick();
        expect(control(view.target, "Item 1 — App text").value).toBe(value);
        expect(control(view.target, "Item 1 — App count").disabled).toBe(true);
        expect(view.target.querySelector('[role="alert"]')?.textContent).toContain(
            "cannot be reviewed or sent",
        );
        await input(view.target, "Item 1 — App text", "shorter");
        expect(view.payload().text).toBe("shorter");
        expect(view.onblocked).toHaveBeenLastCalledWith(false);
        expect(control(view.target, "Item 1 — App count").disabled).toBe(false);
    });

    it("replaces blocked local input when external canonical JSON changes", async () => {
        const view = render();
        await input(view.target, "Item 1 — App text", "x".repeat(65536));
        await view.update(JSON.stringify({ ...initial(), text: "external edit" }));
        expect(view.onblocked).toHaveBeenLastCalledWith(false);
        expect(control(view.target, "Item 1 — App text").value).toBe("external edit");
    });

    it("is read-only while disabled, including directly dispatched synthetic DOM events", async () => {
        const view = render();
        await view.disable();
        expect(
            [...view.target.querySelectorAll("input, textarea, select, button")].every((node) =>
                node.matches(":disabled"),
            ),
        ).toBe(true);
        await input(view.target, "Item 1 — App text", "not accepted");
        await input(view.target, "Item 1 — enabled", "option-1");
        expect(view.onchange).not.toHaveBeenCalled();
        expect(view.onblocked).not.toHaveBeenCalled();
        expect(view.payload()).toEqual(initial());
    });

    it("renders imported labels/values as escaped inert text without executing or networking", () => {
        const fetchSpy = vi.fn();
        const workerSpy = vi.fn();
        const socketSpy = vi.fn();
        vi.stubGlobal("fetch", fetchSpy);
        vi.stubGlobal("Worker", workerSpy);
        vi.stubGlobal("WebSocket", socketSpy);
        const definition = action();
        const label = '<img src="https://example.invalid/leak" onerror="alert(1)">\u202e';
        definition.definition.card.rows[1].label = label;
        const payload = {
            ...initial(),
            text: '<script>fetch("https://example.invalid/")</script>\u200b',
        };
        const view = render(definition, payload);
        expect(view.target.querySelector("img, script, iframe, a")).toBeNull();
        expect(view.target.textContent).toContain("\\u202e");
        expect(view.target.textContent).not.toContain("\u202e");
        expect(view.target.textContent).toContain("\\u200b");
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(workerSpy).not.toHaveBeenCalled();
        expect(socketSpy).not.toHaveBeenCalled();
        expect(view.payload()).toEqual(payload);
        expect(view.onchange).not.toHaveBeenCalled();
    });
});
