// @vitest-environment node
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Cbor } from "@icp-sdk/core/agent";
import { WebAuthnIdentity } from "@icp-sdk/core/identity";
import { PickerWebAuthnIdentity, requestBrowserPasskeyAssertion } from "./browserPasskey";
import { MultiWebAuthnIdentity } from "./webAuthn";

const origin = "https://chat.example.test";
const rpId = "example.test";
const credentialId = Uint8Array.of(1, 2, 3, 4);
const cose = Uint8Array.of(0xa0);
const challenge = Uint8Array.from({ length: 59 }, (_, index) => index + 1);
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

async function assertion(bytes = challenge) {
    const authenticatorData = new Uint8Array(37);
    authenticatorData.set(new Uint8Array(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId))));
    authenticatorData[32] = 5;
    return {
        type: "public-key",
        rawId: credentialId.slice(),
        response: {
            clientDataJSON: encode({ type: "webauthn.get", origin, challenge: Buffer.from(bytes).toString("base64url"), crossOrigin: false }),
            authenticatorData,
            // An inert signature tests transport, not cryptographic verification or real login.
            signature: Uint8Array.of(0x30, 0x06, 0x02, 0x01, 1, 0x02, 0x01, 1),
        },
    };
}

type Assertion = Awaited<ReturnType<typeof assertion>>;
function editClientData(result: Assertion, changes: Record<string, unknown>) {
    const data = JSON.parse(new TextDecoder().decode(result.response.clientDataJSON));
    result.response.clientDataJSON = encode({ ...data, ...changes });
}

