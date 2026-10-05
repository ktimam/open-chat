// @vitest-environment jsdom
import { flushSync, mount, tick, unmount } from "svelte";
import { writable, type Writable } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SurfaceHarness from "./LocalAppCardSurface.spec.shell.svelte";

type SurfaceState = {
    target?: HTMLElement;
    inline: boolean;
    open: boolean;
    onClose?: () => void;
};
let state: Writable<SurfaceState>;
let home: HTMLDivElement;
let mounted: ReturnType<typeof mount> | undefined;
const calls = {
    close: vi.fn(),
    editorMount: vi.fn(),
    editorDestroy: vi.fn(),
    editorClick: vi.fn(),
};
const settle = async () => {
    await tick();
    flushSync();
};
const anchor = () => {
    const node = document.createElement("div");
    document.body.append(node);
    return node;
};
const surface = () => document.querySelector<HTMLDivElement>(".card-surface")!;
const editor = () => document.querySelector<HTMLElement>("[data-test-editor]")!;
const input = () => document.querySelector<HTMLInputElement>('input[aria-label="Draft value"]')!;
const homeMarkers = () => {
    const walker = document.createTreeWalker(home, NodeFilter.SHOW_COMMENT);
    const markers: Comment[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
        if (node.nodeValue === "private-card-editor-home") markers.push(node as Comment);
    }
    return markers;
};
const render = async (initial: SurfaceState) => {
    state = writable(initial);
    mounted = mount(SurfaceHarness, {
        target: home,
        props: {
            view: state,
            onClose: calls.close,
            onEditorMount: calls.editorMount,
            onEditorDestroy: calls.editorDestroy,
            onEditorClick: calls.editorClick,
        },
    });
    flushSync();
    await settle();
};
const changeInput = async (value: string) => {
    input().value = value;
    input().dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(document.querySelector('output[aria-label="Bound draft value"]')?.textContent).toBe(
        value,
    );
};

beforeEach(() => {
    vi.clearAllMocks();
    home = document.createElement("div");
    document.body.append(home);
});
afterEach(async () => {
    if (mounted) await unmount(mounted);
    mounted = undefined;
    document.body.replaceChildren();
});

