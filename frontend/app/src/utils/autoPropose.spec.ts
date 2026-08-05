import { describe, expect, it } from "vitest";
import type { AiActionDefinition } from "openchat-shared";
import {
    buildBoundedAutoProposeVocabulary,
    MAX_AUTO_PROPOSE_KEYWORDS,
} from "./autoProposeVocabulary";

function action(name: string, keywordCount: number): AiActionDefinition {
    return {
        name,
        description: "bounded vocabulary fixture",
        promptTemplate: "return structured data",
        responseSchema: { type: "object" },
        endpoint: "https://app.example/actions",
        card: {
            title: name,
            rows: [{ label: "Value", valueKey: "value" }],
            confirmLabel: "Confirm",
            cancelLabel: "Cancel",
        },
        rules: [
            {
                kind: "keyword_map",
                field: "value",
                mode: "override",
                map: [
                    {
                        value: "matched",
                        keywords: Array.from(
                            { length: keywordCount },
                            (_, index) => `keyword-${index}`,
                        ),
                    },
                ],
            },
        ],
    };
}

function keywordTotal(actions: readonly AiActionDefinition[]): number {
    return buildBoundedAutoProposeVocabulary(actions).keywordEntries.reduce(
        (total, entry) => total + entry.keywords.length,
        0,
    );
}

describe("bounded auto-propose vocabulary", () => {
    it("accepts one below and exactly at the aggregate keyword limit", () => {
        expect(keywordTotal([action("below", MAX_AUTO_PROPOSE_KEYWORDS - 1)])).toBe(
            MAX_AUTO_PROPOSE_KEYWORDS - 1,
        );
        expect(keywordTotal([action("at", MAX_AUTO_PROPOSE_KEYWORDS)])).toBe(
            MAX_AUTO_PROPOSE_KEYWORDS,
        );
    });

    it("fails the over-budget action closed instead of retaining a partial vocabulary", () => {
        expect(keywordTotal([action("above", MAX_AUTO_PROPOSE_KEYWORDS + 1)])).toBe(0);
    });

    it("caps aggregate actions at 32 for legacy or malformed registries", () => {
        const actions = Array.from({ length: 33 }, (_, index) => action(`action-${index}`, 1));
        expect(buildBoundedAutoProposeVocabulary(actions.slice(0, 31)).keywordEntries).toHaveLength(
            31,
        );
        expect(buildBoundedAutoProposeVocabulary(actions.slice(0, 32)).keywordEntries).toHaveLength(
            32,
        );
        expect(buildBoundedAutoProposeVocabulary(actions).keywordEntries).toHaveLength(32);
    });
});
