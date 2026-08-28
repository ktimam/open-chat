import { describe, expect, it } from "vitest";
import { createAiAppCardConfirmationGrantResponse } from "./aiAppCardConfirmationGrant";

describe("createAiAppCardConfirmationGrantResponse", () => {
    it("maps only an exact 32-byte opaque grant", () => {
        const grant = new Uint8Array(32).fill(7);
        expect(
            createAiAppCardConfirmationGrantResponse({
                Success: { grant, expires_at: 123n },
            }),
        ).toEqual({ grant, expiresAt: 123n });
        expect(
            createAiAppCardConfirmationGrantResponse({
                Success: { grant: new Uint8Array(31), expires_at: 123n },
            }),
        ).toBeUndefined();
        expect(
            createAiAppCardConfirmationGrantResponse({
                Success: { grant: new Uint8Array(33), expires_at: 123n },
            }),
        ).toBeUndefined();
    });

    it("fails closed for every non-success result", () => {
        expect(createAiAppCardConfirmationGrantResponse("InvalidProvenance")).toBeUndefined();
        expect(createAiAppCardConfirmationGrantResponse("AppUnavailable")).toBeUndefined();
        expect(
            createAiAppCardConfirmationGrantResponse({ InvalidRequest: "wrong card" }),
        ).toBeUndefined();
        expect(createAiAppCardConfirmationGrantResponse({ Error: "unavailable" })).toBeUndefined();
    });
});
