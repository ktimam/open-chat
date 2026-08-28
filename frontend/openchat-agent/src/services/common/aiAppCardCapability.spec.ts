import { describe, expect, it } from "vitest";
import { createAiAppCardCapabilityResponse } from "./aiAppCardCapability";

describe("createAiAppCardCapabilityResponse", () => {
    const context = {
        context_version: 1,
        app_subject: new Uint8Array(32).fill(1),
        chat_handle: new Uint8Array(32).fill(2),
        message_handle: new Uint8Array(32).fill(3),
        app_id: 7,
        app_revision: 9n,
        action_id: "sample.add",
    };

    it("maps an opaque token to unpadded base64url without logging or persistence", () => {
        expect(
            createAiAppCardCapabilityResponse({
                Success: {
                    token: Uint8Array.from({ length: 32 }, (_, i) => i),
                    expires_at: 123n,
                    context,
                },
            }),
        ).toEqual({
            capability: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
            expiresAt: 123n,
            context: {
                contextVersion: 1,
                appSubject: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
                chatHandle: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
                messageHandle: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM",
                appId: 7,
                appRevision: 9n,
                actionId: "sample.add",
            },
        });
    });

    it("fails closed for canister rejection, empty tokens, and oversized tokens", () => {
        expect(createAiAppCardCapabilityResponse("InvalidProvenance")).toBeUndefined();
        for (const size of [31, 33]) {
            expect(
                createAiAppCardCapabilityResponse({
                    Success: { token: new Uint8Array(size), expires_at: 123n, context },
                }),
            ).toBeUndefined();
        }
        expect(
            createAiAppCardCapabilityResponse({
                Success: { token: new Uint8Array(32), expires_at: 123n, context },
            }),
        ).toBeDefined();
    });

    it("fails closed for missing, malformed, or non-v1 scoped handles", () => {
        const success = (overrides: Partial<Record<keyof typeof context, unknown>>) => ({
            Success: {
                token: new Uint8Array(32),
                expires_at: 123n,
                context: { ...context, ...overrides },
            },
        });
        expect(createAiAppCardCapabilityResponse(success({ context_version: 2 }))).toBeUndefined();
        expect(createAiAppCardCapabilityResponse(success({ app_subject: new Uint8Array(31) }))).toBeUndefined();
        expect(createAiAppCardCapabilityResponse(success({ chat_handle: new Uint8Array(33) }))).toBeUndefined();
        expect(createAiAppCardCapabilityResponse(success({ message_handle: [] }))).toBeUndefined();
    });

    it("does not throw or coerce malformed canister byte fields", () => {
        const malformed: unknown[] = [
            null,
            { Success: null },
            { Success: {} },
            { Success: { token: undefined, expires_at: 123n, context } },
            { Success: { token: {}, expires_at: 123n, context } },
            { Success: { token: new Array(32).fill(256), expires_at: 123n, context } },
            {
                Success: {
                    token: new Uint8Array(32),
                    expires_at: 123n,
                    context: { ...context, app_subject: undefined },
                },
            },
            {
                Success: {
                    token: new Uint8Array(32),
                    expires_at: 123n,
                    context: { ...context, chat_handle: new Array(32).fill(-1) },
                },
            },
            {
                Success: {
                    token: new Uint8Array(32),
                    expires_at: 123n,
                    context: { ...context, message_handle: [Symbol("not-a-byte")] },
                },
            },
            { Success: { token: new Uint8Array(32), expires_at: -1n, context } },
        ];

        for (const response of malformed) {
            expect(() => createAiAppCardCapabilityResponse(response)).not.toThrow();
            expect(createAiAppCardCapabilityResponse(response)).toBeUndefined();
        }
    });
});
