import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRawSnippet, flushSync, mount, unmount } from "svelte";
import { portalState } from "../../../component-lib/src/utils/portalState";
import MenuIcon from "./MenuIcon.svelte";

vi.mock("component-lib", async () => {
    const { portalState } = await import("../../../component-lib/src/utils/portalState");
    return {
        portalState,
        reposition: vi.fn(),
        centerOfScreen: () => ({ x: 0, y: 0 }),
    };
});

vi.mock("@client", async () => {
    const { writable } = await import("svelte/store");
    return { mobileWidth: writable(false) };
});

const mounted = new Set<ReturnType<typeof mount>>();

function createMenu(label: string) {
    const target = document.createElement("div");
    document.body.append(target);
    const instance = mount(MenuIcon, {
        target,
        props: {
            menuItems: createRawSnippet(() => ({
                render: () => `<button data-menu="${label}">Propose action ${label}</button>`,
            })),
        },
    });
    mounted.add(instance);
    flushSync();
    return instance;
}

async function destroyMenu(instance: ReturnType<typeof createMenu>) {
    mounted.delete(instance);
    await unmount(instance);
    flushSync();
}

const visible = (label: string) => document.querySelector(`[data-menu="${label}"]`);

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(async () => {
    // Remove any leaked once-listeners from the pre-fix implementation too.
    portalState.close();
    for (const instance of mounted) await unmount(instance);
    mounted.clear();
    vi.runAllTimers();
    document.dispatchEvent(new MouseEvent("click"));
    document.body.replaceChildren();
    vi.useRealTimers();
});

describe("model/app action menu portal ownership", () => {
    it("keeps B open when an unrelated unopened virtual message A is destroyed", async () => {
        const a = createMenu("A");
        const b = createMenu("B");
        b.showMenu();
        flushSync();
        expect(visible("B")).not.toBeNull();

        await destroyMenu(a);

        expect(visible("B")).not.toBeNull();
    });

    it("does not let a destroyed A timer close B during B's opening interval", async () => {
        const a = createMenu("A");
        a.showMenu();
        flushSync();
        vi.advanceTimersByTime(50);
        const b = createMenu("B");
        b.showMenu();
        flushSync();
        expect(visible("A")).toBeNull();
        expect(visible("B")).not.toBeNull();

        // A's old listener would be armed now; B's own 100ms delay has not elapsed.
        vi.advanceTimersByTime(50);
        document.dispatchEvent(new MouseEvent("click"));
        flushSync();

        expect(visible("B")).not.toBeNull();
    });

    it("removes A's already armed document listener when B replaces A", () => {
        const a = createMenu("A");
        a.showMenu();
        flushSync();
        vi.advanceTimersByTime(100);
        const b = createMenu("B");
        b.showMenu();
        flushSync();
        expect(visible("B")).not.toBeNull();

        document.dispatchEvent(new MouseEvent("click"));
        flushSync();

        expect(visible("B")).not.toBeNull();
    });

    it("still closes the menu when its owning message is destroyed", async () => {
        const b = createMenu("B");
        b.showMenu();
        flushSync();
        expect(visible("B")).not.toBeNull();

        await destroyMenu(b);

        expect(visible("B")).toBeNull();
    });

    it("still closes B on an outside click after B's own delay", () => {
        const b = createMenu("B");
        b.showMenu();
        flushSync();
        vi.advanceTimersByTime(100);

        document.dispatchEvent(new MouseEvent("click"));
        flushSync();

        expect(visible("B")).toBeNull();
    });
});
