// @vitest-environment node
import { webcrypto } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Delegation, DelegationChain, ECDSAKeyIdentity } from "@icp-sdk/core/identity";
import { Principal } from "@icp-sdk/core/principal";
import type { Signature } from "@icp-sdk/core/agent";
import {
    establishNativeBrowserAccountSession,
    lookupNativeBrowserCredential,
} from "./nativeBrowserAccountSession";

const calls = vi.hoisted(() => ({
    create: vi.fn(),
    lookup: vi.fn(),
    check: vi.fn(),
    prepare: vi.fn(),
    get: vi.fn(),
    profile: vi.fn(),
    fetch: vi.fn(),
    profileQuery: vi.fn(),
}));
vi.mock("@icp-sdk/core/agent", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@icp-sdk/core/agent")>()),
    HttpAgent: { create: calls.create },
}));
vi.mock("./identity/identity.client", () => ({
    IdentityClient: class {
        lookupWebAuthnPubKey = calls.lookup;
        checkAuthPrincipal = calls.check;
        prepareDelegation = calls.prepare;
        getDelegation = calls.get;
    },
}));
vi.mock("./canisterAgent/msgpack", () => ({
    SingleCanisterMsgpackAgent: class {
        query(...args: unknown[]) {
            calls.profileQuery(...args);
            return calls.profile();
        }
    },
}));
vi.mock("./userIndex/mappers", () => ({ currentUserResponse: (v: unknown) => v }));
vi.mock("../typebox", () => ({ Empty: {}, UserIndexCurrentUserResponse: {} }));

const now = 1_800_000_000_000;
const identityCanister = Principal.fromUint8Array(Uint8Array.of(1, 2, 3)).toText();
const userIndexCanister = Principal.fromUint8Array(Uint8Array.of(4, 5, 6)).toText();
const userId = Principal.fromUint8Array(Uint8Array.of(7, 8, 9)).toText();
const profile = { kind: "created_user", username: "synthetic-user", userId };
const fakeSignature = new Uint8Array(64) as Signature;
async function request() {
    const authKey = await ECDSAKeyIdentity.generate();
    const root = await ECDSAKeyIdentity.generate();
    const authChain = DelegationChain.fromDelegations(
        [
            {
                delegation: new Delegation(
                    authKey.getPublicKey().toDer().slice(),
                    BigInt(now + 300_000) * 1_000_000n,
                    [Principal.fromText(identityCanister)],
                ),
                signature: fakeSignature,
            },
        ],
        root.getPublicKey().toDer(),
    );
    return {
        authKey,
        authChain,
        expiresAtMs: now + 300_000,
        expectedUsername: "synthetic-user",
        identityCanister,
        userIndexCanister,
        icUrl: "https://icp-api.io",
    };
}