describe("single-editor local app card surface", () => {
    const trigger = () => {
        const button = document.createElement("button");
        button.textContent = "Open saved card";
        document.body.append(button);
        button.focus();
        return button;
    };
    const tab = (shiftKey = false, target: EventTarget = document.activeElement ?? document) => {
        const event = new KeyboardEvent("keydown", {
            key: "Tab",
            shiftKey,
            bubbles: true,
            cancelable: true,
        });
        target.dispatchEvent(event);
        return event;
    };

    it("focuses the modal dialog initially and contains forward/backward Tab at current boundaries", async () => {
        trigger();
        await render({ inline: false, open: true });
        expect(document.activeElement).toBe(editor());
        expect(surface().getAttribute("tabindex")).toBe("-1");
        expect(tab().defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(input());
        expect(tab().defaultPrevented).toBe(false);
        const last = editor().querySelectorAll("button")[1];
        last.focus();
        expect(tab().defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(input());
        expect(tab(true).defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(last);
    });

    it.each([
        "disabled",
        "hidden",
        "css-hidden",
        "css-invisible",
        "inert",
        "aria-hidden",
        "negative",
        "disabled-fieldset",
        "closed-details",
    ])("skips %s controls in modal Tab order", async (kind) => {
        await render({ inline: false, open: true });
        const extra = document.createElement("button");
        extra.textContent = "Must be skipped";
        const wrapper = document.createElement(
            kind === "disabled-fieldset"
                ? "fieldset"
                : kind === "closed-details"
                  ? "details"
                  : "div",
        );
        wrapper.append(extra);
        editor().prepend(wrapper);
        if (kind === "disabled") extra.disabled = true;
        if (kind === "hidden") wrapper.hidden = true;
        if (kind === "css-hidden") wrapper.style.display = "none";
        if (kind === "css-invisible") wrapper.style.visibility = "hidden";
        if (kind === "inert") wrapper.setAttribute("inert", "");
        if (kind === "aria-hidden") wrapper.setAttribute("aria-hidden", "true");
        if (kind === "negative") extra.tabIndex = -1;
        if (kind === "disabled-fieldset") (wrapper as HTMLFieldSetElement).disabled = true;
        editor().focus();
        tab();
        expect(document.activeElement).toBe(input());
    });

    it("recomputes controls and holds focus on the dialog when all controls become disabled", async () => {
        await render({ inline: false, open: true });
        input().focus();
        input().disabled = true;
        editor()
            .querySelectorAll("button")
            .forEach((button) => (button.disabled = true));
        expect(tab().defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(editor());
        expect(tab(true).defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(editor());
        input().disabled = false;
        expect(tab().defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(input());
    });

    it("keeps a closed details summary tabbable while excluding its hidden controls", async () => {
        await render({ inline: false, open: true });
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = "Field options";
        const hidden = document.createElement("button");
        hidden.textContent = "Hidden option";
        details.append(summary, hidden);
        editor().prepend(details);
        editor().focus();
        tab();
        expect(document.activeElement).toBe(summary);
        hidden.focus();
        tab();
        expect(document.activeElement).toBe(summary);
    });

    it("uses positive tabindex order and respects an editor-handled Tab event", async () => {
        await render({ inline: false, open: true });
        const first = document.createElement("button");
        first.tabIndex = 1;
        const second = document.createElement("button");
        second.tabIndex = 2;
        editor().append(second, first);
        const close = [...editor().querySelectorAll("button")].find(
            (button) => button.textContent === "Close card",
        )!;
        close.focus();
        tab();
        expect(document.activeElement).toBe(first);
        first.focus();
        tab(true);
        expect(document.activeElement).toBe(close);
        close.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
        tab();
        expect(document.activeElement).toBe(close);
    });

    it("falls back safely when a connected opener is no longer programmatically focusable", async () => {
        const opener = document.createElement("div");
        opener.tabIndex = 0;
        document.body.append(opener);
        opener.focus();
        await render({ inline: false, open: true });
        input().focus();
        opener.removeAttribute("tabindex");
        state.update((value) => ({ ...value, open: false }));
        await settle();
        expect(document.activeElement).toBe(document.body);
        expect(document.body.hasAttribute("tabindex")).toBe(false);
    });

    it("restores the opener when the modal closes and preserves the same pending editor", async () => {
        const opener = trigger();
        await render({ inline: false, open: true });
        const original = input();
        await changeInput("Pending invalid input: 1e");
        original.focus();
        state.update((value) => ({ ...value, open: false }));
        await settle();
        expect(document.activeElement).toBe(opener);
        expect(input()).toBe(original);
        expect(input().value).toBe("Pending invalid input: 1e");
        expect(surface().hidden).toBe(true);
        expect(tab(false, opener).defaultPrevented).toBe(false);
        expect(calls.editorMount).toHaveBeenCalledOnce();
        expect(calls.editorDestroy).not.toHaveBeenCalled();
    });

    it("restores focus on unmount and removes the modal Tab listener", async () => {
        const opener = trigger();
        await render({ inline: false, open: true });
        input().focus();
        await unmount(mounted!);
        mounted = undefined;
        expect(document.activeElement).toBe(opener);
        expect(tab(false, opener).defaultPrevented).toBe(false);
        expect(calls.editorDestroy).toHaveBeenCalledOnce();
    });

    it.each(["missing", "removed", "disabled", "hidden"])(
        "handles a %s modal origin without focusing a dead control",
        async (kind) => {
            const opener = kind === "missing" ? undefined : trigger();
            await render({ inline: false, open: true });
            input().focus();
            if (kind === "removed") opener!.remove();
            if (kind === "disabled") opener!.disabled = true;
            if (kind === "hidden") opener!.hidden = true;
            const originalTabindex = document.body.getAttribute("tabindex");
            state.update((value) => ({ ...value, open: false }));
            await settle();
            expect(document.activeElement).toBe(document.body);
            expect(document.body.getAttribute("tabindex")).toBe(originalTabindex);
        },
    );

    it("does not steal a new external focus target during modal closure", async () => {
        trigger();
        await render({ inline: false, open: true });
        const newer = trigger();
        state.update((value) => ({ ...value, open: false }));
        await settle();
        expect(document.activeElement).toBe(newer);
    });

    it("releases modal focus on transition to inline without remounting or trapping inline Tab", async () => {
        const opener = trigger();
        const messageAnchor = anchor();
        await render({ inline: false, open: true });
        const original = input();
        await changeInput("Still pending");
        original.focus();
        state.set({ inline: true, open: true, target: messageAnchor });
        await settle();
        expect(document.activeElement).toBe(opener);
        expect(input()).toBe(original);
        expect(input().value).toBe("Still pending");
        expect(surface().parentElement).toBe(messageAnchor);
        const last = editor().querySelectorAll("button")[1];
        last.focus();
        expect(tab().defaultPrevented).toBe(false);
        expect(calls.editorMount).toHaveBeenCalledOnce();
        expect(calls.editorDestroy).not.toHaveBeenCalled();
    });

    it("never takes or traps focus when initially inline", async () => {
        const opener = trigger();
        await render({ inline: true, open: true, target: anchor() });
        expect(document.activeElement).toBe(opener);
        expect(surface().hasAttribute("tabindex")).toBe(false);
        input().focus();
        expect(tab(true).defaultPrevented).toBe(false);
    });

    it("cancels deferred focus when a modal is closed before the next tick", async () => {
        const opener = trigger();
        await render({ inline: true, open: true, target: anchor() });
        state.update((value) => ({ ...value, inline: false }));
        flushSync();
        state.update((value) => ({ ...value, open: false }));
        flushSync();
        await settle();
        expect(document.activeElement).toBe(opener);
        expect(surface().hidden).toBe(true);
    });

    it("keeps existing Escape dismissal and restores focus through the resulting close", async () => {
        const opener = trigger();
        await render({ inline: false, open: true });
        state.update((value) => ({
            ...value,
            onClose: () => {
                calls.close();
                state.update((current) => ({ ...current, open: false }));
            },
        }));
        await settle();
        input().focus();
        input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await settle();
        expect(calls.close).toHaveBeenCalledOnce();
        expect(document.activeElement).toBe(opener);
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        expect(calls.close).toHaveBeenCalledOnce();
    });
    it("returns the same live editor to its hidden home when an anchor disappears and moves it to a replacement", async () => {
        const firstAnchor = anchor();
        await render({ target: firstAnchor, inline: true, open: true });
        const originalSurface = surface();
        const originalEditor = editor();
        const originalInput = input();
        expect(originalSurface.parentElement).toBe(firstAnchor);
        expect(originalSurface.hidden).toBe(false);
        expect(originalSurface.classList.contains("inline")).toBe(true);
        expect(homeMarkers()).toHaveLength(1);
        expect(document.querySelectorAll("[data-test-editor]")).toHaveLength(1);
        expect(calls.editorMount).toHaveBeenCalledExactlyOnceWith(originalEditor);

        await changeInput("Uncommitted value including an invalid edit: 1e");
        firstAnchor.remove();
        state.set({ target: undefined, inline: true, open: true });
        await settle();
        expect(surface()).toBe(originalSurface);
        expect(surface().parentElement).toBe(home);
        expect(surface().hidden).toBe(true);
        expect(editor()).toBe(originalEditor);
        expect(input()).toBe(originalInput);
        expect(input().value).toBe("Uncommitted value including an invalid edit: 1e");
        expect(homeMarkers()[0].nextSibling).toBe(originalSurface);
        expect(calls.editorMount).toHaveBeenCalledOnce();
        expect(calls.editorDestroy).not.toHaveBeenCalled();

        const replacement = anchor();
        state.set({ target: replacement, inline: true, open: true });
        await settle();
        expect(surface()).toBe(originalSurface);
        expect(surface().parentElement).toBe(replacement);
        expect(surface().hidden).toBe(false);
        expect(editor()).toBe(originalEditor);
        expect(input()).toBe(originalInput);
        expect(input().value).toBe("Uncommitted value including an invalid edit: 1e");
        expect(document.querySelectorAll("[data-test-editor]")).toHaveLength(1);
        await changeInput("Still bound after reattachment");
        originalEditor.querySelector<HTMLButtonElement>("button")!.click();
        expect(calls.editorClick).toHaveBeenCalledOnce();
        expect(calls.editorMount).toHaveBeenCalledOnce();
        expect(calls.editorDestroy).not.toHaveBeenCalled();
        expect(calls.close).not.toHaveBeenCalled();
    });

    it("moves the editor directly between connected anchors without duplicating it or resetting bound fields", async () => {
        const firstAnchor = anchor();
        const replacement = anchor();
        await render({ target: firstAnchor, inline: true, open: true });
        const originalSurface = surface();
        const originalInput = input();
        await changeInput("Pending field edit");
        state.set({ target: replacement, inline: true, open: true });
        await settle();
        expect(firstAnchor.childElementCount).toBe(0);
        expect(surface()).toBe(originalSurface);
        expect(surface().parentElement).toBe(replacement);
        expect(input()).toBe(originalInput);
        expect(input().value).toBe("Pending field edit");
        expect(document.querySelectorAll("[data-test-editor]")).toHaveLength(1);
        expect(homeMarkers()).toHaveLength(1);
        expect(calls.editorMount).toHaveBeenCalledOnce();
        expect(calls.editorDestroy).not.toHaveBeenCalled();
    });

    it("keeps an inline card hidden at home when its supplied anchor is already disconnected", async () => {
        const detachedAnchor = document.createElement("div");
        await render({ target: detachedAnchor, inline: true, open: true });
        expect(surface().parentElement).toBe(home);
        expect(surface().hidden).toBe(true);
        expect(detachedAnchor.childElementCount).toBe(0);
        expect(calls.editorMount).toHaveBeenCalledOnce();
        expect(calls.editorDestroy).not.toHaveBeenCalled();
    });

    it("opens the same editor as a saved-card modal and only dismisses a true backdrop click", async () => {
        const messageAnchor = anchor();
        await render({ target: messageAnchor, inline: true, open: true });
        const originalSurface = surface();
        const originalEditor = editor();
        const originalInput = input();
        await changeInput("Saved card edit");
        state.set({ target: messageAnchor, inline: false, open: true });
        await settle();
        expect(surface()).toBe(originalSurface);
        expect(surface().parentElement).toBe(home);
        expect(surface().hidden).toBe(false);
        expect(surface().classList.contains("modal")).toBe(true);
        expect(surface().classList.contains("inline")).toBe(false);
        expect(editor()).toBe(originalEditor);
        expect(input()).toBe(originalInput);
        expect(input().value).toBe("Saved card edit");
        originalInput.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        expect(calls.close).not.toHaveBeenCalled();
        surface().dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        expect(calls.close).toHaveBeenCalledOnce();
        state.set({ target: messageAnchor, inline: true, open: true });
        await settle();
        surface().dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        expect(calls.close).toHaveBeenCalledOnce();
        expect(calls.editorMount).toHaveBeenCalledOnce();
        expect(calls.editorDestroy).not.toHaveBeenCalled();
    });

    it("keeps close controls and Escape working after portalling and ignores Escape while closed", async () => {
        await render({ target: anchor(), inline: true, open: true });
        [...editor().querySelectorAll("button")]
            .find((node) => node.textContent === "Close card")!
            .click();
        expect(calls.close).toHaveBeenCalledOnce();
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
        expect(calls.close).toHaveBeenCalledOnce();
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        expect(calls.close).toHaveBeenCalledTimes(2);
        state.update((current) => ({ ...current, open: false }));
        await settle();
        expect(surface().hidden).toBe(true);
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        expect(calls.close).toHaveBeenCalledTimes(2);
    });

    it("uses the current close callback after replacement and removes the stable route listener on destroy", async () => {
        await render({ target: anchor(), inline: true, open: true });
        const replacementClose = vi.fn();
        state.update((current) => ({ ...current, onClose: replacementClose }));
        await settle();
        window.dispatchEvent(new PopStateEvent("popstate"));
        expect(replacementClose).toHaveBeenCalledOnce();
        expect(calls.close).not.toHaveBeenCalled();
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        expect(replacementClose).toHaveBeenCalledTimes(2);
        await unmount(mounted!);
        mounted = undefined;
        window.dispatchEvent(new PopStateEvent("popstate"));
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        expect(replacementClose).toHaveBeenCalledTimes(2);
        expect(calls.close).not.toHaveBeenCalled();
        expect(calls.editorMount).toHaveBeenCalledOnce();
        expect(calls.editorDestroy).toHaveBeenCalledOnce();
    });

    it("destroys the portalled editor and home marker exactly once and removes window listeners", async () => {
        const messageAnchor = anchor();
        await render({ target: messageAnchor, inline: true, open: true });
        const originalSurface = surface();
        const originalEditor = editor();
        const marker = homeMarkers()[0];
        window.dispatchEvent(new PopStateEvent("popstate"));
        expect(calls.close).toHaveBeenCalledOnce();
        await unmount(mounted!);
        mounted = undefined;
        expect(originalSurface.isConnected).toBe(false);
        expect(originalEditor.isConnected).toBe(false);
        expect(marker.isConnected).toBe(false);
        expect(messageAnchor.childElementCount).toBe(0);
        expect(homeMarkers()).toHaveLength(0);
        expect(document.querySelectorAll("[data-test-editor], .card-surface")).toHaveLength(0);
        expect(calls.editorMount).toHaveBeenCalledOnce();
        expect(calls.editorDestroy).toHaveBeenCalledOnce();
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        window.dispatchEvent(new PopStateEvent("popstate"));
        expect(calls.close).toHaveBeenCalledOnce();
    });
});
