// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { flushSync, mount, tick, unmount } from "svelte";
import { fromStore, writable } from "svelte/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalAppAction } from "../utils/localAppCatalog";
import { editLocalAppDraftField } from "../utils/localAppDraftFields";
import type { LocalAppDraftScalar } from "../utils/localAppDraftFields";
import { formatLocalDraftJson } from "../utils/localAppDrafts";
import {
    editLocalAppDraftScalar,
    initializeLocalAppDraftChoices,
    selectLocalAppDraftChoice,
} from "../utils/localAppDraftChoices";
import type { LocalAppViewV1 } from "../utils/localAppView";
import PrivateAppDraftFields from "./PrivateAppDraftFields.svelte";

function action(): LocalAppAction {
    return {
        definition: {
            name: "synthetic.view",
            description: "Synthetic view",
            promptTemplate: "Copy",
            responseSchema: {},
            card: {
                title: "Synthetic card",
                confirmLabel: "Review",
                cancelLabel: "Cancel",
                rows: [
                    { label: "Quantity", valueKey: "quantity" },
                    { label: "Memo", valueKey: "memo" },
                    { label: "State", valueKey: "state" },
                    { label: "Recorded date", valueKey: "when" },
                ],
            },
        },
        handoff: { kind: "single" },
        draftSchema: {
            type: "object",
            additionalProperties: false,
            required: ["quantity", "memo"],
            properties: {
                quantity: { type: "number" },
                memo: { type: "string" },
                state: { type: "string", enum: ["new", "done"] },
                when: { type: "string" },
                extra: { type: "string" },
                nested: {
                    type: "object",
                    additionalProperties: false,
                    properties: { tag: { type: "string" } },
                },
            },
        },
        draftPresentation: {
            version: 1,
            enumLabels: [
                {
                    field: "state",
                    options: [
                        { value: "new", label: "Fresh" },
                        { value: "done", label: "Complete" },
                    ],
                },
            ],
            controls: [{ field: "when", kind: "date" }],
        },
    };
}
const payload = () => ({
    quantity: 7.25,
    memo: "exact original",
    state: "new",
    when: "2026-10-05",
    extra: "not in view",
    nested: { tag: "preserved" },
});
function view(): LocalAppViewV1 {
    return {
        version: 1,
        theme: {
            dark: { background: "#121212", field: "#222222", text: "#eeeeee", accent: "#44aaff" },
        },
        nodes: [
            {
                kind: "group",
                surface: "card",
                padding: "small",
                radius: "medium",
                children: [
                    {
                        kind: "row",
                        gap: "small",
                        children: [
                            { kind: "field", field: "state", minWidth: 124 },
                            { kind: "field", field: "quantity", minWidth: 96 },
                        ],
                    },
                    { kind: "field", field: "memo", fullWidth: true, control: "single-line" },
                    { kind: "field", field: "when", control: "single-line" },
                    {
                        kind: "text",
                        text: "<img src=x onerror=alert(1)>",
                        tone: "accent",
                        size: "small",
                    },
                ],
            },
        ],
    };
}
const instances: ReturnType<typeof mount>[] = [];
function render(
    options: {
        view?: unknown;
        action?: LocalAppAction;
        payload?: unknown;
        readOnly?: boolean;
        viewTheme?: "light" | "dark";
        reviewing?: boolean;
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
    const json = writable(JSON.stringify(options.payload ?? payload()));
    const editor = fromStore(json);
    const appView = writable<unknown>(Object.hasOwn(options, "view") ? options.view : view());
    const metadata = fromStore(appView);
    const definition = writable(options.action ?? action());
    const currentAction = fromStore(definition);
    const readonly = writable(options.readOnly ?? false);
    const mode = fromStore(readonly);
    const reviewState = writable(options.reviewing ?? true);
    const review = fromStore(reviewState);
    const onchange = vi.fn((next: string) => json.set(next));
    const onblocked = vi.fn();
    instances.push(
        mount(PrivateAppDraftFields, {
            target,
            props: {
                get action() {
                    return currentAction.current;
                },
                get editorJson() {
                    return editor.current;
                },
                get view() {
                    return metadata.current;
                },
                get readOnly() {
                    return mode.current;
                },
                get reviewing() {
                    return review.current;
                },
                viewTheme: options.viewTheme ?? "dark",
                compact: true,
                onchange,
                onblocked,
                onfieldedit: options.onfieldedit,
                onchoiceedit: options.onchoiceedit,
            },
        }),
    );
    flushSync();
    return {
        target,
        onchange,
        onblocked,
        payload: () => JSON.parse(editor.current),
        async update(next: string) {
            json.set(next);
            await tick();
        },
        async setView(next: unknown) {
            appView.set(next);
            await tick();
        },
        async setAction(next: LocalAppAction) {
            definition.set(next);
            await tick();
        },
        async setReadonly(next: boolean) {
            readonly.set(next);
            await tick();
        },
        async setReviewing(next: boolean) {
            reviewState.set(next);
            await tick();
        },
    };
}
function input(target: HTMLElement, label: string): HTMLInputElement {
    const found = target.querySelector<HTMLInputElement>(`input[aria-label="Item 1 — ${label}"]`);
    expect(found).not.toBeNull();
    return found!;
}
async function type(target: HTMLInputElement, value: string) {
    target.value = value;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
}
afterEach(async () => {
    for (const instance of instances.splice(0)) await unmount(instance);
    document.body.replaceChildren();
});

describe("opt-in app-owned view rendering", () => {
    it.each(["first\nsecond", "first\tsecond", "first\u202esecond", "first\u2028second"])(
        "read-only display escapes control characters in canonical strings",
        (memo) => {
            const result = render({ readOnly: true, payload: { ...payload(), memo } });
            expect(
                result.target
                    .querySelector('output[aria-label="Item 1 — Memo"]')
                    ?.textContent?.trim(),
            ).toBe(formatLocalDraftJson(memo));
        },
    );
    it("host editing mode keeps the compact view and uncovered values until explicit review", async () => {
        const result = render({ reviewing: false });
        expect(result.target.querySelector(".app-owned-view")).not.toBeNull();
        expect(result.target.querySelector(".host-exact-review,.host-review-notice")).toBeNull();
        expect(result.target.querySelector(".host-additional-fields")?.textContent).toContain(
            "extra",
        );
        expect(
            result.target.querySelector('[aria-label="Additional outgoing fields"]')?.textContent,
        ).toContain("preserved");
        await result.setReviewing(true);
        expect(result.target.querySelector(".host-exact-review")?.textContent).toContain(
            '"state": "new"',
        );
        await result.setReviewing(false);
        expect(result.target.querySelector(".host-exact-review")).toBeNull();
        expect(input(result.target, "Memo").value).toBe("exact original");
    });
    it("renders declared row order and single-line hints using exact canonical values", () => {
        const result = render();
        const row = result.target.querySelector(".view-row")!;
        expect(
            [...row.querySelectorAll("input,select")].map((field) =>
                field.getAttribute("aria-label"),
            ),
        ).toEqual(["Item 1 — State", "Item 1 — Quantity"]);
        expect(input(result.target, "Memo").value).toBe("exact original");
        expect(input(result.target, "Quantity").value).toBe("7.25");
        expect(input(result.target, "Recorded date").type).toBe("date");
        expect(result.onblocked).toHaveBeenLastCalledWith(false);
    });
    it("keeps app text inert and palette confined to the app subtree", () => {
        const result = render();
        const app = result.target.querySelector<HTMLElement>(".app-owned-view")!;
        expect(app.style.getPropertyValue("--app-view-text")).toBe("#eeeeee");
        expect(app.textContent).toContain("<img src=x onerror=alert(1)>");
        expect(result.target.querySelector("img,iframe,script,a")).toBeNull();
        const host = result.target.querySelector<HTMLElement>(".host-exact-review")!;
        expect(host.closest(".app-owned-view")).toBeNull();
        expect(host.style.cssText).toBe("");
        expect(host.textContent).toContain('"state": "new"');
        expect(host.textContent).toContain('"quantity": 7.25');
        expect(result.target.querySelector(".host-additional-fields")?.textContent).toContain(
            "extra",
        );
        expect(host.textContent).toContain('"tag": "preserved"');
    });
    it.each(["light", "dark"] as const)(
        "uses the host %s color scheme for native date controls without changing values",
        (viewTheme) => {
            const result = render({ viewTheme });
            const app = result.target.querySelector<HTMLElement>(".app-owned-view")!;
            expect(app.style.colorScheme).toBe(viewTheme);
            expect(input(result.target, "Recorded date").type).toBe("date");
            expect(input(result.target, "Recorded date").value).toBe("2026-10-05");
            expect(result.payload()).toEqual(payload());
            expect(result.onchange).not.toHaveBeenCalled();
            expect(result.onblocked).toHaveBeenLastCalledWith(false);
            expect(
                result.target.querySelector<HTMLElement>(".host-exact-review")!.style.colorScheme,
            ).toBe("");
        },
    );
    it("retains readable host review even if an allowed palette is unreadable", () => {
        const custom = { ...view(), theme: { dark: { field: "#ffffff", text: "#ffffff" } } };
        const result = render({ view: custom });
        expect(result.target.querySelector(".host-exact-review")?.textContent).toContain(
            "exact original",
        );
        expect(result.target.querySelector(".host-review-notice")?.textContent).toContain(
            "every canonical value",
        );
    });
    it("uses the existing edit callback once, preserving host approval revocation", async () => {
        let approved = true;
        const onfieldedit = vi.fn((item, field, value) => {
            approved = false;
            const next = editLocalAppDraftField(
                action(),
                JSON.stringify(result.payload()),
                item,
                field,
                value,
            );
            void result.update(next);
            return next;
        });
        const result = render({ onfieldedit });
        await type(input(result.target, "Memo"), "user edit");
        expect(onfieldedit).toHaveBeenCalledExactlyOnceWith(0, "memo", "user edit");
        expect(result.onchange).not.toHaveBeenCalled();
        expect(approved).toBe(false);
        expect(result.payload().memo).toBe("user edit");
        expect(result.target.querySelector(".host-exact-review")?.textContent).toContain(
            "user edit",
        );
    });
    it("clears an optional date with the existing removal callback and revokes host approval", async () => {
        let approved = true;
        const onfieldedit = vi.fn((item, field, value) => {
            approved = false;
            const next = editLocalAppDraftField(
                action(),
                JSON.stringify(result.payload()),
                item,
                field,
                value,
            );
            void result.update(next);
            return next;
        });
        const result = render({ onfieldedit });
        await type(input(result.target, "Recorded date"), "");
        expect(onfieldedit).toHaveBeenCalledExactlyOnceWith(0, "when", undefined);
        expect(result.onchange).not.toHaveBeenCalled();
        expect(approved).toBe(false);
        expect(Object.hasOwn(result.payload(), "when")).toBe(false);
        expect(result.onblocked).toHaveBeenLastCalledWith(false);
    });

    it("preserves a long read-only token while allowing it to wrap inside its field", () => {
        const memo = "x".repeat(4096);
        const result = render({ readOnly: true, payload: { ...payload(), memo } });
        expect(
            result.target.querySelector('output[aria-label="Item 1 — Memo"]')?.textContent?.trim(),
        ).toBe(memo);
        const source = readFileSync(
            resolve("app/src/components_shared/PrivateAppDraftFields.svelte"),
            "utf8",
        );
        expect(source).toMatch(/output\s*\{[^}]*min-width: 0;/);
        expect(source).toMatch(/output\s*\{[^}]*overflow-wrap: anywhere;/);
        expect(source).toMatch(/output\s*\{[^}]*white-space: pre-wrap;/);
    });
    it("preserves failed pending edits and blocks review rather than showing older values", async () => {
        const result = render({
            onfieldedit: () => {
                throw new Error("synthetic failure");
            },
        });
        await type(input(result.target, "Memo"), "pending edit");
        expect(input(result.target, "Memo").value).toBe("pending edit");
        expect(result.payload().memo).toBe("exact original");
        expect(result.onblocked).toHaveBeenLastCalledWith(true);
        expect(result.target.querySelector(".host-exact-review")).toBeNull();
        expect(result.target.textContent).toContain("cannot be reviewed or sent");
        expect(input(result.target, "Quantity").disabled).toBe(true);
    });
    it("does not let view control hints bypass existing date validation", async () => {
        const result = render({ payload: { ...payload(), when: "2026-99-99" } });
        expect(input(result.target, "Recorded date").type).toBe("text");
        expect(input(result.target, "Recorded date").value).toBe("2026-99-99");
        expect(result.onblocked).toHaveBeenLastCalledWith(true);
        await type(input(result.target, "Recorded date"), "2026-10-05");
        expect(result.onblocked).toHaveBeenLastCalledWith(false);
    });
    it("host read-only mode renders canonical outputs and cannot edit", async () => {
        const result = render({ readOnly: true });
        expect(result.target.querySelector("input,textarea,select,button")).toBeNull();
        expect(
            result.target.querySelector('output[aria-label="Item 1 — Memo"]')?.textContent,
        ).toContain("exact original");
        expect(
            result.target.querySelector('output[aria-label="Item 1 — State"]')?.textContent,
        ).toContain("Fresh");
        expect(result.onchange).not.toHaveBeenCalled();
        await result.setReadonly(false);
        expect(input(result.target, "Memo").value).toBe("exact original");
    });
    it("blocks dispatched edits from stale controls after host switches to read-only", async () => {
        const onfieldedit = vi.fn(() => JSON.stringify(payload()));
        const result = render({ onfieldedit });
        const stale = input(result.target, "Memo");
        await result.setReadonly(true);
        await type(stale, "must not apply");
        result.target.querySelector("output")?.dispatchEvent(new Event("input", { bubbles: true }));
        expect(onfieldedit).not.toHaveBeenCalled();
        expect(result.onchange).not.toHaveBeenCalled();
        expect(result.payload().memo).toBe("exact original");
    });
    it.each([
        { version: 1, nodes: [{ kind: "field", field: "memo", value: "forged" }] },
        { version: 1, nodes: [{ kind: "field", field: "memo", style: "display:none" }] },
        { view: view(), referencedFields: ["memo"], requiresCompleteHostReview: true },
    ])("revalidates hostile structural props and blocks canonical fallback", (raw) => {
        const result = render({ view: raw });
        expect(result.target.querySelector(".app-owned-view")).toBeNull();
        expect(result.target.textContent).toContain("could not be verified");
        expect(
            result.target.querySelector<HTMLTextAreaElement>('textarea[aria-label="Item 1 — Memo"]')
                ?.value,
        ).toBe("exact original");
        expect(result.onblocked).toHaveBeenLastCalledWith(true);
        expect(result.target.querySelector<HTMLInputElement>("input")?.disabled).toBe(true);
    });
    it("does not invoke app getters and drops an invalid view when schema changes", async () => {
        const getter = vi.fn(() => "memo");
        const node = { kind: "field" };
        Object.defineProperty(node, "field", { enumerable: true, get: getter });
        const result = render({ view: { version: 1, nodes: [node] } });
        expect(getter).not.toHaveBeenCalled();
        await result.setView(view());
        expect(result.target.querySelector(".app-owned-view")).not.toBeNull();
        const changed: LocalAppAction = {
            ...action(),
            draftSchema: {
                type: "object",
                additionalProperties: false,
                properties: { quantity: { type: "number" } },
            },
        };
        await result.setAction(changed);
        expect(result.target.querySelector(".app-owned-view")).toBeNull();
        expect(result.target.querySelector('input[aria-label="Item 1 — Memo"]')).toBeNull();
        expect(result.onblocked).toHaveBeenLastCalledWith(true);
    });
    it("keeps default behavior unchanged when no view is supplied", async () => {
        const result = render({ view: undefined });
        expect(
            result.target.querySelector(".app-owned-view,.host-exact-review,.host-review-notice"),
        ).toBeNull();
        expect(
            result.target.querySelector<HTMLTextAreaElement>('textarea[aria-label="Item 1 — Memo"]')
                ?.value,
        ).toBe("exact original");
        expect(result.onblocked).toHaveBeenLastCalledWith(false);
        await result.setView({ version: 2, nodes: [] });
        expect(result.onblocked).toHaveBeenLastCalledWith(true);
        await result.setView(undefined);
        expect(result.onblocked).toHaveBeenLastCalledWith(false);
    });
    it("repeats the tree for canonical rows and reviews the complete envelope", () => {
        const base = action();
        const definition: LocalAppAction = {
            ...base,
            draftSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    rows: { type: "array", items: base.draftSchema },
                    routingHint: { type: "string" },
                },
            },
            handoff: { kind: "wrapped-list", field: "rows" },
        };
        const result = render({
            action: definition,
            payload: {
                rows: [payload(), { ...payload(), quantity: 19 }],
                routingHint: "retained envelope",
            },
        });
        expect(result.target.querySelectorAll(".app-owned-view")).toHaveLength(2);
        expect(
            result.target.querySelector<HTMLInputElement>('input[aria-label="Item 2 — Quantity"]')
                ?.value,
        ).toBe("19");
        expect(result.target.querySelector(".host-exact-review")?.textContent).toContain(
            "retained envelope",
        );
    });
    it("keeps named choices, companion assignment and manual default protection", async () => {
        const base = action();
        if (base.draftSchema.type !== "object") throw new Error("schema");
        const definition: LocalAppAction = {
            ...base,
            draftSchema: {
                ...base.draftSchema,
                properties: {
                    ...base.draftSchema.properties,
                    category: { type: "string" },
                    categoryName: { type: "string" },
                },
            },
            draftEditor: {
                version: 1,
                choices: [
                    {
                        field: "category",
                        label: "Saved category",
                        noneLabel: "None",
                        options: [
                            {
                                value: "one",
                                label: "First choice",
                                assign: [{ field: "categoryName", value: "First" }],
                                defaults: [{ field: "quantity", value: 11 }],
                            },
                            {
                                value: "two",
                                label: "Second choice",
                                assign: [{ field: "categoryName", value: "Second" }],
                                defaults: [{ field: "quantity", value: 22 }],
                            },
                        ],
                    },
                ],
            },
        };
        const custom: LocalAppViewV1 = {
            version: 1,
            nodes: [
                {
                    kind: "row",
                    children: [
                        { kind: "field", field: "category" },
                        { kind: "field", field: "quantity" },
                    ],
                },
            ],
        };
        let session = initializeLocalAppDraftChoices(definition, JSON.stringify(payload()));
        const onfieldedit = vi.fn((item, field, value) => {
            session = editLocalAppDraftScalar(session, item, field, value);
            void result.update(session.editorJson);
            return session.editorJson;
        });
        const onchoiceedit = vi.fn((item, field, value) => {
            session = selectLocalAppDraftChoice(session, item, field, value);
            void result.update(session.editorJson);
            return session.editorJson;
        });
        const result = render({ view: custom, action: definition, onfieldedit, onchoiceedit });
        const select = result.target.querySelector<HTMLSelectElement>(
            'select[aria-label="Item 1 — Saved category"]',
        )!;
        select.value = "option-0";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        await tick();
        expect(result.payload()).toMatchObject({
            category: "one",
            categoryName: "First",
            quantity: 11,
        });
        await type(input(result.target, "Quantity"), "31");
        select.value = "option-1";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        await tick();
        expect(result.payload()).toMatchObject({
            category: "two",
            categoryName: "Second",
            quantity: 31,
        });
        expect(result.onchange).not.toHaveBeenCalled();
        expect(onchoiceedit).toHaveBeenCalledTimes(2);
    });
    it("keeps generic controls at a 44px minimum without app CSS or executable markup", () => {
        const source = readFileSync(
            resolve("app/src/components_shared/PrivateAppDraftFields.svelte"),
            "utf8",
        );
        expect(source).toContain("min-height: 44px");
        expect(source).toContain(".app-owned-view .field input,");
        expect(source).not.toContain("{@html");
        expect(source).not.toContain("<iframe");
    });
});