describe("native bridge official account preflight orchestration (mocked transport, not real account proof)", () => {
    beforeEach(() => {
        vi.stubGlobal("crypto", webcrypto);
        vi.stubGlobal("fetch", calls.fetch);
        vi.spyOn(Date, "now").mockReturnValue(now);
        for (const fn of Object.values(calls)) fn.mockReset();
        calls.create.mockResolvedValue({});
        calls.lookup.mockResolvedValue(new Uint8Array(91).fill(3));
        calls.check.mockResolvedValue({ kind: "success", userId, isIIPrincipal: false });
        calls.prepare.mockImplementation(async () => ({
            kind: "success",
            userKey: new Uint8Array(91).fill(4),
            expiration: BigInt(now + 290_000) * 1_000_000n,
            proofJwt: "unused-synthetic-marker",
        }));
        calls.get.mockImplementation(async (pubkey, expiration) => ({
            kind: "success",
            delegation: new Delegation(pubkey, expiration),
            signature: fakeSignature,
        }));
        calls.profile.mockResolvedValue(profile);
        calls.fetch.mockResolvedValue(new Response("synthetic"));
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("performs fresh anonymous credential lookup each time with verification and zero caching", async () => {
        const first = await lookupNativeBrowserCredential(
            identityCanister,
            "https://icp-api.io",
            Uint8Array.of(1),
        );
        first[0] = 99;
        const second = await lookupNativeBrowserCredential(
            identityCanister,
            "https://icp-api.io",
            Uint8Array.of(1),
        );
        expect(second[0]).toBe(3);
        expect(calls.lookup).toHaveBeenCalledTimes(2);
        expect(calls.create).toHaveBeenCalledTimes(2);
        expect(calls.create.mock.calls[0][0]).toMatchObject({
            verifyQuerySignatures: true,
            retryTimes: 0,
            host: "https://icp-api.io",
        });
        expect(calls.create.mock.calls[0][0].identity.getPrincipal().isAnonymous()).toBe(true);
        expect(calls.prepare).not.toHaveBeenCalled();
    });

    it("returns only the independently matched account and a bounded ephemeral OC session", async () => {
        const result = await establishNativeBrowserAccountSession(await request());
        expect(result.profile).toEqual(profile);
        expect(calls.check).toHaveBeenCalledOnce();
        expect(calls.prepare).toHaveBeenCalledOnce();
        expect(calls.prepare.mock.calls[0][1]).toBe(false);
        expect(calls.prepare.mock.calls[0][2]).toBe(290_000_000_000n);
        expect(calls.profileQuery.mock.calls[0][0]).toBe("current_user");
        expect(result.ocChain.delegations[0].delegation.pubkey).toEqual(
            result.ocKey.getPublicKey().toDer(),
        );
        expect(result.ocChain.delegations[0].delegation.expiration).toBe(
            BigInt(now + 290_000) * 1_000_000n,
        );
        expect(calls.create).toHaveBeenCalledTimes(2);
        for (const [options] of calls.create.mock.calls)
            expect(options.verifyQuerySignatures).toBe(true);
    });

    it("requests a freshly signed 30-day session but never beyond the original AUTH expiry", async () => {
        const input = await request();
        input.expiresAtMs = now + 30 * 24 * 60 * 60_000;
        const signed = input.authChain.delegations[0];
        input.authChain = DelegationChain.fromDelegations(
            [
                {
                    delegation: new Delegation(
                        signed.delegation.pubkey,
                        BigInt(input.expiresAtMs) * 1_000_000n,
                        signed.delegation.targets,
                    ),
                    signature: signed.signature,
                },
            ],
            input.authChain.publicKey,
        );
        calls.prepare.mockImplementation(async (_key, _ii, ttl: bigint) => ({
            kind: "success",
            userKey: new Uint8Array(91).fill(4),
            expiration: BigInt(now) * 1_000_000n + ttl,
        }));
        const result = await establishNativeBrowserAccountSession(input);
        expect(calls.prepare.mock.calls[0][2]).toBe(
            BigInt(input.expiresAtMs - now - 10_000) * 1_000_000n,
        );
        expect(result.ocChain.delegations[0].delegation.expiration).toBeLessThan(
            input.authChain.delegations[0].delegation.expiration,
        );
    });

    it("restores only the pinned user ID and OC principal, allowing a legitimate username change", async () => {
        const input = await request();
        const { DelegationIdentity } = await import("@icp-sdk/core/identity");
        const first = await establishNativeBrowserAccountSession(input);
        const expectedAccount = {
            userId,
            ocPrincipal: DelegationIdentity.fromDelegation(first.ocKey, first.ocChain)
                .getPrincipal()
                .toString(),
        };
        calls.profile.mockResolvedValue({ ...profile, username: "renamed-user" });
        await expect(
            establishNativeBrowserAccountSession({ ...input, expectedAccount }),
        ).resolves.toMatchObject({ profile: { username: "renamed-user" } });
        await expect(
            establishNativeBrowserAccountSession({
                ...input,
                expectedAccount: { ...expectedAccount, userId: userIndexCanister },
            }),
        ).rejects.toThrow();
        await expect(
            establishNativeBrowserAccountSession({
                ...input,
                expectedAccount: { ...expectedAccount, ocPrincipal: userIndexCanister },
            }),
        ).rejects.toThrow();
    });

    it.each([
        "http://localhost:4943",
        "https://attacker.example",
        "https://icp-api.io.evil.test",
        "https://icp-api.io/?secret=x",
    ])("rejects untrusted IC host %s before network", async (icUrl) => {
        await expect(
            establishNativeBrowserAccountSession({ ...(await request()), icUrl }),
        ).rejects.toThrow();
        expect(calls.create).not.toHaveBeenCalled();
    });

    it.each([
        { kind: "not_found" },
        { kind: "success", userId: undefined },
        { kind: "success", userId, isIIPrincipal: true },
    ])(
        "rejects invalid existing-account mapping before preparing a delegation",
        async (mapping) => {
            calls.check.mockResolvedValue(mapping);
            await expect(establishNativeBrowserAccountSession(await request())).rejects.toThrow();
            expect(calls.prepare).not.toHaveBeenCalled();
        },
    );

    it.each([
        { ...profile, username: "another-user" },
        { ...profile, userId: userIndexCanister },
        { kind: "unknown_user" },
    ])("rejects mismatched or absent fresh profile without activating anything", async (value) => {
        calls.profile.mockResolvedValue(value);
        await expect(establishNativeBrowserAccountSession(await request())).rejects.toThrow();
        expect(calls.prepare).toHaveBeenCalledOnce();
    });

    it("rejects a wrong AUTH key, scope, expiry or extra link before network", async () => {
        for (const variant of ["key", "targets", "expiry", "chain"]) {
            const input = await request();
            const delegation = input.authChain.delegations[0].delegation;
            if (variant === "key") delegation.pubkey[0] ^= 1;
            if (variant === "targets")
                delegation.targets!.push(Principal.fromText(userIndexCanister));
            if (variant === "expiry") input.expiresAtMs++;
            if (variant === "chain")
                input.authChain.delegations.push(input.authChain.delegations[0]);
            await expect(establishNativeBrowserAccountSession(input)).rejects.toThrow();
        }
        expect(calls.create).not.toHaveBeenCalled();
    });

    it("rejects server TTL amplification and expired delegation", async () => {
        for (const expiration of [now + 300_001, now]) {
            calls.prepare.mockResolvedValue({
                kind: "success",
                userKey: new Uint8Array(91),
                expiration: BigInt(expiration) * 1_000_000n,
            });
            await expect(establishNativeBrowserAccountSession(await request())).rejects.toThrow();
        }
        expect(calls.get).not.toHaveBeenCalled();
    });

    it("rejects changed final key/expiry/scope even after a successful prepare", async () => {
        for (const variant of ["key", "expiry", "targets"]) {
            calls.get.mockImplementation(async (key, expiry) => ({
                kind: "success",
                signature: fakeSignature,
                delegation: new Delegation(
                    variant === "key" ? new Uint8Array(91) : key,
                    variant === "expiry" ? expiry + 1n : expiry,
                    variant === "targets" ? [] : undefined,
                ),
            }));
            await expect(establishNativeBrowserAccountSession(await request())).rejects.toThrow();
        }
        expect(calls.profile).not.toHaveBeenCalled();
    });

    it("makes only bounded query retries for not_found, never re-prepares", async () => {
        calls.get.mockResolvedValue({ kind: "not_found" });
        await expect(establishNativeBrowserAccountSession(await request())).rejects.toThrow();
        expect(calls.get).toHaveBeenCalledTimes(5);
        expect(calls.prepare).toHaveBeenCalledOnce();
        expect(calls.profile).not.toHaveBeenCalled();
    });

    it("does not retry uncertain prepare, and redacts provider errors", async () => {
        calls.prepare.mockRejectedValue(new Error("SECRET_SIGNED_MARKER"));
        await expect(establishNativeBrowserAccountSession(await request())).rejects.toThrow(
            "The official OpenChat account could not be verified",
        );
        expect(calls.prepare).toHaveBeenCalledOnce();
        expect(calls.get).not.toHaveBeenCalled();
    });

    it("does not accept cancellation or expiry during an await", async () => {
        const controller = new AbortController();
        calls.check.mockImplementation(async () => {
            controller.abort();
            return { kind: "success", userId, isIIPrincipal: false };
        });
        await expect(
            establishNativeBrowserAccountSession({
                ...(await request()),
                signal: controller.signal,
            }),
        ).rejects.toThrow("cancelled");
        expect(calls.prepare).not.toHaveBeenCalled();
        calls.check.mockImplementation(async () => {
            vi.mocked(Date.now).mockReturnValue(now + 300_001);
            return { kind: "success", userId, isIIPrincipal: false };
        });
        await expect(establishNativeBrowserAccountSession(await request())).rejects.toThrow();
        expect(calls.prepare).not.toHaveBeenCalled();
    });

    it("limits transport to exact official endpoints, omits cookies, rejects redirects and resubmission", async () => {
        await lookupNativeBrowserCredential(
            identityCanister,
            "https://icp-api.io",
            Uint8Array.of(1),
        );
        const transport = calls.create.mock.calls[0][0].fetch as typeof fetch;
        await expect(transport("https://attacker.example/api/v2/status")).rejects.toThrow();
        expect(calls.fetch).not.toHaveBeenCalled();
        await transport(`https://icp-api.io/api/v3/canister/${identityCanister}/call`, {
            method: "POST",
        });
        expect(calls.fetch.mock.calls[0][1]).toMatchObject({
            credentials: "omit",
            cache: "no-store",
            redirect: "error",
        });
        await expect(
            transport(`https://icp-api.io/api/v3/canister/${identityCanister}/call`, {
                method: "POST",
            }),
        ).rejects.toThrow();
        expect(calls.fetch).toHaveBeenCalledOnce();
    });
});
