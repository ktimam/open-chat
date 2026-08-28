import { describe, expect, it } from "vitest";
import { createAiAppChatLinkTokenResponse } from "./aiAppChatLinkToken";

describe("createAiAppChatLinkTokenResponse", () => {
    it("accepts only an exact 32-byte opaque token", () => {
        const token = Uint8Array.from({ length: 32 }, (_, index) => index);
        const mapped = createAiAppChatLinkTokenResponse({
            Success: { token, expires_at: 123n },
        });
        expect(mapped).toEqual({ token, expiresAt: 123n });
        expect(mapped?.token).not.toBe(token);
    });

    it("accepts the generated decoder's number-array byte representation", () => {
        expect(
            createAiAppChatLinkTokenResponse({
                Success: { token: new Array(32).fill(7), expires_at: 123n },
            }),
        ).toEqual({ token: new Uint8Array(32).fill(7), expiresAt: 123n });
    });

    it("fails closed for rejection and malformed token responses", () => {
        const malformed: unknown[] = [
            "AppUnavailable",
            "ChatNotFound",
            "NotAuthorized",
            { InvalidRequest: "bad" },
            { Error: {} },
            null,
            { Success: null },
            { Success: { token: new Uint8Array(31), expires_at: 123n } },
            { Success: { token: new Uint8Array(33), expires_at: 123n } },
            { Success: { token: new Array(32).fill(256), expires_at: 123n } },
            { Success: { token: new Uint8Array(32), expires_at: -1n } },
            { Success: { token: new Uint8Array(32), expires_at: 123 } },
        ];
        for (const response of malformed) {
            expect(() => createAiAppChatLinkTokenResponse(response)).not.toThrow();
            expect(createAiAppChatLinkTokenResponse(response)).toBeUndefined();
        }
    });
});
