import { describe, expect, it } from "vitest";
import {
    buildAndroidPasskeySignInPayload,
    matchingCachedAndroidCredentialIds,
} from "./androidWebAuthn";

describe("Android WebAuthn cached credential rescue", () => {
    it("only reuses non-empty credential IDs cached for the active RP ID", () => {
        const matching = new Uint8Array([1, 2, 3]);
        expect(
            matchingCachedAndroidCredentialIds(
                [
                    { origin: "expected.example", credentialId: matching },
                    { origin: "other.example", credentialId: new Uint8Array([4]) },
                    { origin: "expected.example", credentialId: new Uint8Array() },
                    { origin: "expected.example", credentialId: new Uint8Array(1024) },
                    { origin: "expected.example", credentialId: [5, 6] },
                    null,
                ],
                "expected.example",
            ),
        ).toEqual([matching]);
    });

    it("encodes and deduplicates cached IDs for allowCredentials", () => {
        const challenge = new Uint8Array([9, 8, 7]).buffer;
        const credentialId = new Uint8Array([255, 0, 1]);
        expect(
            buildAndroidPasskeySignInPayload(challenge, [
                credentialId,
                new Uint8Array(credentialId),
            ]),
        ).toEqual({
            challenge,
            credentialIds: ["_wAB"],
        });
    });

    it("drops empty and oversized IDs before invoking Android", () => {
        expect(
            buildAndroidPasskeySignInPayload(new ArrayBuffer(0), [
                new Uint8Array(),
                new Uint8Array(1024),
            ]).credentialIds,
        ).toEqual([]);
    });
});
