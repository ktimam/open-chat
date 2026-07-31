// Whole-word keyword matching for the TEXT auto-propose path.
//
// Kept in its own leaf module (no store/client imports) so it stays unit-testable: importing
// autoPropose.ts pulls in the settings stores and the whole openchat-client graph.
//
// Why not `text.includes(keyword)`: raw substring matching fires INSIDE other words, which forced
// apps to avoid short keywords entirely — IOU could not list "owe" because it would match "power",
// "shower" and "flower", so it listed only pronoun phrasings ("i owe", "you owe", …) and a perfectly
// ordinary "Owe 300 uber" suggested nothing at all.
//
// \b is not usable here because keywords may legitimately begin or end with punctuation or spaces
// (multi-word phrases), so assert a non-alphanumeric character — or the string edge — on each side.
// The \p{L}/\p{N} classes keep this correct for non-ASCII text.
export function matchesKeyword(text: string, keyword: string): boolean {
    if (keyword.length === 0) return false;
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:[^\\p{L}\\p{N}]|$)`, "iu").test(text);
}
