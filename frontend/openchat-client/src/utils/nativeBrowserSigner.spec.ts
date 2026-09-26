// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { IC_REQUEST_AUTH_DELEGATION_DOMAIN_SEPARATOR, requestIdOf } from "@icp-sdk/core/agent";
import { Delegation } from "@icp-sdk/core/identity";
import { Principal } from "@icp-sdk/core/principal";
const mocks = vi.hoisted(() => ({ picker: vi.fn(), validate: vi.fn(), verify: vi.fn() }));
vi.mock("./browserPasskey", () => ({ requestBrowserPasskeyAssertion: mocks.picker }));
vi.mock("./nativeBrowserAuth", () => ({ createNativeBrowserAuthVerifier: mocks.validate }));
import { signNativeBrowserChallenge } from "./nativeBrowserSigner";
import type { NativeBrowserAuthChallenge } from "./nativeBrowserAuth";

const challenge: NativeBrowserAuthChallenge = {
    protocol: "openchat.local-browser-auth.v1", attemptId: "aa".repeat(16), nonce: "bb".repeat(32),
    origin: "http://localhost:40001", url: "http://localhost:40001/sign-in",
    sessionPublicKeyDerHex: "01".repeat(91), expectedUsername: "synthetic-user",
    identityCanister: "aaaaa-aa", identityTargetHex: "", expiresAtMs: 1, delegationExpiresAtMs: 2,
    clientLabel: "OpenChat Fork · Local Test",
};
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });
describe("native browser signer wiring (cryptography is tested separately)", () => {
    it("signs the exact APK key/lifetime/sole target and requests UV before lookup", async () => {
        vi.stubGlobal("location", new URL(challenge.origin));
        const sequence: string[] = [];
        const id = Uint8Array.of(1, 2);
        const signature = new Uint8Array(80).fill(3);
        const root = new Uint8Array(91).fill(4);
        mocks.validate.mockReturnValue({ verify: mocks.verify });
        mocks.picker.mockImplementation(async () => { sequence.push("picker"); return { credentialId: id, signature }; });
        const lookup = vi.fn(async () => { sequence.push("lookup"); return root; });
        const promise = signNativeBrowserChallenge(challenge, "aaaaa-aa", lookup);
        expect(sequence).toEqual(["picker"]);
        const candidate = await promise;
        const delegation = new Delegation(new Uint8Array(91).fill(1), 2_000_000n, [Principal.fromText("aaaaa-aa")]);
        expect(mocks.picker).toHaveBeenCalledWith("localhost",
            Uint8Array.from([...IC_REQUEST_AUTH_DELEGATION_DOMAIN_SEPARATOR, ...requestIdOf({ ...delegation })]),
            undefined, undefined, "required");
        expect(sequence).toEqual(["picker", "lookup"]);
        expect(lookup).toHaveBeenCalledWith(id);
        expect(candidate.delegation.delegations).toHaveLength(1);
        expect(candidate.delegation.delegations[0].delegation).toEqual(delegation.toJSON());
        expect(mocks.verify).toHaveBeenCalledWith(candidate, root);
    });
    it.each(["http://localhost:40002", "https://untrusted.example"])("rejects origin %s before invoking a picker", async origin => {
        vi.stubGlobal("location", new URL(origin));
        await expect(signNativeBrowserChallenge(challenge, "aaaaa-aa", vi.fn())).rejects.toThrow();
        expect(mocks.picker).not.toHaveBeenCalled();
    });
    it("does not trust a target supplied by the page transport", async () => {
        vi.stubGlobal("location", new URL(challenge.origin));
        await expect(signNativeBrowserChallenge(challenge, "2vxsx-fae", vi.fn())).rejects.toThrow();
        expect(mocks.picker).not.toHaveBeenCalled();
    });
});
