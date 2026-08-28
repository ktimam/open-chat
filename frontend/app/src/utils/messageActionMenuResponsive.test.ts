import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(__dirname, "../components/home/ChatMessage.svelte"), "utf8");

describe("message action menu responsive hover", () => {
    it("keeps the menu hover-revealable on a narrow viewport with a fine pointer", () => {
        const mobileRule = source.indexOf("@include mobile()");
        const finePointerRule = source.indexOf("@media (hover: hover) and (pointer: fine)");

        expect(mobileRule).toBeGreaterThanOrEqual(0);
        expect(finePointerRule).toBeGreaterThan(mobileRule);

        const finePointerBody = source.slice(finePointerRule, finePointerRule + 900);
        expect(finePointerBody).toContain(":global(.bubble-wrapper .menu)");
        expect(finePointerBody).toContain("display: flex");
        expect(finePointerBody).toContain(
            ":global(.bubble-wrapper:hover .menu:not(:has(.menu-icon.open)))",
        );
        expect(finePointerBody).toContain("z-index: 1");
        expect(finePointerBody).toContain("opacity: 1");
        expect(finePointerBody).not.toContain(
            "animation: show-bubble-menu 200ms ease-in-out forwards",
        );
    });
});
