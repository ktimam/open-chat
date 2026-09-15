import { describe, expect, it } from "vitest";
import {
    aiAppsByIdsResponse,
    apiAiAppCardContentV1,
    createAiAppCardProvenanceResponse,
    myAiAppsResponse,
    myAiAppKeysResponse,
} from "./mappers";

describe("apiAiAppCardContentV1", () => {
    it("copies exactly the canonical card fields and no private/routing authority", () => {
        const confirmPayload = new TextEncoder().encode('{"opaque_ref":"value"}');
        const wire = apiAiAppCardContentV1({
            title: "Record item",
            rows: [{ label: "Amount", value: "20" }],
            confirmLabel: "Confirm",
            cancelLabel: "Cancel",
            actionId: "sample.record",
            disclosure: "Review",
            expiresAt: 456n,
            confirmPayload,
        });

        expect(wire).toEqual({
            title: "Record item",
            rows: [{ label: "Amount", value: "20" }],
            confirm_label: "Confirm",
            cancel_label: "Cancel",
            action_id: "sample.record",
            disclosure: "Review",
            expires_at: 456n,
            confirm_payload: confirmPayload,
        });
        expect(Object.keys(wire).sort()).toEqual([
            "action_id",
            "cancel_label",
            "confirm_label",
            "confirm_payload",
            "disclosure",
            "expires_at",
            "rows",
            "title",
        ]);
        expect(wire.confirm_payload).not.toBe(confirmPayload);
    });
});

describe("createAiAppCardProvenanceResponse", () => {
    it("accepts the backend's exact 32-byte opaque provenance proof", () => {
        const provenance = Uint8Array.from({ length: 32 }, (_, i) => i);
        expect(
            createAiAppCardProvenanceResponse({
                Success: { provenance, expires_at: 123n },
            }),
        ).toEqual({ kind: "success", provenance, expiresAt: 123n });
    });

    it.each([31, 33])("fails closed for a %i-byte provenance proof", (size) => {
        expect(
            createAiAppCardProvenanceResponse({
                Success: { provenance: new Uint8Array(size), expires_at: 123n },
            }),
        ).toEqual({ kind: "malformed_success" });
    });

    it.each([
        ["app unavailable", "AppUnavailable", { kind: "app_unavailable" }],
        [
            "invalid request",
            { InvalidRequest: "private backend detail" },
            { kind: "invalid_request" },
        ],
        ["backend error", { Error: [1, "private backend detail"] }, { kind: "backend_error" }],
    ] as const)("maps %s to a detail-free category", (_label, response, expected) => {
        expect(
            createAiAppCardProvenanceResponse(
                response as Parameters<typeof createAiAppCardProvenanceResponse>[0],
            ),
        ).toEqual(expected);
    });
});

describe("bounded AI-app response failures", () => {
    it("rejects every exact-lookup limit response", () => {
        expect(() => aiAppsByIdsResponse({ TooManyApps: 8 })).toThrow(/at most 8/);
        expect(() => aiAppsByIdsResponse({ ResponseTooLarge: 1_200_000 })).toThrow(
            /1200000 encoded bytes/,
        );
    });

    it("rejects every caller-owned page failure", () => {
        expect(() => myAiAppsResponse("UserNotFound")).toThrow(/registered user/);
        expect(() => myAiAppsResponse({ InvalidPageSize: 8 })).toThrow(/at most 8/);
        expect(() => myAiAppsResponse({ ResponseTooLarge: 1_200_000 })).toThrow(
            /1200000 encoded bytes/,
        );
    });
});

describe("myAiAppKeysResponse", () => {
    it("keeps a legacy key visible but marks its reconnect epoch unknown", () => {
        expect(
            myAiAppKeysResponse({
                Success: { keys: [{ app_id: 7, public_key: "legacy-pem" }] },
            }),
        ).toEqual([{ appId: 7, publicKey: "legacy-pem", keyVersion: 0n }]);
    });

    it("maps the authoritative binding epoch from an upgraded UserIndex", () => {
        expect(
            myAiAppKeysResponse({
                Success: {
                    keys: [{ app_id: 7, public_key: "durable-pem", key_version: 5n }],
                },
            }),
        ).toEqual([{ appId: 7, publicKey: "durable-pem", keyVersion: 5n }]);
    });
});
