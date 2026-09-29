import { describe, expect, it, vi } from "vitest";
import { queryOfficialUserIndexPublicKey } from "../officialPublicKeyQuery.mjs";

describe("unofficial client public key bootstrap", () => {
    it("uses an anonymous verified mainnet query, never fetches a replacement root key", async () => {
        const agent = {};
        const createAgent = vi.fn(async () => agent);
        const publicKey = vi.fn(async () => ({ Success: "test-pem" }));
        const createActor = vi.fn(() => ({ public_key: publicKey }));
        await expect(
            queryOfficialUserIndexPublicKey("aaaaa-aa", { createAgent, createActor }),
        ).resolves.toBe("test-pem");
        expect(createAgent).toHaveBeenCalledWith({
            host: "https://icp-api.io",
            shouldFetchRootKey: false,
            verifyQuerySignatures: true,
            retryTimes: 0,
        });
        expect(createActor).toHaveBeenCalledWith(expect.any(Function), {
            agent,
            canisterId: "aaaaa-aa",
        });
        expect(publicKey).toHaveBeenCalledExactlyOnceWith({});
    });
    it.each([{ NotInitialised: null }, { Error: {} }, {}, null, { Success: 4 }])(
        "fails closed for unavailable or malformed result %j",
        async (response) => {
            await expect(
                queryOfficialUserIndexPublicKey("aaaaa-aa", {
                    createAgent: async () => ({}),
                    createActor: () => ({ public_key: async () => response }),
                }),
            ).rejects.toThrow("public key is unavailable");
        },
    );
    it("validates the canister before doing any network work", async () => {
        const createAgent = vi.fn();
        await expect(
            queryOfficialUserIndexPublicKey("bad-principal", { createAgent }),
        ).rejects.toThrow();
        expect(createAgent).not.toHaveBeenCalled();
    });
});
