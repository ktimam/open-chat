import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SURFACES = ["../components/Toast.svelte", "../components_mobile/Toast.svelte"] as const;

describe("failure toast dismissibility", () => {
    for (const relative of SURFACES) {
        it(`${relative} keeps the close control touchable and inside a narrow viewport`, () => {
            const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

            expect(source).toMatch(/<button\r?\n\s+type="button"\r?\n\s+class="close"/);
            expect(source).toContain('aria-label="Dismiss notification"');
            expect(source).toContain("onclick={toastStore.hideToast}");
            expect(source).toContain("box-sizing: border-box;");
            expect(source).toContain("padding: 0 $sp4;");
            expect(source).toContain("margin: 0;");
            expect(source).toContain("min-width: 0;");
            expect(source).not.toContain("margin: 0 $sp4;");
            expect(source).toContain('class="text"');
            expect(source).toContain("overflow-wrap: anywhere;");
            expect(source).toContain("touch-action: manipulation;");
        });
    }
});
