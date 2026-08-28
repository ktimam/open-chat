import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const APP_ROOT = resolve(__dirname, "..");

function source(path: string): string {
    return readFileSync(resolve(APP_ROOT, path), "utf8");
}

describe("Process with AI message menus", () => {
    it("keeps a distinct classic menu item next to Propose action", () => {
        const menu = source("components/home/ChatMessageMenu.svelte");

        expect(menu).toContain("onRunAiAction?: () => void");
        expect(menu).toContain("onProcessWithAi?: () => void");
        expect(menu).toContain('i18nKey("aiActions.propose")');
        expect(menu).toContain('i18nKey("aiActions.processWithAi")');
        expect(menu).toContain("<MenuItem onclick={onProcessWithAi}>");
    });

    it("keeps a distinct mobile menu item next to Propose action", () => {
        const options = source("components_mobile/home/ChatMessageOptions.svelte");

        expect(options).toContain('| "proposeAiAction"');
        expect(options).toContain('| "processWithAi"');
        expect(options).toContain('return "aiActions.propose"');
        expect(options).toContain('return "aiActions.processWithAi"');
        expect(options).toContain("onRunAiAction?.()");
        expect(options).toContain("onProcessWithAi?.()");
    });

    it.each([
        ["classic", "components/home/ChatMessage.svelte"],
        ["mobile", "components_mobile/home/ChatMessage.svelte"],
    ])("routes %s selected-message text/image through runLocalAiCommand", (_tree, path) => {
        const component = source(path);

        expect(component).toContain("async function processMessageWithAi()");
        expect(component).toContain("await runLocalAiMessageFlow({");
        expect(component).toContain("readInput: () => contentToInput(capturedContent, client)");
        expect(component).toContain("infer: runLocalAiCommand");
        expect(component).toContain("PROCESS_WITH_AI_TEXT_PROMPT");
        expect(component).toContain("PROCESS_WITH_AI_IMAGE_PROMPT");
        expect(component).toContain("onRunAiAction={runAiActionHandler}");
        expect(component).toContain("onProcessWithAi={canProcessWithAi");
    });

    it.each([
        ["classic", "components/home/ChatMessage.svelte"],
        ["mobile", "components_mobile/home/ChatMessage.svelte"],
    ])("wires the captured %s destination into the tested stale boundary", (_tree, path) => {
        const component = source(path);
        const run = component.indexOf("await runLocalAiMessageFlow({");
        const post = component.indexOf("sendReply: (text) =>", run);

        expect(component).toContain("const capturedViewer = $currentUserIdStore");
        expect(component).toContain("const capturedContext = { chatId, threadRootMessageIndex }");
        expect(component).toContain("msg.content === capturedContent");
        expect(run).toBeGreaterThan(-1);
        expect(post).toBeGreaterThan(run);
        expect(component.slice(run, post + 500)).toContain("stillCurrent,");
        expect(component.slice(post, post + 220)).toContain("capturedContext");
    });
});
