// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { flushSync, mount, tick, unmount } from "svelte";
import { fromStore, writable } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalAppAction } from "../utils/localAppCatalog";
import type { LocalDraftSchema } from "../utils/localAppDrafts";
import { snapshotLocalDraftPayload } from "../utils/localAppDrafts";
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
let compactMode = false;

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
                compact: compactMode,
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
function hintedAction(): LocalAppAction {
    return {
        ...action(),
        definition: {
            ...action().definition,
            card: {
                ...action().definition.card,
                rows: [
                    ...action().definition.card.rows,
                    { label: "Recorded date", valueKey: "whenValue" },
                    { label: "Currency", valueKey: "currencyValue" },
                    { label: "Details", valueKey: "notesValue" },
                ],
            },
        },
        draftSchema: {
            ...schema,
            properties: {
                ...schema.properties,
                whenValue: { type: "string" },
                currencyValue: { type: "string" },
                notesValue: { type: "string" },
            },
        },
        draftPresentation: {
            version: 1,
            enumLabels: [
                {
                    field: "option",
                    options: [
                        { value: "first", label: "First" },
                        { value: "second", label: "Second" },
                    ],
                },
            ],
            controls: [
                { field: "whenValue", kind: "date" },
                { field: "currencyValue", kind: "text", suggestions: ["USD", "EUR"] },
                { field: "notesValue", kind: "multiline", fullWidth: true },
            ],
        },
    };
}

