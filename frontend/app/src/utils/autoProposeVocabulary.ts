import type { AiActionDefinition } from "openchat-shared";

interface VocabularyEntry {
    title: string;
    keywords: string[];
}

export interface AutoProposeVocabulary {
    keywordEntries: VocabularyEntry[];
    imageTitle?: string;
}

const MAX_AUTO_PROPOSE_ACTIONS = 32;
export const MAX_AUTO_PROPOSE_KEYWORDS = 500;

export function buildBoundedAutoProposeVocabulary(
    untrustedActions: readonly AiActionDefinition[],
): AutoProposeVocabulary {
    const actions = untrustedActions.slice(0, MAX_AUTO_PROPOSE_ACTIONS);
    const keywordEntries: VocabularyEntry[] = [];
    let remainingKeywords = MAX_AUTO_PROPOSE_KEYWORDS;
    actionLoop: for (const action of actions) {
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
            keywordEntries.push({ title: action.card.title, keywords: [...keywords] });
        }
    }
    const imageAction = actions.find((action) => action.acceptsImage);
    return { keywordEntries, imageTitle: imageAction?.card.title };
}
