// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { flushSync, mount, tick, unmount } from "svelte";
import { compile, preprocess } from "svelte/compiler";
import { writable, type Writable } from "svelte/store";
import sveltePreprocess from "svelte-preprocess";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Harness from "./ActionCardLayout.spec.shell.svelte";

type View = {
    title: string;
    appName: string;
    appId: string;
    status?: string;
    consumed?: boolean;
    wide?: boolean;
    showActions?: boolean;
    disabled?: boolean;
};
const initial: View = { title: "Add entry", appName: "Example app", appId: "example" };
let state: Writable<View>;
let target: HTMLDivElement;
let mounted: ReturnType<typeof mount> | undefined;
const confirm = vi.fn();
const cancel = vi.fn();
const outerClick = vi.fn();
const outerKey = vi.fn();
const settle = async () => {
    await tick();
    flushSync();
};
const render = async (overrides: Partial<View> = {}) => {
    state = writable({ ...initial, ...overrides });
    mounted = mount(Harness, {
        target,
        props: {
            view: state,
            onConfirm: confirm,
            onCancel: cancel,
            onOuterClick: outerClick,
            onOuterKey: outerKey,
        },
    });
    flushSync();
    await settle();
};
const header = () => target.querySelector<HTMLElement>(".header")!;
const card = () => target.querySelector<HTMLElement>(".action-card")!;
const body = () => target.querySelector("[data-test-body]");

beforeEach(() => {
    vi.clearAllMocks();
    target = document.createElement("div");
    document.body.append(target);
});
afterEach(async () => {
    if (mounted) await unmount(mounted);
    mounted = undefined;
    document.body.replaceChildren();
});

describe("original action-card presentation shared with local cards", () => {
    it("shows the original identity, title, body and actions without inventing verification", async () => {
        await render();
        expect(target.querySelector(".app-name")?.textContent).toBe(initial.appName);
        expect(target.querySelector(".app-id")?.textContent).toBe(initial.appId);
        expect(target.querySelector(".title")?.textContent).toBe(initial.title);
        expect(body()).not.toBeNull();
        expect(target.querySelector(".actions .confirm")).not.toBeNull();
        expect(target.querySelector(".state, .chevron, .app-verification, iframe")).toBeNull();
        expect(confirm).not.toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
    });

    it("leaves a pending header inert", async () => {
        await render();
        header().click();
        header().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        await settle();
        expect(header().hasAttribute("role")).toBe(false);
        expect(header().hasAttribute("tabindex")).toBe(false);
        expect(card().classList.contains("collapsed")).toBe(false);
        expect(body()).not.toBeNull();
    });

    it("defaults consumed cards to the original collapsed status strip", async () => {
        await render({ consumed: true, status: "confirmed" });
        expect(card().classList.contains("collapsed")).toBe(true);
        expect(body()).toBeNull();
        expect(target.querySelector(".actions")).toBeNull();
        expect(target.querySelector(".state-confirmed")?.textContent).toBe("confirmed");
        expect(header().getAttribute("role")).toBe("button");
        expect(header().tabIndex).toBe(0);
        header().click();
        await settle();
        expect(body()).not.toBeNull();
        expect(outerClick).not.toHaveBeenCalled();
        expect(confirm).not.toHaveBeenCalled();
    });

    it.each(["Enter", " "])(
        "toggles consumed cards with %s and prevents bubble/menu activation",
        async (key) => {
            await render({ consumed: true, status: "cancelled" });
            const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
            header().dispatchEvent(event);
            await settle();
            expect(event.defaultPrevented).toBe(true);
            expect(outerKey).not.toHaveBeenCalled();
            expect(body()).not.toBeNull();
        },
    );

    it("collapses when the caller marks the card consumed, without running any action", async () => {
        await render({ wide: true });
        expect(card().classList.contains("has-frame")).toBe(true);
        state.update((view) => ({ ...view, consumed: true, status: "cancelled" }));
        await settle();
        expect(body()).toBeNull();
        expect(confirm).not.toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
    });

    it("leaves button availability and callbacks with the caller", async () => {
        await render({ disabled: true });
        target.querySelector<HTMLButtonElement>(".confirm")!.click();
        expect(confirm).not.toHaveBeenCalled();
        state.update((view) => ({ ...view, disabled: false }));
        await settle();
        target.querySelector<HTMLButtonElement>(".confirm")!.click();
        target.querySelector<HTMLButtonElement>(".cancel")!.click();
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(cancel).toHaveBeenCalledTimes(1);
        state.update((view) => ({ ...view, showActions: false }));
        await settle();
        expect(target.querySelector(".actions")).toBeNull();
    });

    it("escapes caller text rather than introducing an HTML or frame capability", async () => {
        await render({ title: "<iframe src='https://invalid.example'>", appName: "<img src=x>" });
        expect(target.querySelector("iframe, img")).toBeNull();
        expect(target.querySelector(".title")?.textContent).toContain("<iframe");
    });
});

describe("published PR stylesheet and controller parity", () => {
    const path = (name: string) => fileURLToPath(new URL(name, import.meta.url));
    const source = (path: string) =>
        readFileSync(new URL(path, import.meta.url), "utf8").replaceAll("\r\n", "\n");
    const sha = (value: string) => createHash("sha256").update(value).digest("hex");

    it("extracts the original SCSS verbatim, keeping the original controller and markup unchanged", () => {
        // Published PR2 0bf6a357ec45fec3bdeb958c7f224e8780e0d9bf: only the style
        // block is replaced by the shared mixin. The repository formatter leaves
        // this original controller/template byte-identical (apart from checkout EOLs).
        const original = source("../components/home/ActionCardContent.svelte");
        expect(sha(original.slice(0, original.indexOf("</script>") + "</script>".length))).toBe(
            "59dddfe82a7608a935051198776960d2320ae0821839bb51b10ebf3d303ca665",
        );
        expect(sha(original.slice(0, original.indexOf('<style lang="scss">')))).toBe(
            "e084bc49ce322fd8b5acabd1d1ea13b7953555bf5fe648c49f160028edbdbf81",
        );
        const shared = source("../styles/actionCard.scss");
        const body = shared.slice(
            shared.indexOf("@mixin actionCardStyles() {") + 27,
            shared.lastIndexOf("}"),
        );
        expect(sha(body.trim())).toBe(
            "e62249446b7824167bddeb9a635e31ef4c35db79eb464060729209dccb979efe",
        );
        expect(original).toContain("@include actionCard.actionCardStyles();");
    });

    it("bounds shared CSS to the layout while styling caller snippets with original dimensions", async () => {
        const filename = path("./ActionCardLayout.svelte");
        const processed = await preprocess(
            source("./ActionCardLayout.svelte"),
            sveltePreprocess(),
            { filename },
        );
        const output = compile(processed.code, { filename, css: "external" });
        const css = output.css!.code;
        expect(css).toMatch(/\.action-card-layout\.svelte-[\w-]+\s+\.action-card\s*\{/);
        expect(css).toMatch(/\.action-card-layout\.svelte-[\w-]+\s+\.actions button\.confirm\s*\{/);
        expect(css).toContain("width: min(360px, 100%)");
        expect(css).toContain("width: min(420px, 100%)");
        expect(css).toContain("width: min(480px, 100%)");
        expect(css).toMatch(/@media[\s\S]*width: 100%/);
        expect(css).not.toMatch(/\.confirm[.:]svelte-/);
    });
});
