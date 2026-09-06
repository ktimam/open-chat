import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
    resolve(__dirname, "../components_mobile/home/ChatSummary.svelte"),
    "utf8",
);

describe("mobile chat-summary menu activation", () => {
    it("selects a chat row without bubbling into the desktop menu fallback", () => {
        expect(source).toContain("function selectChatFromRow(event?: MouseEvent)");

        const handlerStart = source.indexOf("function selectChatFromRow(event?: MouseEvent)");
        const handler = source.slice(handlerStart, handlerStart + 180);
        expect(handler).toContain("event?.stopPropagation()");
        expect(handler.indexOf("event?.stopPropagation()")).toBeLessThan(
            handler.indexOf("selectChat()"),
        );

        expect(source).toContain("onClick={selectChatFromRow}");
        expect(source).toContain('mobileMode={"longpress"}');
        expect(source).toContain("<MenuItem onclick={selectChat}>");
    });
});