describe("validated browser passkey picker", () => {
    const get = vi.fn();
    const network = vi.fn(() => { throw new Error("Unexpected network request"); });

    beforeEach(() => {
        get.mockReset();
        network.mockClear();
        vi.stubGlobal("location", new URL(origin));
        vi.stubGlobal("navigator", { credentials: { get } });
        vi.stubGlobal("crypto", webcrypto);
        vi.stubGlobal("fetch", network);
    });

    afterEach(() => {
        expect(network).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it("uses the picker synchronously, preserving the full IC challenge and SDK wire shape", async () => {
        const returned = await assertion();
        get.mockResolvedValue(returned);
        const picker = new PickerWebAuthnIdentity(rpId, credentialId, cose);
        const sdk = new WebAuthnIdentity(credentialId, cose, undefined);
        const pending = picker.sign(challenge);
        expect(get).toHaveBeenCalledOnce();
        expect(get.mock.calls[0][0].publicKey).toEqual({
            challenge, rpId, userVerification: "preferred", timeout: 60_000,
        });
        expect(picker.getPublicKey().toDer()).toEqual(sdk.getPublicKey().toDer());
        const wire = Cbor.decode(await pending) as Record<string, unknown>;
        expect(Object.keys(wire).sort()).toEqual(["authenticator_data", "client_data_json", "signature"]);
        expect(wire.authenticator_data).toEqual(returned.response.authenticatorData);
        expect(wire.client_data_json).toEqual(new TextDecoder().decode(returned.response.clientDataJSON));
        expect(wire.signature).toEqual(returned.response.signature);
        expect(challenge).toEqual(Uint8Array.from({ length: 59 }, (_, index) => index + 1));
    });

    const invalid: [string, (value: Assertion) => void][] = [
        ["another saved ID", value => { value.rawId = Uint8Array.of(9); }],
        ["empty ID", value => { value.rawId = new Uint8Array(); }],
        ["oversized ID", value => { value.rawId = new Uint8Array(4097); }],
        ["wrong credential type", value => { value.type = "password"; }],
        ["wrong operation", value => editClientData(value, { type: "webauthn.create" })],
        ["wrong challenge", value => editClientData(value, { challenge: "bad" })],
        ["different origin", value => editClientData(value, { origin: "https://example.test" })],
        ["different origin port", value => editClientData(value, { origin: `${origin}:444` })],
        ["cross-origin", value => editClientData(value, { crossOrigin: true })],
        ["malformed cross-origin", value => editClientData(value, { crossOrigin: "false" })],
        ["wrong RP hash", value => { value.response.authenticatorData[0] ^= 1; }],
        ["no user presence", value => { value.response.authenticatorData[32] = 4; }],
        ["short authenticator data", value => { value.response.authenticatorData = new Uint8Array(36); }],
        ["empty signature", value => { value.response.signature = new Uint8Array(); }],
        ["oversized signature", value => { value.response.signature = new Uint8Array(1025); }],
        ["invalid JSON", value => { value.response.clientDataJSON = new TextEncoder().encode("{"); }],
        ["invalid UTF-8", value => { value.response.clientDataJSON = Uint8Array.of(0xff); }],
    ];

    it.each(invalid)("rejects %s without retrying or replacing the credential", async (_, mutate) => {
        const returned = await assertion();
        mutate(returned);
        get.mockResolvedValue(returned);
        const savedId = credentialId.slice();
        await expect(new PickerWebAuthnIdentity(rpId, savedId, cose).sign(challenge)).rejects.toThrow();
        expect(get).toHaveBeenCalledOnce();
        expect(savedId).toEqual(credentialId);
    });

    it("propagates cancellation once without credential creation or retry", async () => {
        const error = new DOMException("Cancelled", "NotAllowedError");
        get.mockRejectedValue(error);
        await expect(new PickerWebAuthnIdentity(rpId, credentialId, cose).sign(challenge)).rejects.toBe(error);
        expect(get).toHaveBeenCalledOnce();
    });

    it("rejects late success after cancellation", async () => {
        const controller = new AbortController();
        const returned = await assertion();
        get.mockImplementation(async () => { controller.abort(); return returned; });
        await expect(new PickerWebAuthnIdentity(rpId, credentialId, cose, controller.signal).sign(challenge)).rejects.toMatchObject({ name: "AbortError" });
    });

    it("accepts user presence without UV under the SDK's preferred policy", async () => {
        const returned = await assertion();
        returned.response.authenticatorData[32] = 1;
        get.mockResolvedValue(returned);
        await expect(new PickerWebAuthnIdentity(rpId, credentialId, cose).sign(challenge)).resolves.toBeInstanceOf(Uint8Array);
    });

    it.each(["https://unrelated.test", "http://chat.example.test"])("rejects unsuitable client origin %s before the picker", async currentOrigin => {
        vi.stubGlobal("location", new URL(currentOrigin));
        await expect(new PickerWebAuthnIdentity(rpId, credentialId, cose).sign(challenge)).rejects.toThrow();
        expect(get).not.toHaveBeenCalled();
    });

    it("supports the local-test origin without hardcoding it as the only RP", async () => {
        vi.stubGlobal("location", new URL("http://localhost:5187"));
        const returned = await assertion();
        editClientData(returned, { origin: "http://localhost:5187" });
        returned.response.authenticatorData.set(new Uint8Array(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode("localhost"))));
        get.mockResolvedValue(returned);
        await expect(requestBrowserPasskeyAssertion("localhost", challenge, credentialId)).resolves.toMatchObject({ credentialId });
    });

    it("binds discovery to the selected key for every later signature", async () => {
        get.mockResolvedValue(await assertion());
        const sdk = new WebAuthnIdentity(credentialId, cose, undefined);
        const lookup = vi.fn(async () => sdk.getPublicKey().toDer());
        const identity = new MultiWebAuthnIdentity(rpId, lookup, true);
        await identity.sign(challenge);
        expect(lookup).toHaveBeenCalledOnce();
        expect(identity.innerIdentity()).toBeInstanceOf(PickerWebAuthnIdentity);
        const another = await assertion();
        another.rawId = Uint8Array.of(9);
        get.mockResolvedValue(another);
        await expect(identity.sign(challenge)).rejects.toThrow("Choose the passkey");
        expect(lookup).toHaveBeenCalledOnce();
        for (const [options] of get.mock.calls) expect(options.publicKey).not.toHaveProperty("allowCredentials");
    });
});
