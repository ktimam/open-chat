import { describe, expect, test } from "vitest";
import { matchesKeyword } from "./keywordMatch";

// The TEXT auto-propose path matches an action's keyword_map keywords against the message. It used to
// use raw `text.includes(keyword)`, which fires INSIDE other words — so apps had to avoid short
// keywords ("owe" would match "power"/"shower"/"flower") and an ordinary "Owe 300 uber" matched
// nothing at all. These pin the word-boundary behaviour that makes short keywords safe.
describe("matchesKeyword", () => {
    test("matches a bare keyword as a whole word, case-insensitively", () => {
        expect(matchesKeyword("owe 300 uber", "owe")).toBe(true);
        expect(matchesKeyword("Owe 300 uber".toLowerCase(), "owe")).toBe(true);
        expect(matchesKeyword("i think you owe me", "owe")).toBe(true);
    });

    test("does NOT match inside another word (the reason 'owe' was banned before)", () => {
        for (const noise of ["power bill", "had a shower", "a flower shop", "lowest price"]) {
            expect(matchesKeyword(noise, "owe")).toBe(false);
        }
    });

    test("matches at the very start and end of the message", () => {
        expect(matchesKeyword("owe", "owe")).toBe(true);
        expect(matchesKeyword("what you owe", "owe")).toBe(true);
        expect(matchesKeyword("owe you", "owe")).toBe(true);
    });

    test("handles punctuation adjacency", () => {
        expect(matchesKeyword("you owe, right?", "owe")).toBe(true);
        expect(matchesKeyword("(owe)", "owe")).toBe(true);
        expect(matchesKeyword("owe.", "owe")).toBe(true);
    });

    test("multi-word phrases still match", () => {
        expect(matchesKeyword("i owe you 40", "i owe")).toBe(true);
        expect(matchesKeyword("that is a reservation fee", "reservation")).toBe(true);
    });

    test("other short keywords keep working and stay bounded", () => {
        expect(matchesKeyword("rent is due", "rent")).toBe(true);
        expect(matchesKeyword("current account", "rent")).toBe(false); // 'cur-RENT-'
        expect(matchesKeyword("paid it", "paid")).toBe(true);
        expect(matchesKeyword("unpaid invoice", "paid")).toBe(false);
    });

    test("an empty keyword never matches", () => {
        expect(matchesKeyword("anything", "")).toBe(false);
    });
});
