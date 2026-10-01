import { anonymousUser, updateCreatedUser } from "@shared";
import { describe, expect, it, test } from "vitest";
import type {
    CurrentUserSummary as TCurrentUserSummary,
    UserIndexCurrentUserResponse,
} from "../../typebox";
import { principalStringToBytes } from "../../utils/mapping";
import {
    aiAppsByIdsResponse,
    apiAiAppCardContentV1,
    createAiAppCardProvenanceResponse,
    currentUserResponse,
    currentUserSummary,
    myAiAppsResponse,
    myAiAppKeysResponse,
    dropInvalidUserIds,
    userMigrationResponse,
    userSummaryUpdate,
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

describe("dropInvalidUserIds", () => {
    // Invariant: a user id that is not a principal never reaches Principal.fromText. Referral
    // links carrying a username ("?ref=thebitcoinstorm") put one into getUsers and the throw
    // took the whole batch with it (Rollbar #31609, #31687).
    test("drops ids that are not principals and keeps the rest", () => {
        const args = {
            userGroups: [
                {
                    users: ["thebitcoinstorm", "9", "dfdal-2uaaa-aaaaa-qaama-cai"],
                    updatedSince: 0n,
                },
                { users: ["xxxxxxxxxx"], updatedSince: 5n },
            ],
        };
        expect(dropInvalidUserIds(args)).toEqual({
            userGroups: [
                { users: ["dfdal-2uaaa-aaaaa-qaama-cai"], updatedSince: 0n },
                { users: [], updatedSince: 5n },
            ],
        });
    });
});

describe("userSummaryUpdate", () => {
    const latest = "dfdal-2uaaa-aaaaa-qaama-cai";
    const previous = ["ryjl3-tyaaa-aaaaa-aaaba-cai", "rrkah-fqaaa-aaaaa-aaaaq-cai"];

    test("maps the ids a migrated user had before their latest one", () => {
        const update = userSummaryUpdate({
            user_id: principalStringToBytes(latest),
            previous_user_ids: previous.map(principalStringToBytes),
        });
        expect(update.userId).toEqual(latest);
        expect(update.previousUserIds).toEqual(previous);
    });

    test("leaves previousUserIds undefined when the field is omitted", () => {
        const update = userSummaryUpdate({ user_id: principalStringToBytes(latest) });
        expect(update.previousUserIds).toBeUndefined();
    });
});

// The ids a user had before being migrated to a MultiUser canister, which events from before then
// still refer to them by
test("the current user comes with their previous ids", () => {
    const latest = "dfdal-2uaaa-aaaaa-qaama-cai";
    const previous = "rrkah-fqaaa-aaaaa-aaaaq-cai";
    const response = currentUserResponse({
        Success: {
            user_id: principalStringToBytes(latest),
            username: "me",
            previous_user_ids: [principalStringToBytes(previous)],
            icp_account: new Uint8Array(32),
        },
    } as unknown as UserIndexCurrentUserResponse);

    expect(response).toMatchObject({ kind: "created_user", previousUserIds: [previous] });
});

// A summary of the current user under a new id, the user having been migrated during the session,
// replaces the cached one, and has to carry the earlier ids for the next session to map them
test("a current user summary comes with the previous ids, which replace the cached user's", () => {
    const latest = "dfdal-2uaaa-aaaaa-qaama-cai";
    const previous = "rrkah-fqaaa-aaaaa-aaaaq-cai";
    const summary = currentUserSummary(
        {
            user_id: principalStringToBytes(latest),
            username: "me",
            previous_user_ids: [principalStringToBytes(previous)],
        } as unknown as TCurrentUserSummary,
        1n,
    );
    expect(summary.previousUserIds).toEqual([previous]);

    const cached = { ...anonymousUser(), userId: previous };
    expect(updateCreatedUser(cached, summary)).toMatchObject({
        userId: latest,
        previousUserIds: [previous],
    });
});

describe("userMigrationResponse", () => {
    const userId = "dfdal-2uaaa-aaaaa-qaama-cai";
    const multiUserCanisterId = "ryjl3-tyaaa-aaaaa-aaaba-cai";
    const multi_user_canister_id = principalStringToBytes(multiUserCanisterId);

    test("maps each stage of a migration", () => {
        expect(userMigrationResponse("NotFound")).toEqual({ kind: "not_found" });
        expect(userMigrationResponse({ Success: "Queued" })).toEqual({ kind: "queued" });
        expect(
            userMigrationResponse({
                Success: { Requested: { multi_user_canister_id, timestamp: 1n } },
            }),
        ).toEqual({ kind: "requested", multiUserCanisterId, timestamp: 1n });
        expect(
            userMigrationResponse({
                Success: {
                    Started: {
                        multi_user_canister_id,
                        timestamp: 2n,
                        user_bytes: 1000n,
                        wasm_version: { major: 2, minor: 0, patch: 2077 },
                    },
                },
            }),
        ).toEqual({
            kind: "started",
            multiUserCanisterId,
            timestamp: 2n,
            userBytes: 1000n,
            wasmVersion: "2.0.2077",
        });
        expect(
            userMigrationResponse({
                Success: {
                    Imported: {
                        multi_user_canister_id,
                        timestamp: 3n,
                        new_user_id: principalStringToBytes(userId),
                    },
                },
            }),
        ).toEqual({ kind: "imported", multiUserCanisterId, timestamp: 3n, newUserId: userId });
        expect(
            userMigrationResponse({
                Success: {
                    Failed: { multi_user_canister_id, timestamp: 4n, error: [100, "Frozen"] },
                },
            }),
        ).toEqual({
            kind: "failed",
            multiUserCanisterId,
            timestamp: 4n,
            error: { kind: "error", code: 100, message: "Frozen" },
        });
    });
});
