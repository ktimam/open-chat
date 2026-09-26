import { describe, expect, it } from "vitest";
import { formatLocalHandoffReview } from "./localAppHandoffRelay";

describe("exact relay review rendering", () => {
    it("exposes hidden controls without losing astral surrogate code units or changing payload", () => {
        const request = {
            appId: "example", actionId: "record", destination: "https://app.example/import",
            recipient: "Review only", idempotencyKey: "A".repeat(43),
            payload: { text: "plain\u202E\u{E0001}\u0085\u2028🙂" },
        };
        const formatted = formatLocalHandoffReview(request);
        expect(formatted).toContain("\\u202e\\udb40\\udc01\\u0085\\u2028🙂");
        expect(JSON.parse(formatted)).toEqual(request);
        expect(formatted).not.toContain("\u{E0001}");
    });
});