function emptyNamedAction(): LocalAppAction {
    const original = namedAction();
    return {
        ...original,
        draftEditor: {
            version: 1,
            choices: original.draftEditor!.choices.map((choice) => ({
                field: choice.field,
                label: choice.label,
                noneLabel: choice.noneLabel,
                options: [],
                companionFields: ["categoryLabel"],
            })),
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

describe.each([false, true])("mounted generic private draft fields (compact=%s)", (compact) => {
    beforeEach(() => {
        compactMode = compact;
    });

    it("collapses optional actions only in compact mode without hiding values or changing omission semantics", async () => {
        const definition = action();
        definition.definition.card.disclosure = "Review the supplied app context before sending.";
        const view = render(definition);
        expect(view.target.querySelector(".draft-fields")?.classList.contains("compact")).toBe(
            compact,
        );
        const disclosure = view.target.querySelector(".disclosure")!;
        expect(disclosure.textContent).toBe(definition.definition.card.disclosure);
        expect(disclosure.closest("details")).toBeNull();
        expect(control(view.target, "Item 1 — empty").closest("details")).toBeNull();
        const remove = button(view.target, "Remove empty");
        const removeDetails = remove.closest("details");
        if (compact) {
            expect(removeDetails?.open).toBe(false);
            expect(removeDetails?.getAttribute("aria-label")).toBe("Item 1 — empty options");
            expect(removeDetails?.querySelector("summary")?.textContent).toBe("Field options");
            removeDetails!.open = true;
        } else expect(removeDetails).toBeNull();
        expect(view.payload()).toEqual(initial());
        expect(view.onchange).not.toHaveBeenCalled();
        remove.click();
        await tick();
        const { empty: _removed, ...withoutEmpty } = initial();
        expect(view.payload()).toEqual(withoutEmpty);
        button(view.target, "Set empty to empty text").click();
        await tick();
        expect(view.payload()).toEqual(initial());
        expect(control(view.target, "Item 1 — App text").value).toBe("original");
        expect(
            view.target.querySelector('[aria-label="Additional outgoing fields"]')?.textContent,
        ).toContain("retained");
    });

    it("keeps controlled companion values inspectable and schema warnings outside compact details", async () => {
        const payload = { ...initial(), category: "unrecognized-id", categoryLabel: 123 };
        const view = renderNamed({ ...payload, categoryLabel: "Original companion" });
        // Invalid advanced-JSON edits remain inspectable without becoming a valid choice session.
        await view.update(JSON.stringify(payload));
        const companion = view.target.querySelector<HTMLOutputElement>(
            'output[aria-label="Item 1 — categoryLabel"]',
        )!;
        expect(companion.textContent).toContain("123");
        const details = companion.closest("details");
        if (compact) {
            expect(details?.open).toBe(false);
            expect(details?.getAttribute("aria-label")).toBe("Item 1 — categoryLabel exact value");
            expect(details?.querySelector("summary")?.textContent).toBe("categoryLabel");
            details!.open = true;
        } else expect(details).toBeNull();
        const warning = companion.closest(".field")!.querySelector(".invalid")!;
        expect(warning.textContent).toContain("does not match the app's field schema");
        expect(warning.closest("details")).toBeNull();
        expect(control(view.target, "Item 1 — Saved category").closest("details")).toBeNull();
        expect(view.payload()).toEqual(payload);
        expect(view.onchange).not.toHaveBeenCalled();
        expect(view.onchoiceedit).not.toHaveBeenCalled();
        await input(view.target, "Item 1 — Saved category", "option-1");
        expect(view.payload()).toEqual({
            ...initial(),
            count: 11,
            category: "raw-beta",
            categoryLabel: "Assigned Beta",
        });
        expect(companion.textContent).toContain('"Assigned Beta"');
        expect(companion.closest(".field")!.querySelector(".invalid")).toBeNull();
        expect(view.onchange).not.toHaveBeenCalled();
    });

    it("keeps accessible item groups and app-owned full-width metadata in the compact layout", () => {
        const view = render(hintedAction(), {
            ...initial(),
            notesValue: "Wide field supplied by app metadata",
        });
        expect(view.target.querySelector("fieldset")?.getAttribute("aria-label")).toBe(
            "Draft fields for item 1",
        );
        expect(view.target.querySelector("legend")?.classList.contains("single-item")).toBe(true);
        expect(
            control(view.target, "Item 1 — Details")
                .closest(".field")
                ?.classList.contains("full-width"),
        ).toBe(true);
        expect(
            control(view.target, "Item 1 — App count")
                .closest(".field")
                ?.classList.contains("full-width"),
        ).toBe(false);
        const definition: LocalAppAction = {
            ...action(),
            handoff: { kind: "list" },
            draftSchema: { type: "array", items: schema },
        };
        const multi = render(definition, [initial(), initial()]);
        const legends = [...multi.target.querySelectorAll("legend")];
        expect(legends.map((legend) => legend.textContent)).toEqual(["Item 1", "Item 2"]);
        expect(legends.every((legend) => !legend.classList.contains("single-item"))).toBe(true);
        const source = readFileSync(resolve(__dirname, "PrivateAppDraftFields.svelte"), "utf8");
        expect(source).toMatch(/compact = false/);
        expect(source).toMatch(
            /\.compact fieldset\s*\{[^}]*minmax\(min\(100%, 120px\), 1fr\)[^}]*padding:\s*0;[^}]*border:\s*0;[^}]*gap:\s*8px;/,
        );
        expect(source).toMatch(/\.compact legend\.single-item\s*\{\s*display:\s*none;/);
        expect(source).toMatch(/\.compact label > span,[\s\S]*?font-size:\s*11px;/);
        expect(source).toMatch(/\.compact input,[\s\S]*?min-height:\s*44px;/);
    });

    it("shows app-owned labels for required enums while preserving scalar identities and raw review", async () => {
        const definition: LocalAppAction = {
            ...action(),
            draftSchema: {
                ...schema,
                required: [...schema.required, "option"],
                properties: {
                    ...schema.properties,
                    enabled: { type: "boolean", enum: [false, true] },
                    nil: { type: "null", enum: [null] },
                },
            },
            draftPresentation: {
                version: 1,
                enumLabels: [
                    {
                        field: "option",
                        // Declaration order cannot change schema enum identity/order.
                        options: [
                            { value: "second", label: "Second friendly option" },
                            { value: "first", label: "First friendly option" },
                        ],
                    },
                    {
                        field: "enabled",
                        options: [
                            { value: false, label: "Disabled" },
                            { value: true, label: "Enabled" },
                        ],
                    },
                    {
                        field: "numberChoice",
                        options: [
                            { value: 0, label: "Zero" },
                            { value: 2, label: "Two" },
                        ],
                    },
                    { field: "nil", options: [{ value: null, label: "Explicit null" }] },
                ],
            },
        };
        const payload = { ...initial(), option: "first", numberChoice: 0 };
        const view = render(definition, payload);
        const select = control(view.target, "Item 1 — option") as HTMLSelectElement;
        expect([...select.options].map((option) => [option.value, option.textContent])).toEqual([
            ["absent", "Not supplied (required)"],
            ["option-0", "First friendly option"],
            ["option-1", "Second friendly option"],
        ]);
        expect(view.onchange).not.toHaveBeenCalled();
        expect(view.payload()).toEqual(payload);
        expect(JSON.stringify(view.payload())).toContain('"option":"first"');
        await input(view.target, "Item 1 — option", "option-1");
        await input(view.target, "Item 1 — enabled", "option-1");
        await input(view.target, "Item 1 — numberChoice", "option-1");
        await input(view.target, "Item 1 — nil", "option-0");
        expect(view.payload()).toEqual({
            ...payload,
            option: "second",
            enabled: true,
            numberChoice: 2,
        });
        expect(snapshotLocalDraftPayload(view.payload(), definition.draftSchema)).toEqual(
            view.payload(),
        );
        expect(JSON.stringify(view.payload())).not.toContain("friendly");
        await input(view.target, "Item 1 — option", "absent");
        expect(control(view.target, "Item 1 — option").getAttribute("aria-invalid")).toBe("true");
        expect(() => snapshotLocalDraftPayload(view.payload(), definition.draftSchema)).toThrow();
    });

    it("keeps named-choice defaults, None restoration and manual precedence with presentation on the same required field", async () => {
        const original = namedAction();
        const definition: LocalAppAction = {
            ...original,
            draftSchema: {
                ...schema,
                properties: {
                    ...schema.properties,
                    category: { type: "string" },
                    categoryLabel: { type: "string" },
                    count: { type: "integer", minimum: 0, enum: [0, 7, 11, 99] },
                },
            },
            draftPresentation: {
                version: 1,
                enumLabels: [
                    {
                        field: "count",
                        options: [0, 7, 11, 99].map((value) => ({
                            value,
                            label: `Named ${value}`,
                        })),
                    },
                ],
            },
        };
        const view = renderNamed({ ...initial(), category: "raw-alpha" }, false, definition);
        expect(view.payload().count).toBe(7);
        expect(
            (control(view.target, "Item 1 — App count") as HTMLSelectElement).selectedOptions[0]
                .textContent,
        ).toBe("Named 7");
        await input(view.target, "Item 1 — Saved category", "absent");
        expect(view.payload()).toEqual(initial());
        await input(view.target, "Item 1 — Saved category", "option-1");
        expect(view.payload().count).toBe(11);
        await input(view.target, "Item 1 — App count", "option-3");
        expect(view.onfieldedit).toHaveBeenCalledExactlyOnceWith(0, "count", 99);
        await input(view.target, "Item 1 — Saved category", "option-0");
        expect(view.payload()).toMatchObject({ category: "raw-alpha", count: 99 });
        await input(view.target, "Item 1 — Saved category", "absent");
        expect(view.payload()).toEqual({ ...initial(), count: 99 });
        expect(view.onchange).not.toHaveBeenCalled();
        expect(snapshotLocalDraftPayload(view.payload(), definition.draftSchema)).toEqual(
            view.payload(),
        );
    });

    it("renders enum labels only as inert text and preserves old raw display without metadata", () => {
        const markup = '<img src="https://example.invalid/leak" onerror="alert(1)">';
        const fetchSpy = vi.fn();
        vi.stubGlobal("fetch", fetchSpy);
        const definition: LocalAppAction = {
            ...action(),
            draftPresentation: {
                version: 1,
                enumLabels: [
                    {
                        field: "option",
                        options: [
                            { value: "first", label: markup },
                            { value: "second", label: "Other" },
                        ],
                    },
                ],
            },
        };
        const view = render(definition, { ...initial(), option: "first" });
        expect(view.target.textContent).toContain(markup);
        expect(view.target.querySelector("img, script, iframe, a")).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(view.onchange).not.toHaveBeenCalled();
        const legacy = render(action(), { ...initial(), option: "first" });
        expect(
            (control(legacy.target, "Item 1 — option") as HTMLSelectElement).selectedOptions[0]
                .textContent,
        ).toBe('"first"');
        const invalid = render(
            {
                ...definition,
                draftPresentation: {
                    version: 1,
                    enumLabels: [
                        { field: "option", options: [{ value: "first", label: "Incomplete" }] },
                    ],
                },
            },
            { ...initial(), option: "first" },
        );
        expect(
            (control(invalid.target, "Item 1 — option") as HTMLSelectElement).selectedOptions[0]
                .textContent,
        ).toBe('"first"');
        expect(invalid.onchange).not.toHaveBeenCalled();
    });

    it("shows friendly named labels without wire IDs while preserving raw values and read-only companions", async () => {
        const view = renderNamed();
        const choice = control(view.target, "Item 1 — Saved category") as HTMLSelectElement;
        expect([...choice.options].map((option) => [option.value, option.textContent])).toEqual([
            ["absent", "None — restore extracted values"],
            ["option-0", "Friendly Alpha"],
            ["option-1", "Friendly Beta"],
        ]);
        expect(choice.closest("label")?.textContent).not.toContain("(category)");
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
        expect(JSON.stringify(view.payload())).toContain('"category":"raw-beta"');
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

    it("renders an empty named-choice roster as None without inventing a value or emitting on mount", () => {
        const view = renderNamed(initial(), false, emptyNamedAction());
        const select = control(view.target, "Item 1 — Saved category") as HTMLSelectElement;
        expect(select.value).toBe("absent");
        expect([...select.options].map((option) => [option.value, option.textContent])).toEqual([
            ["absent", "None — restore extracted values"],
        ]);
        expect(view.payload()).toEqual(initial());
        expect(view.onchoiceedit).not.toHaveBeenCalled();
        expect(view.onchange).not.toHaveBeenCalled();
        expect(
            view.target.querySelector(
                'input[aria-label="Item 1 — categoryLabel"], textarea[aria-label="Item 1 — categoryLabel"]',
            ),
        ).toBeNull();
    });

    it("keeps stale empty-roster IDs visible until the user explicitly chooses None", async () => {
        const view = renderNamed(
            { ...initial(), category: "stale-id", categoryLabel: "Stale label" },
            false,
            emptyNamedAction(),
        );
        const select = control(view.target, "Item 1 — Saved category") as HTMLSelectElement;
        expect(select.value).toBe("invalid");
        expect(view.target.textContent).toContain('"stale-id"');
        expect(view.onchoiceedit).not.toHaveBeenCalled();
        await input(view.target, "Item 1 — Saved category", "absent");
        expect(view.onchoiceedit).toHaveBeenCalledExactlyOnceWith(0, "category", undefined);
        expect(view.payload()).toEqual(initial());
    });

    it("offers explicit selector removal for an orphan read-only companion even while None is selected", async () => {
        const view = renderNamed(
            { ...initial(), categoryLabel: "Orphan companion" },
            false,
            emptyNamedAction(),
        );
        expect(control(view.target, "Item 1 — Saved category").value).toBe("absent");
        expect(
            view.target.querySelector('output[aria-label="Item 1 — categoryLabel"]')?.textContent,
        ).toContain("Orphan companion");
        expect(
            view.target.querySelector(
                'input[aria-label="Item 1 — categoryLabel"], textarea[aria-label="Item 1 — categoryLabel"]',
            ),
        ).toBeNull();
        button(view.target, "Remove Saved category").click();
        await tick();
        expect(view.onchoiceedit).toHaveBeenCalledExactlyOnceWith(0, "category", undefined);
        expect(view.onchange).not.toHaveBeenCalled();
        expect(view.payload()).toEqual(initial());
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
        expect(choice.closest(".field")?.textContent).toContain('"unrecognized-id"');
        expect(choice.closest("details")).toBeNull();
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
        expect(locked.onblocked).toHaveBeenLastCalledWith(false);
        locked.onblocked.mockClear();
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
        const { target, onchange, payload } = render();
        expect(control(target, "Item 1 — App count").value).toBe("0");
        expect(control(target, "Item 1 — enabled").value).toBe("option-0");
        expect(control(target, "Item 1 — empty").value).toBe("");
        expect(control(target, "Item 1 — option").value).toBe("absent");
        expect(control(target, "Item 1 — App count").closest("label")?.textContent).not.toContain(
            "(count)",
        );
        expect(control(target, "Item 1 — App text").closest("label")?.textContent).not.toContain(
            "(text)",
        );
        expect(payload()).toEqual(initial());
        expect(onchange).not.toHaveBeenCalled();
    });

    it("uses app-hinted date, text suggestions and multiline controls without guessing or narrowing outgoing values", async () => {
        const definition = hintedAction();
        const payload = {
            ...initial(),
            whenValue: "2024-02-29",
            currencyValue: "XBT",
            notesValue: "Line one\nLine two",
        };
        const view = render(definition, payload);
        const date = control(view.target, "Item 1 — Recorded date") as HTMLInputElement;
        const currency = control(view.target, "Item 1 — Currency") as HTMLInputElement;
        expect(date.tagName).toBe("INPUT");
        expect(date.type).toBe("date");
        expect(date.value).toBe("2024-02-29");
        expect(currency.type).toBe("text");
        expect(currency.value).toBe("XBT");
        expect(control(view.target, "Item 1 — Details").tagName).toBe("TEXTAREA");
        expect(
            control(view.target, "Item 1 — Details")
                .closest(".field")
                ?.classList.contains("full-width"),
        ).toBe(true);
        expect(date.closest(".field")?.classList.contains("full-width")).toBe(false);
        expect(control(view.target, "Item 1 — App text").tagName).toBe("TEXTAREA");
        const suggestionList = document.getElementById(currency.getAttribute("list") ?? "");
        expect(suggestionList?.tagName).toBe("DATALIST");
        expect(
            [...(suggestionList?.querySelectorAll("option") ?? [])].map((option) => option.value),
        ).toEqual(["USD", "EUR"]);
        expect(view.payload()).toEqual(payload);
        expect(view.onchange).not.toHaveBeenCalled();
        await input(view.target, "Item 1 — Currency", "  usd  ");
        await input(view.target, "Item 1 — Recorded date", "2000-02-29");
        expect(view.payload()).toEqual({
            ...payload,
            currencyValue: "  usd  ",
            whenValue: "2000-02-29",
        });
        expect(snapshotLocalDraftPayload(view.payload(), definition.draftSchema)).toEqual(
            view.payload(),
        );
        expect(typeof view.payload().whenValue).toBe("string");
        expect(typeof view.payload().currencyValue).toBe("string");
    });

    it("declares compact wrapping field columns and at least 44px controls without relying on jsdom layout", () => {
        const source = readFileSync(resolve(__dirname, "PrivateAppDraftFields.svelte"), "utf8");
        const style = source.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
        const declarations = (selector: string) =>
            [...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
                .filter((match) =>
                    match[1]
                        .split(",")
                        .map((part) => part.trim())
                        .includes(selector),
                )
                .map((match) => match[2])
                .join("\n");
        expect(declarations("fieldset")).toMatch(/display:\s*grid\s*;/);
        expect(declarations("fieldset")).toMatch(/grid-template-columns:\s*repeat\(auto-fit,/);
        for (const selector of ["input", "textarea", "select", "button"])
            expect(declarations(selector)).toMatch(/min-height:\s*44px\s*;/);
        expect(declarations("label")).toMatch(/overflow-wrap:\s*anywhere\s*;/);
        expect(declarations(".full-width")).toMatch(/grid-column:\s*1\s*\/\s*-1\s*;/);
    });

    it.each(["0001-01-01", "2000-02-29", "2024-02-29", "9999-12-31"])(
        "accepts the exact Gregorian date %s without automatic edits",
        (whenValue) => {
            const payload = { ...initial(), whenValue };
            const view = render(hintedAction(), payload);
            const date = control(view.target, "Item 1 — Recorded date") as HTMLInputElement;
            expect(date.type).toBe("date");
            expect(date.value).toBe(whenValue);
            expect(date.getAttribute("aria-invalid")).toBe("false");
            expect(view.onblocked).not.toHaveBeenCalledWith(true);
            expect(view.onchange).not.toHaveBeenCalled();
            expect(view.payload()).toEqual(payload);
        },
    );

    it.each([
        "1900-02-29",
        "2023-02-29",
        "2024-04-31",
        "2024-13-01",
        "0000-01-01",
        "2024-2-9",
        "2024-02-29T00:00:00Z",
        " 2024-02-29 ",
    ])(
        "keeps invalid supplied date %s visible as text and blocks approval until repaired",
        async (whenValue) => {
            const payload = { ...initial(), whenValue };
            const view = render(hintedAction(), payload);
            const date = control(view.target, "Item 1 — Recorded date") as HTMLInputElement;
            expect(date.tagName).toBe("INPUT");
            expect(date.type).toBe("text");
            expect(date.value).toBe(whenValue);
            expect(date.getAttribute("aria-invalid")).toBe("true");
            expect(date.closest("details")).toBeNull();
            expect(view.onblocked).toHaveBeenLastCalledWith(true);
            expect(view.onchange).not.toHaveBeenCalled();
            expect(view.payload()).toEqual(payload);
            await input(view.target, "Item 1 — Recorded date", "2024-02-29");
            expect(view.payload()).toEqual({ ...payload, whenValue: "2024-02-29" });
            expect(view.onblocked).toHaveBeenLastCalledWith(false);
            expect((control(view.target, "Item 1 — Recorded date") as HTMLInputElement).type).toBe(
                "date",
            );
        },
    );

    it("removes an optional date through either the explicit remove button or an empty date control", async () => {
        const view = render(hintedAction(), { ...initial(), whenValue: "2023-02-29" });
        button(view.target, "Remove Recorded date").click();
        await tick();
        expect(view.payload()).toEqual(initial());
        expect(view.onblocked).toHaveBeenLastCalledWith(false);
        await input(view.target, "Item 1 — Recorded date", "2024-02-29");
        await input(view.target, "Item 1 — Recorded date", "");
        expect(view.payload()).toEqual(initial());
        expect(Object.hasOwn(view.payload(), "whenValue")).toBe(false);
        expect(view.onblocked).toHaveBeenLastCalledWith(false);
        expect(control(view.target, "Item 1 — Recorded date").value).toBe("");
    });

    it("keeps a cleared required date present and invalid instead of removing it", async () => {
        const original = hintedAction();
        if (original.draftSchema.type !== "object") throw new Error("Expected object schema");
        const definition: LocalAppAction = {
            ...original,
            draftSchema: {
                ...original.draftSchema,
                required: [...(original.draftSchema.required ?? []), "whenValue"],
            },
        };
        const view = render(definition, { ...initial(), whenValue: "2024-02-29" });
        await input(view.target, "Item 1 — Recorded date", "");
        expect(view.payload()).toEqual({ ...initial(), whenValue: "" });
        expect(Object.hasOwn(view.payload(), "whenValue")).toBe(true);
        expect(view.onblocked).toHaveBeenLastCalledWith(true);
        expect(control(view.target, "Item 1 — Recorded date").getAttribute("aria-invalid")).toBe(
            "true",
        );
    });

    it("does not interpret incomplete native date input as intentional removal", async () => {
        const view = render(hintedAction(), { ...initial(), whenValue: "2024-02-29" });
        const date = control(view.target, "Item 1 — Recorded date") as HTMLInputElement;
        Object.defineProperty(date, "validity", { value: { badInput: true }, configurable: true });
        await input(view.target, "Item 1 — Recorded date", "");
        expect(view.payload()).toEqual({ ...initial(), whenValue: "" });
        expect(view.onblocked).toHaveBeenLastCalledWith(true);
    });

    it("preserves explicit empty strings in unrelated optional hinted and multiline text fields", async () => {
        const view = render(hintedAction(), {
            ...initial(),
            currencyValue: "USD",
            notesValue: "text",
        });
        await input(view.target, "Item 1 — Currency", "");
        await input(view.target, "Item 1 — Details", "");
        expect(view.payload()).toEqual({ ...initial(), currencyValue: "", notesValue: "" });
        expect(Object.hasOwn(view.payload(), "currencyValue")).toBe(true);
        expect(Object.hasOwn(view.payload(), "notesValue")).toBe(true);
        expect(view.onblocked).toHaveBeenLastCalledWith(false);
    });

    it("does not infer calendar or currency controls from a field name or its existing value", () => {
        const hinted = hintedAction();
        const view = render(
            { ...hinted, draftPresentation: undefined },
            { ...initial(), whenValue: "2023-02-29", currencyValue: "USD" },
        );
        expect(control(view.target, "Item 1 — Recorded date").tagName).toBe("TEXTAREA");
        expect(control(view.target, "Item 1 — Currency").tagName).toBe("TEXTAREA");
        expect(view.target.querySelector("datalist")).toBeNull();
        expect(view.onblocked).not.toHaveBeenCalledWith(true);
        expect(view.onchange).not.toHaveBeenCalled();
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
        expect(control(view.target, "Item 1 — option").closest(".field")?.textContent).toContain(
            '"not-an-option"',
        );
        expect(
            control(view.target, "Item 1 — numberChoice").closest(".field")?.textContent,
        ).toContain('"0"');
        expect(control(view.target, "Item 1 — option").closest("details")).toBeNull();
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
        expect(view.onblocked).toHaveBeenLastCalledWith(false);
        view.onblocked.mockClear();
        await input(view.target, "Item 1 — App text", "not accepted");
        await input(view.target, "Item 1 — enabled", "option-1");
        expect(view.onchange).not.toHaveBeenCalled();
        expect(view.onblocked).not.toHaveBeenCalled();
        expect(view.payload()).toEqual(initial());
    });

    it("renders app-declared string options and preserves an unlisted exact value", async () => {
        const definition = hintedAction();
        const hint = definition.draftPresentation!.controls!.find(
            (item) => item.field === "currencyValue",
        )!;
        Object.assign(hint, { kind: "select" });
        const view = render(definition, { ...initial(), currencyValue: "ZZZ" });
        const picker = control(view.target, "Item 1 — Currency") as HTMLSelectElement;
        expect(picker.tagName).toBe("SELECT");
        expect(picker.value).toBe("ZZZ");
        expect([...picker.options].map((option) => option.value)).toEqual(["ZZZ", "USD", "EUR"]);
        expect(view.onchange).not.toHaveBeenCalled();
        picker.value = "EUR";
        picker.dispatchEvent(new Event("change", { bubbles: true }));
        await tick();
        expect(view.payload().currencyValue).toBe("EUR");
    });

    it("does not replace an absent picker value with the first option", () => {
        const definition = hintedAction();
        Object.assign(definition.draftPresentation!.controls![1], { kind: "select" });
        const view = render(definition);
        expect(control(view.target, "Item 1 — Currency").value).toBe("");
        expect(view.payload()).not.toHaveProperty("currencyValue");
        expect(view.onchange).not.toHaveBeenCalled();
    });

    it.each([123, null, { unexpected: true }, ["ABC"]])(
        "keeps wrongly typed picker input visible without coercion or crashes: %j",
        (value) => {
            const definition = hintedAction();
            Object.assign(definition.draftPresentation!.controls![1], { kind: "select" });
            const view = render(definition, { ...initial(), currencyValue: value });
            const field = control(view.target, "Item 1 — Currency");
            expect(field.tagName).toBe("INPUT");
            expect(field.getAttribute("aria-invalid")).toBe("true");
            expect(view.payload().currencyValue).toEqual(value);
            expect(view.onchange).not.toHaveBeenCalled();
        },
    );

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
