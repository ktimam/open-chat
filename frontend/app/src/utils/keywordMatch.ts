// Whole-word keyword matching for the TEXT auto-propose path.
//
// Kept in its own leaf module (no store/client imports) so it stays unit-testable: importing
// autoPropose.ts pulls in the settings stores and the whole openchat-client graph.
//
// Why not `text.includes(keyword)`: raw substring matching fires INSIDE other words, which forces
// apps to avoid otherwise useful short keywords. For example, "art" must not match "cartography".
//
// \b is not usable here because keywords may legitimately begin or end with punctuation or spaces
// (multi-word phrases), so assert a non-alphanumeric character — or the string edge — on each side.
// The \p{L}/\p{N} classes keep this correct for non-ASCII text.
export function matchesKeyword(text: string, keyword: string): boolean {
    if (keyword.length === 0 || keyword.length > 64) return false;
    const haystack = text.slice(0, 10_000).toLowerCase();
    const needle = keyword.toLowerCase();
    const wordChar = /[\p{L}\p{N}]/u;
    let from = 0;
    while (from <= haystack.length - needle.length) {
        const index = haystack.indexOf(needle, from);
        if (index < 0) return false;
        let before = "";
        if (index > 0) {
            let beforeStart = index - 1;
            const last = haystack.charCodeAt(beforeStart);
            if (
                last >= 0xdc00 &&
                last <= 0xdfff &&
                beforeStart > 0 &&
                haystack.charCodeAt(beforeStart - 1) >= 0xd800 &&
                haystack.charCodeAt(beforeStart - 1) <= 0xdbff
            ) {
                beforeStart--;
            }
            before = haystack.slice(beforeStart, index);
        }
        const afterIndex = index + needle.length;
        const after =
            afterIndex >= haystack.length
                ? ""
                : String.fromCodePoint(haystack.codePointAt(afterIndex) ?? 0);
        if (!wordChar.test(before) && !wordChar.test(after)) return true;
        from = index + needle.length;
    }
    return false;
}
