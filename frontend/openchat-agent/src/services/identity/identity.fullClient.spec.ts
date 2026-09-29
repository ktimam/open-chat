// @vitest-environment node
import { AnonymousIdentity } from "@icp-sdk/core/agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TypeboxValidationError } from "@shared";
import { IdentityClient } from "@agent/services/identity/identity.client";
import {
    syntheticIdentityTransport,
    TEST_CANISTER,
    TEST_CREDENTIAL_ID,
    TEST_EXPIRATION,
    TEST_PUBLIC_KEY,
} from "./identity.fullClient.fixture";

describe("full-client identity wire contracts (synthetic, no real sign-in)", () => {
    const network = vi.fn(() => {
        throw new Error("Network forbidden in identity contract tests");
    });
    beforeEach(() => {
        network.mockClear();
        vi.stubGlobal("fetch", network);
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "debug").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
        expect(network).not.toHaveBeenCalled();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });
    function setup(mode: "certified" | "accepted" = "certified") {
        const transport = syntheticIdentityTransport(mode);
        return {
            ...transport,
            client: new IdentityClient(new AnonymousIdentity(), transport.agent, TEST_CANISTER),
        };
    }

    it("validates and maps the credential lookup that the saved-public-key probe bypasses", async () => {
        const { client, calls } = setup();
        await expect(client.lookupWebAuthnPubKey(TEST_CREDENTIAL_ID)).resolves.toEqual(
            TEST_PUBLIC_KEY,
        );
        expect(calls).toEqual([
            {
                method: "lookup_webauthn_pubkey_msgpack",
                args: { credential_id: TEST_CREDENTIAL_ID },
            },
        ]);
    });

    it("does not mistake a missing or malformed public key for a usable identity", async () => {
        const { client, replies, call } = setup();
        replies.set("lookup_webauthn_pubkey_msgpack", "NotFound");
        await expect(client.lookupWebAuthnPubKey(TEST_CREDENTIAL_ID)).resolves.toBeUndefined();
        replies.set("lookup_webauthn_pubkey_msgpack", { Success: { pubkey: "not-bytes" } });
        await expect(client.lookupWebAuthnPubKey(TEST_CREDENTIAL_ID)).rejects.toBeInstanceOf(
            TypeboxValidationError,
        );
        expect(call).not.toHaveBeenCalled();
    });

    it("requires the complete account mapping rather than only the probe's user_id", async () => {
        const { client, replies } = setup();
        await expect(client.checkAuthPrincipal()).resolves.toMatchObject({
            kind: "success",
            isIIPrincipal: false,
        });
        replies.set("check_auth_principal_v2_msgpack", { Success: { user_id: Uint8Array.of(4) } });
        await expect(client.checkAuthPrincipal()).rejects.toBeInstanceOf(TypeboxValidationError);
    });

    it.each(["certified", "accepted"] as const)(
        "uses synchronous prepare with the %s response path",
        async (mode) => {
            const { client, calls, certificate, readState, rootKey, certificateBytes } =
                setup(mode);
            await expect(client.prepareDelegation(TEST_PUBLIC_KEY, false)).resolves.toEqual({
                kind: "success",
                userKey: TEST_PUBLIC_KEY,
                expiration: TEST_EXPIRATION,
                proofJwt: "synthetic-not-a-jwt",
            });
            expect(calls).toEqual([
                {
                    method: "prepare_delegation_msgpack",
                    callSync: true,
                    args: { session_key: TEST_PUBLIC_KEY, is_ii_principal: false },
                },
            ]);
            expect(certificate).toHaveBeenCalledWith(
                expect.objectContaining({
                    certificate: certificateBytes,
                    rootKey,
                    principal: { canisterId: expect.objectContaining({}) },
                }),
            );
            if (mode === "certified") expect(readState).not.toHaveBeenCalled();
            else expect(readState).toHaveBeenCalledOnce();
            await expect(
                client.getDelegation(TEST_PUBLIC_KEY, TEST_EXPIRATION),
            ).resolves.toMatchObject({
                kind: "success",
                delegation: { expiration: TEST_EXPIRATION, pubkey: TEST_PUBLIC_KEY },
            });
        },
    );

    it("rejects a prepare reply sufficient for the probe but missing the client-required proof", async () => {
        const { client, replies } = setup();
        replies.set("prepare_delegation_msgpack", {
            Success: { user_key: TEST_PUBLIC_KEY, expiration: TEST_EXPIRATION },
        });
        await expect(client.prepareDelegation(TEST_PUBLIC_KEY, false)).rejects.toBeInstanceOf(
            TypeboxValidationError,
        );
        // This documents a contract difference, not evidence that production omits proof_jwt.
    });
});
