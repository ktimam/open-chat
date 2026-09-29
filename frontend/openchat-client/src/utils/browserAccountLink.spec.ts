// @vitest-environment node
import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    BrowserAccountLinkFlow,
    browserSignInError,
    createBrowserLinkPasskey,
} from "./browserAccountLink";

const key = {
    credentialId: Uint8Array.of(1, 2),
    publicKey: Uint8Array.of(3),
    origin: "localhost",
    crossPlatform: false,
    aaguid: new Uint8Array(16),
};
function fixture() {
    const adapter = {
        verify: vi.fn(async () => "test-user"),
        createPasskey: vi.fn(async () => key),
        finalize: vi.fn(async () => {}),
        forget: vi.fn(),
    };
    return { adapter, flow: new BrowserAccountLinkFlow(adapter) };
}

describe("browser existing-account link flow", () => {
    it("separates one-time verification from explicit link confirmation", async () => {
        const { adapter, flow } = fixture();
        await flow.verify("ab-cd 23", " test-user ");
        expect(adapter.verify).toHaveBeenCalledExactlyOnceWith("ABCD23");
        expect(flow.state.stage).toBe("verified");
        expect(adapter.createPasskey).not.toHaveBeenCalled();
        expect(adapter.finalize).not.toHaveBeenCalled();
        await flow.complete();
        expect(adapter.createPasskey).toHaveBeenCalledExactlyOnceWith("test-user");
        expect(adapter.finalize).toHaveBeenCalledExactlyOnceWith(key);
        expect(flow.state.stage).toBe("linked");
        expect(flow.signInExpectation()).toEqual({
            username: "test-user",
            credentialId: key.credentialId,
        });
        await flow.verify("EFGH45", "test-user");
        await flow.complete();
        expect(adapter.verify).toHaveBeenCalledOnce();
        expect(adapter.finalize).toHaveBeenCalledOnce();
    });

    it.each(["", "ABC", "ABCDEF7", "ABCIO0"])(
        "rejects invalid code %j without consuming a verification attempt",
        async (code) => {
            const { adapter, flow } = fixture();
            await flow.verify(code, "test-user");
            expect(adapter.verify).not.toHaveBeenCalled();
            await flow.verify("ABCD23", "test-user");
            expect(flow.state.stage).toBe("verified");
        },
    );

    it("rejects an unexpected username before credential creation", async () => {
        const { adapter, flow } = fixture();
        await flow.verify("ABCD23", "different-user");
        await flow.complete();
        expect(flow.state).toMatchObject({ stage: "error", canStartFresh: true });
        expect(adapter.createPasskey).not.toHaveBeenCalled();
        expect(adapter.finalize).not.toHaveBeenCalled();
    });

    it("never retries an uncertain verification or exposes the provider payload", async () => {
        const { adapter, flow } = fixture();
        adapter.verify.mockRejectedValue(new Error("secret-code-payload"));
        await flow.verify("ABCD23", "test-user");
        await flow.verify("ABCD23", "test-user");
        expect(adapter.verify).toHaveBeenCalledOnce();
        expect(JSON.stringify(flow.state)).not.toContain("secret-code-payload");
        expect(flow.state.message).toContain("unknown");
    });

    it("ignores repeated clicks while verification is pending", async () => {
        const { adapter, flow } = fixture();
        let finish!: (username: string) => void;
        adapter.verify.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const pending = flow.verify("ABCD23", "test-user");
        await flow.verify("ABCD23", "test-user");
        finish("test-user");
        await pending;
        expect(adapter.verify).toHaveBeenCalledOnce();
    });

    it("preserves an uncertain finalization for fresh-sign-in reconciliation, never a second write", async () => {
        const { adapter, flow } = fixture();
        adapter.finalize.mockRejectedValue(new Error("sensitive-finalization-response"));
        await flow.verify("ABCD23", "test-user");
        await flow.complete();
        await flow.complete();
        expect(adapter.finalize).toHaveBeenCalledOnce();
        expect(flow.state).toMatchObject({ stage: "uncertain", canStartFresh: false });
        expect(flow.signInExpectation()).toEqual({
            username: "test-user",
            credentialId: key.credentialId,
        });
        expect(JSON.stringify(flow.state)).not.toContain("sensitive-finalization-response");
    });

    it("does not finalize after a cancelled/failed credential creation", async () => {
        const { adapter, flow } = fixture();
        adapter.createPasskey.mockRejectedValue(new DOMException("Cancelled", "NotAllowedError"));
        await flow.verify("ABCD23", "test-user");
        await flow.complete();
        expect(adapter.finalize).not.toHaveBeenCalled();
        expect(flow.state).toMatchObject({ stage: "error", canStartFresh: true });
    });

    it("cannot finalize when the UI closes during credential creation", async () => {
        const { adapter, flow } = fixture();
        let finish!: (result: typeof key) => void;
        adapter.createPasskey.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        await flow.verify("ABCD23", "test-user");
        const pending = flow.complete();
        flow.cancel();
        finish(key);
        await pending;
        expect(adapter.finalize).not.toHaveBeenCalled();
    });

    it("cannot create a credential when the UI closes during verification", async () => {
        const { adapter, flow } = fixture();
        let finish!: (username: string) => void;
        adapter.verify.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const pending = flow.verify("ABCD23", "test-user");
        flow.cancel();
        finish("test-user");
        await pending;
        await flow.complete();
        expect(adapter.createPasskey).not.toHaveBeenCalled();
    });

    it("keeps provider messages out of sign-in feedback", () => {
        expect(browserSignInError(new Error("secret-provider-payload"))).not.toContain(
            "secret-provider-payload",
        );
        expect(browserSignInError({ code: "existing_account_required" })).toContain("explicit");
        expect(browserSignInError(new DOMException("raw", "NotAllowedError"))).toContain(
            "cancelled",
        );
    });
});

