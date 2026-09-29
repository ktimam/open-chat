// @vitest-environment node
import { webcrypto } from "node:crypto";
import { Principal } from "@icp-sdk/core/principal";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NativeBrowserSessionError, validateNativeBrowserSession } from "./nativeBrowserSession";
import {
    nativeSessionFixture,
    nativeTestPolicy,
    syntheticKeyChain,
} from "./nativeBrowserSession.fixture";

describe("ephemeral native browser session structural validation", () => {
    const nowMs = 1_800_000_000_000;
    const network = vi.fn(() => {
        throw new Error("Network forbidden in native session tests");
    });
    let fixture: Awaited<ReturnType<typeof nativeSessionFixture>>;
    beforeAll(async () => {
        vi.stubGlobal("crypto", webcrypto);
        vi.stubGlobal("fetch", network);
        fixture = await nativeSessionFixture(nowMs);
    });
    afterEach(() => expect(network).not.toHaveBeenCalled());
    afterAll(() => vi.unstubAllGlobals());
    const request = () => structuredClone(fixture.request);
    const validate = (r = request(), policy = nativeTestPolicy) =>
        validateNativeBrowserSession(
            r.identity,
            r.nativeBrowserSession,
            r.isIIPrincipal,
            policy,
            nowMs,
        );

    it("restores the exact supplied identities without storage, network, or signature-verification claims", async () => {
        const r = request();
        const result = await validate(r);
        expect(result.authIdentity.getPrincipal().toString()).toBe(
            fixture.authKey.getPrincipal().toString(),
        );
        expect(result.ocIdentity.getPrincipal().toString()).toBe(
            fixture.ocKey.getPrincipal().toString(),
        );
        expect(result.sessionExpiryMs).toBe(r.nativeBrowserSession.expiresAtMs);
    });
    it.each([
        { existingAccountOnly: false, clientOnlyApps: true },
        { existingAccountOnly: true, clientOnlyApps: false },
        { existingAccountOnly: undefined, clientOnlyApps: undefined },
    ])("requires both explicit unofficial policies: %j", async (flags) => {
        const r = request();
        await expect(
            validateNativeBrowserSession(
                r.identity,
                r.nativeBrowserSession,
                false,
                { ...nativeTestPolicy, ...flags },
                nowMs,
            ),
        ).rejects.toBeInstanceOf(NativeBrowserSessionError);
    });
    it("rejects missing AUTH/session or II identities", async () => {
        const r = request();
        for (const args of [
            [undefined, r.nativeBrowserSession, false],
            [r.identity, undefined, false],
            [r.identity, r.nativeBrowserSession, true],
        ] as const) {
            await expect(
                validateNativeBrowserSession(...args, nativeTestPolicy, nowMs),
            ).rejects.toBeInstanceOf(NativeBrowserSessionError);
        }
    });
    it.each([
        undefined,
        [],
        [Principal.anonymous()],
        [Principal.fromText("aaaaa-aa"), Principal.anonymous()],
    ])("rejects missing, different, or multiple AUTH targets (%j)", async (targets) => {
        const r = request();
        r.identity = syntheticKeyChain(fixture.authKey, fixture.expiry, targets);
        await expect(validate(r)).rejects.toBeInstanceOf(NativeBrowserSessionError);
    });
    it("rejects scoped OC sessions while accepting an explicitly empty target list", async () => {
        const r = request();
        r.nativeBrowserSession.ocIdentity = syntheticKeyChain(fixture.ocKey, fixture.expiry, [
            Principal.anonymous(),
        ]);
        await expect(validate(r)).rejects.toBeInstanceOf(NativeBrowserSessionError);
        r.nativeBrowserSession.ocIdentity = syntheticKeyChain(fixture.ocKey, fixture.expiry, []);
        await expect(validate(r)).resolves.toBeDefined();
    });
    it.each(["auth", "oc"] as const)(
        "rejects a %s leaf key that differs from the supplied key",
        async (side) => {
            const r = request();
            if (side === "auth") r.identity.key = fixture.ocKey.getKeyPair();
            else r.nativeBrowserSession.ocIdentity.key = fixture.authKey.getKeyPair();
            await expect(validate(r)).rejects.toBeInstanceOf(NativeBrowserSessionError);
        },
    );
    it.each(["auth", "oc"] as const)(
        "rejects a mismatched %s private key even when the public leaf matches",
        async (side) => {
            const r = request();
            if (side === "auth") r.identity.key.privateKey = fixture.ocKey.getKeyPair().privateKey;
            else
                r.nativeBrowserSession.ocIdentity.key.privateKey =
                    fixture.authKey.getKeyPair().privateKey;
            await expect(validate(r)).rejects.toBeInstanceOf(NativeBrowserSessionError);
        },
    );
    it.each(["auth", "oc"] as const)("requires exactly one %s delegation", async (side) => {
        for (const count of [0, 2]) {
            const r = request();
            const chain =
                side === "auth"
                    ? r.identity.delegation
                    : r.nativeBrowserSession.ocIdentity.delegation;
            chain.delegations = Array(count).fill(chain.delegations[0]);
            await expect(validate(r)).rejects.toBeInstanceOf(NativeBrowserSessionError);
        }
    });
    it.each([nowMs, nowMs - 1, nowMs + 30 * 24 * 60 * 60_000 + 1, NaN, Infinity, 1.5])(
        "rejects invalid deadline %s",
        async (expiresAtMs) => {
            const r = request();
            r.nativeBrowserSession.expiresAtMs = expiresAtMs;
            await expect(validate(r)).rejects.toBeInstanceOf(NativeBrowserSessionError);
        },
    );
    it("requires exact AUTH nanoseconds, not a rounded millisecond match", async () => {
        const r = request();
        r.identity = syntheticKeyChain(fixture.authKey, fixture.expiry + 1n, [
            Principal.fromText("aaaaa-aa"),
        ]);
        await expect(validate(r)).rejects.toBeInstanceOf(NativeBrowserSessionError);
    });
    it("requires OC expiry after now and no later than AUTH", async () => {
        for (const expiry of [BigInt(nowMs) * 1_000_000n, fixture.expiry + 1n]) {
            const r = request();
            r.nativeBrowserSession.ocIdentity = syntheticKeyChain(fixture.ocKey, expiry);
            await expect(validate(r)).rejects.toBeInstanceOf(NativeBrowserSessionError);
        }
        const r = request();
        r.nativeBrowserSession.ocIdentity = syntheticKeyChain(
            fixture.ocKey,
            fixture.expiry - 2_000_000n,
        );
        expect((await validate(r)).sessionExpiryMs).toBe(r.nativeBrowserSession.expiresAtMs - 2);
    });
    it("redacts malformed parser or CryptoKey failure details", async () => {
        const r = request();
        r.identity.delegation.publicKey = "private-marker-invalid-hex";
        await expect(validate(r)).rejects.toMatchObject({
            code: "invalid_native_browser_session",
            message: "The verified browser session is invalid, expired, or superseded.",
        });
    });
});
