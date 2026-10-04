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