describe("explicit browser-link credential creation", () => {
    afterEach(() => vi.unstubAllGlobals());

    type SyntheticCreation = {
        type: string;
        rawId: Uint8Array;
        authenticatorAttachment: string;
        response: { clientDataJSON: Uint8Array; getAuthenticatorData: () => Uint8Array };
    };

    async function run(mutate?: (value: SyntheticCreation) => void) {
        vi.stubGlobal("crypto", webcrypto);
        vi.stubGlobal("location", new URL("http://localhost:5187"));
        const create = vi.fn(async (options: CredentialCreationOptions) => {
            const authData = new Uint8Array(58);
            authData.set(
                new Uint8Array(
                    await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode("localhost")),
                ),
            );
            authData[32] = 0x45;
            authData[54] = 2;
            authData.set(key.credentialId, 55);
            authData[57] = 0xa0; // Synthetic inert COSE map, no real key/provider involved.
            const value: SyntheticCreation = {
                type: "public-key",
                rawId: key.credentialId,
                authenticatorAttachment: "platform",
                response: {
                    clientDataJSON: new TextEncoder().encode(
                        JSON.stringify({
                            type: "webauthn.create",
                            origin: "http://localhost:5187",
                            challenge: Buffer.from(
                                options.publicKey!.challenge as Uint8Array,
                            ).toString("base64url"),
                            crossOrigin: false,
                        }),
                    ),
                    getAuthenticatorData: () => authData,
                },
            };
            mutate?.(value);
            return value;
        });
        vi.stubGlobal("navigator", { credentials: { create } });
        const pending = createBrowserLinkPasskey("localhost", "test-user");
        expect(create).toHaveBeenCalledOnce();
        return { create, pending };
    }

    it("requests an explicit discoverable UV-required key and returns public metadata only", async () => {
        const { create, pending } = await run();
        await expect(pending).resolves.toMatchObject({
            origin: "localhost",
            credentialId: key.credentialId,
            crossPlatform: false,
        });
        expect(create.mock.calls[0][0].publicKey).toMatchObject({
            rp: { id: "localhost" },
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
            authenticatorSelection: { residentKey: "required", userVerification: "required" },
        });
    });

    it.each(["type", "rp", "uv", "id", "origin", "challenge"])(
        "rejects a creation response with wrong %s",
        async (field) => {
            const { pending } = await run((value) => {
                const authData = value.response.getAuthenticatorData();
                if (field === "type") value.type = "password";
                if (field === "rp") authData[0] ^= 1;
                if (field === "uv") authData[32] = 0x41;
                if (field === "id") value.rawId = Uint8Array.of(9, 9);
                if (field === "origin" || field === "challenge") {
                    const data = JSON.parse(
                        new TextDecoder().decode(value.response.clientDataJSON),
                    );
                    data[field] = "wrong";
                    value.response.clientDataJSON = new TextEncoder().encode(JSON.stringify(data));
                }
            });
            await expect(pending).rejects.toThrow();
        },
    );
});
