import { describe, expect, it } from "vitest";
import { snapshotLocalDraftPayload, snapshotLocalDraftSchema } from "./localAppDrafts";

describe("app-declared bounded string patterns", () => {
    const schema = { type: "string", pattern: "^[A-Z]{3}$" } as const;
    it.each(["ABC", "XYZ", "ZZZ"])("preserves exact valid value %s", (value) => {
        expect(snapshotLocalDraftPayload(value, schema)).toBe(value);
    });
    it.each(["abc", "123", "AbC", "AB", "ABCD", " ABC", "ABC\n", "ＡＢＣ", "A\u200bB", "😀"])(
        "rejects rather than repairs %j",
        (value) => {
            expect(() => snapshotLocalDraftPayload(value, schema)).toThrow("Invalid private draft");
        },
    );
    it("supports generic combined ranges and bounded lengths", () => {
        const ranged = { type: "string", pattern: "^[a-zA-Z0-9]{2,6}$" } as const;
        expect(snapshotLocalDraftPayload("aB19", ranged)).toBe("aB19");
        for (const value of ["a", "1234567", "a-b", "é1"]) {
            expect(() => snapshotLocalDraftPayload(value, ranged)).toThrow();
        }
    });
    it("retains independent enum and length constraints", () => {
        expect(() => snapshotLocalDraftPayload("ABC", { ...schema, enum: ["XYZ"] })).toThrow();
        expect(() => snapshotLocalDraftPayload("ABC", { ...schema, minLength: 4 })).toThrow();
        expect(() => snapshotLocalDraftPayload("ABC", { ...schema, maxLength: 2 })).toThrow();
    });
    it.each([
        "(a+)+$",
        "^[A-Z]+$",
        "^[A-Z]{3}$|.*",
        "^[A-Z]{3}",
        "[A-Z]{3}$",
        "^[A-Z]{3,2}$",
        "^[A-Z]{65537}$",
        "^[A-Z]{01}$",
        "^[A-ZA-Z]{3}$",
        "^[a-z]{1,}$",
        "^.*$",
        "^[\\w]{3}$",
        "^[A-Z]{3}$\n",
        "x".repeat(65),
        12,
        null,
        {},
    ])("rejects unsupported or unbounded declaration %j", (pattern) => {
        expect(() => snapshotLocalDraftSchema({ type: "string", pattern })).toThrow();
    });
    it("does not allow patterns on non-string fields", () => {
        expect(() =>
            snapshotLocalDraftSchema({ type: "number", pattern: schema.pattern }),
        ).toThrow();
    });
    it("keeps old pattern-free schemas valid", () => {
        expect(snapshotLocalDraftPayload("any Unicode text é", { type: "string" })).toBe(
            "any Unicode text é",
        );
    });
});
