import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const componentPath = resolve(process.cwd(), "app/src/components/home/ActionCardContent.svelte");

function compactComponentSource(): string {
    return readFileSync(componentPath, "utf8").replace(/\s+/g, " ");
}

describe("action-card trust presentation", () => {
    it("does not label backend-attested card content as untrusted", () => {
        const source = compactComponentSource();

        expect(source).toContain(
            '{#if !cardContentAttested} <span class="app-verification">Directory binding only; card content is untrusted</span> {/if}',
        );
        expect(source).toContain(
            '{#if !cardContentAttested} <span class="sender-title-label">Untrusted card text</span> {/if}',
        );
    });

    it("retains both warnings and fail-closed actions for unattested content", () => {
        const source = compactComponentSource();

        expect(source).toContain("!cardContentAttested ||");
        expect(source).toContain(
            'response === "confirm" && (!cardContentAttested || !finalConfirmationAvailable)',
        );
        expect(source).toContain("disabled={!pending || readonly || !cardContentAttested}");
        expect(source).toContain("Directory binding only; card content is untrusted");
        expect(source).toContain("Untrusted card text");
    });
});
