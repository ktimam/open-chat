import type { AiActionDefinition } from "@shared";

export interface VocabularyEntry {
    title: string;
    keywords: string[];
    actionIndex: number;
}

export interface ImageVocabularyEntry {
    title: string;
    actionIndex: number;
}

export interface AutoProposeVocabulary {
    keywordEntries: VocabularyEntry[];
    imageEntries: ImageVocabularyEntry[];
}

export const MAX_AUTO_PROPOSE_ACTIONS = 32;
export const MAX_AUTO_PROPOSE_KEYWORDS = 500;

export function buildBoundedAutoProposeVocabulary(
    untrustedActions: readonly AiActionDefinition[],
): AutoProposeVocabulary {
    const actions = untrustedActions.slice(0, MAX_AUTO_PROPOSE_ACTIONS);
    const keywordEntries: VocabularyEntry[] = [];
    let remainingKeywords = MAX_AUTO_PROPOSE_KEYWORDS;
    actionLoop: for (const [actionIndex, action] of actions.entries()) {
        const keywords = new Set<string>();
        for (const rule of action.rules ?? []) {
            if (rule.kind !== "keyword_map") continue;
            for (const mapping of rule.map) {
                for (const keyword of mapping.keywords) {
                    const normalized = keyword.trim().toLowerCase();
                    if (normalized.length === 0 || keywords.has(normalized)) continue;
                    if (remainingKeywords === 0) break actionLoop;
                    keywords.add(normalized);
                    remainingKeywords--;
                }
            }
        }
        if (keywords.size > 0) {
            keywordEntries.push({
                title: action.card.title,
                keywords: [...keywords],
                actionIndex,
            });
        }
    }
    return {
        keywordEntries,
        imageEntries: actions.flatMap((action, actionIndex) =>
            action.acceptsImage ? [{ title: action.card.title, actionIndex }] : [],
        ),
    };
}
