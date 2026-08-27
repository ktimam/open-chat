import { beforeEach, describe, expect, it } from "vitest";
import type { RunAiActionResult } from "@shared";
import {
    isSemanticDuplicateBrowserImageResult,
    resetSemanticImageDuplicateGuardForTests,
} from "./imageSemanticDuplicateGuard";

const scope = { appId: 7, appRevision: 3n, actionId: "ledger.add" };
const card = { kind: "action_card_content" } as Extract<
    RunAiActionResult,
    { kind: "ready" }
>["card"];
const ready = (extracted: Record<string, unknown>): RunAiActionResult => ({
    kind: "ready",
    card,
    extracted,
});
const evidence = (
    requestId: number,
    image: string,
    selectionGeneration = 4,
    selectedModelId = "selected-vlm",
) => ({
    requestId,
    selectionGeneration,
    selectedModelId,
    structuredJsonAction: true,
    effectiveImageSha256: image.repeat(64),
});

describe("semantic browser image duplicate guard", () => {
    beforeEach(resetSemanticImageDuplicateGuardForTests);

    it("canonicalizes final candidate keys and rejects one different-image semantic replay", () => {
        expect(
            isSemanticDuplicateBrowserImageResult(
                scope,
                evidence(1, "1"),
                ready({ amount: 12_900, kind: "settlement", note: "same" }),
            ),
        ).toBe(false);
        expect(
            isSemanticDuplicateBrowserImageResult(
                scope,
                evidence(2, "2"),
                ready({ note: "same", kind: "settlement", amount: 12_900 }),
            ),
        ).toBe(true);
    });

    it("advances after rejection so same-image retry and every later distinct result remain usable", () => {
        const same = ready({ amount: 12_900, kind: "settlement" });
        expect(isSemanticDuplicateBrowserImageResult(scope, evidence(1, "1"), same)).toBe(false);
        expect(isSemanticDuplicateBrowserImageResult(scope, evidence(2, "2"), same)).toBe(true);
        expect(isSemanticDuplicateBrowserImageResult(scope, evidence(3, "2"), same)).toBe(false);
        expect(
            isSemanticDuplicateBrowserImageResult(
                scope,
                evidence(4, "3"),
                ready({ amount: 13_500, kind: "settlement" }),
            ),
        ).toBe(false);
    });

    it("isolates action scope, model, and selection generation", () => {
        const same = ready({ amount: 12_900, kind: "settlement" });
        expect(isSemanticDuplicateBrowserImageResult(scope, evidence(1, "1"), same)).toBe(false);
        expect(
            isSemanticDuplicateBrowserImageResult(
                { ...scope, actionId: "ledger.edit" },
                evidence(2, "2"),
                same,
            ),
        ).toBe(false);
        expect(isSemanticDuplicateBrowserImageResult(scope, evidence(3, "3", 5), same)).toBe(false);
        expect(
            isSemanticDuplicateBrowserImageResult(scope, evidence(4, "4", 5, "another-vlm"), same),
        ).toBe(false);
    });

    it("ignores non-ready results and malformed runtime evidence", () => {
        expect(
            isSemanticDuplicateBrowserImageResult(scope, evidence(1, "1"), {
                kind: "error",
                error: "failed",
            }),
        ).toBe(false);
        expect(
            isSemanticDuplicateBrowserImageResult(
                scope,
                { ...evidence(2, "2"), effectiveImageSha256: "short" },
                ready({ amount: 1 }),
            ),
        ).toBe(false);
        expect(
            isSemanticDuplicateBrowserImageResult(
                scope,
                { ...evidence(3, "3"), structuredJsonAction: false },
                ready({ amount: 1 }),
            ),
        ).toBe(false);
    });
});
