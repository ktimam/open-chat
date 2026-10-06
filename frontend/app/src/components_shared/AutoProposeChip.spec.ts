// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { addMessages, init } from "svelte-i18n";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
    window.matchMedia = ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        dispatchEvent: () => true,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
    })) as typeof window.matchMedia;
});
vi.mock("../actions/translatable", () => ({ translatable: () => ({}) }));

import DesktopChip from "../components/home/AutoProposeChip.svelte";
import MobileChip from "../components_mobile/home/AutoProposeChip.svelte";
import desktopMessageSource from "../components/home/ChatMessage.svelte?raw";
import mobileMessageSource from "../components_mobile/home/ChatMessage.svelte?raw";
import en from "../i18n/en.json";

const mounted: ReturnType<typeof mount>[] = [];
const messageSources = [
    ["desktop", desktopMessageSource],
    ["mobile", mobileMessageSource],
] as const;

// The mounted tests below exercise both real chips; these invariants also cover the enclosing
// production message handlers, whose stores/auth/chat dependencies are deliberately not mocked.
describe.each(messageSources)("%s message proposal wiring", (_name, source) => {
    it("keeps the suggestion after successful extraction and only dismisses explicitly", () => {
        const handler = source.match(
            /async function proposeLocalSuggestedAction[\s\S]+?(?=\n    function muteAutoProposeSuggestions)/,
        )?.[0];
        expect(handler).toBeDefined();
        expect(handler).toContain("await runAiActionHandler(undefined, suggestion)");
        expect(handler).not.toContain("dismissLocalAutoProposeSuggestion");
        expect(source).toMatch(/onDismiss=\{\(\) =>\s*dismissLocalAutoProposeSuggestion/);
        expect(source).toMatch(
            /proposePrivateAppMessage\(client, capturedContent, \{\s*stillCurrent,\s*onPhase,\s*regenerate: true,/,
        );
    });
});
beforeAll(async () => {
    addMessages("en", en);
    await init({ fallbackLocale: "en", initialLocale: "en" });
});
afterEach(async () => {
    for (const instance of mounted) await unmount(instance);
    mounted.length = 0;
    document.body.replaceChildren();
});

describe.each([
    ["desktop", DesktopChip],
    ["mobile", MobileChip],
] as const)("%s explicit proposal chip", (_name, Chip) => {
    function render(options: { again?: boolean; busy?: boolean; disabled?: boolean } = {}) {
        const target = document.createElement("div");
        document.body.append(target);
        const onPropose = vi.fn();
        const onDismiss = vi.fn();
        mounted.push(
            flushSync(() =>
                mount(Chip, {
                    target,
                    props: {
                        me: true,
                        offset: false,
                        title: "Test app — Test action",
                        busyResourceKey: {
                            kind: "resource_key",
                            key: "aiApps.autoPropose.working",
                            lowercase: false,
                        },
                        onPropose,
                        onDismiss,
                        onMute: vi.fn(),
                        ...options,
                    },
                }),
            ),
        );
        const chip = target.querySelector<HTMLElement>(".chip, .auto-propose-chip")!;
        expect(chip).not.toBeNull();
        return { target, chip, onPropose, onDismiss };
    }

    it("keeps the original first-proposal label and waits for an explicit tap", () => {
        const { target, chip, onPropose } = render();
        expect(target.textContent).toContain("Propose Test app — Test action?");
        expect(target.textContent).not.toContain("Propose again");
        expect(onPropose).not.toHaveBeenCalled();
        chip.click();
        expect(onPropose).toHaveBeenCalledOnce();
    });

    it("labels a retained message's new extraction Propose again", () => {
        const { target, chip, onPropose } = render({ again: true });
        expect(target.textContent).toContain("Propose again — Test app — Test action?");
        expect(onPropose).not.toHaveBeenCalled();
        chip.click();
        expect(onPropose).toHaveBeenCalledOnce();
    });

    it.each([{ busy: true }, { disabled: true }])(
        "still prevents overlapping proposals when %j",
        (options) => {
            const { chip, onPropose } = render({ again: true, ...options });
            chip.click();
            expect(onPropose).not.toHaveBeenCalled();
        },
    );

    it("dismisses the repeated-proposal suggestion without starting extraction", () => {
        const { target, onDismiss, onPropose } = render({ again: true });
        target.querySelector<HTMLButtonElement>("button.dismiss")!.click();
        expect(onDismiss).toHaveBeenCalledOnce();
        expect(onPropose).not.toHaveBeenCalled();
    });
});
