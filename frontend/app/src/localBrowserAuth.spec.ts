// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost:49123/sign-in"}
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DER_COSE_OID, wrapDER } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import type { ECDSAKeyIdentity } from "@icp-sdk/core/identity";
import type { NativeBrowserAuthChallenge } from "@client/utils/nativeBrowserAuth";

const mocks = vi.hoisted(() => ({
    agent: vi.fn(),
    network: vi.fn(),
    pageFetch: vi.fn(),
    createPasskey: vi.fn(),
    signer: vi.fn(),
    lookup: vi.fn(),
    finalise: vi.fn(),
    agents: [] as { key: unknown; transport: typeof fetch }[],
}));

// Keep the actual lifecycle/once-only guards. Only the platform passkey picker is synthetic.
vi.mock("@client/utils/browserAccountLink", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@client/utils/browserAccountLink")>()),
    createBrowserLinkPasskey: mocks.createPasskey,
}));
vi.mock("@agent/services/identityAgent", async () => {
    const { createSingleSubmissionFetch } = await import("@agent/utils/singleSubmissionFetch");
    return {
        IdentityAgent: {
            create: async (...args: unknown[]) => {
                mocks.agent(...args);
                const [key, canister, icUrl, , singleSubmission] = args;
                if (singleSubmission !== true)
                    throw new Error("Test requires the real one-shot transport");
                // One independently allocated transport per agent. Reusing the verification agent for
                // finalization would be rejected here, exactly as in the real single-submission wrapper.
                const transport = createSingleSubmissionFetch(
                    mocks.network as typeof fetch,
                    new AbortController().signal,
                );
                mocks.agents.push({ key, transport });
                const url = `${icUrl}/api/v3/canister/${canister}/call`;
                return {
                    verifyAccountLinkingCode: async (code: string) => {
                        const response = await transport(url, {
                            method: "POST",
                            body: JSON.stringify({ operation: "verify", code }),
                        });
                        return response.json();
                    },
                    finaliseAccountLinkingWithCode: async (...values: unknown[]) => {
                        mocks.finalise(...values);
                        await transport(url, {
                            method: "POST",
                            body: JSON.stringify({ operation: "finalise" }),
                        });
                    },
                };
            },
        },
    };
});
vi.mock("@agent/services/nativeBrowserAccountSession", () => ({
    lookupNativeBrowserCredential: mocks.lookup,
}));
vi.mock("@client/utils/nativeBrowserSigner", () => ({ signNativeBrowserChallenge: mocks.signer }));

const html = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../local-browser-auth.html"),
    "utf8",
);
const identity = Principal.fromUint8Array(Uint8Array.of(1, 2, 3)).toText();
const start = 1_800_000_000_000;
const credentialId = Uint8Array.of(7, 8, 9);
const syntheticCredential = {
    credentialId,
    // Synthetic public material only; this fixture never invokes a real platform credential.
    publicKey: wrapDER(
        Uint8Array.from([
            0xa5,
            1,
            2,
            3,
            0x26,
            0x20,
            1,
            0x21,
            0x58,
            32,
            ...new Uint8Array(32).fill(1),
            0x22,
            0x58,
            32,
            ...new Uint8Array(32).fill(2),
        ]),
        DER_COSE_OID,
    ),
    origin: "localhost",
    aaguid: new Uint8Array(16),
    crossPlatform: false,
};
const challenge: NativeBrowserAuthChallenge = {
    protocol: "openchat.local-browser-auth.v1",
    attemptId: "aa".repeat(16),
    nonce: "bb".repeat(32),
    origin: "http://localhost:49123",
    url: "http://localhost:49123/sign-in",
    sessionPublicKeyDerHex: "03".repeat(91),
    expectedUsername: "synthetic-user",
    identityCanister: identity,
    identityTargetHex: Principal.fromText(identity).toHex(),
    expiresAtMs: start + 120_000,
    delegationExpiresAtMs: start + 300_000,
    clientLabel: "OpenChat Fork · Local Test",
};
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const text = (id: string) => document.getElementById(id)!.textContent ?? "";
const localSubmissions = () => mocks.pageFetch.mock.calls.filter(([url]) => url === "/candidate");
const operations = () =>
    mocks.network.mock.calls.map(([, init]) => JSON.parse(init.body as string).operation);
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
async function mount() {
    await import("./localBrowserAuth");
    await vi.waitFor(() => expect(button("sign-in").disabled).toBe(false));
}
async function verifyCode(code = "ABC234") {
    button("start-link").click();
    input("code").value = code;
    button("verify-code").click();
    await vi.waitFor(() => expect(text("link-status")).toContain("Username verified"));
}
function confirmCreation() {
    input("confirm").checked = true;
    input("confirm").dispatchEvent(new Event("change", { bubbles: true }));
    button("create-passkey").click();
}

beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(start);
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("__LOCAL_IDENTITY_CANISTER__", identity);
    // Render the shipped HTML, without executing its script tag; import the actual entry below.
    document.documentElement.innerHTML = html
        .replace(/<!doctype[^>]*>/i, "")
        .replace(/<\/?html[^>]*>/gi, "");
    for (const fn of [
        mocks.agent,
        mocks.network,
        mocks.pageFetch,
        mocks.createPasskey,
        mocks.signer,
        mocks.lookup,
        mocks.finalise,
    ])
        fn.mockReset();
    mocks.agents.length = 0;
    mocks.network.mockResolvedValue(
        new Response(JSON.stringify({ kind: "success", username: "synthetic-user" }), {
            headers: { "Content-Type": "application/json" },
        }),
    );
    mocks.pageFetch.mockImplementation(async (url: string) => {
        if (url === "/challenge") return new Response(JSON.stringify(challenge));
        if (url === "/candidate") return new Response("{}", { status: 202 });
        throw new Error("Unexpected page request");
    });
    mocks.createPasskey.mockResolvedValue(syntheticCredential);
    mocks.lookup.mockResolvedValue(syntheticCredential.publicKey);
    mocks.signer.mockImplementation(
        async (_request, _identity, lookup: (id: Uint8Array) => Promise<Uint8Array>) => {
            await lookup(credentialId);
            return {
                protocol: challenge.protocol,
                attemptId: challenge.attemptId,
                nonce: challenge.nonce,
                credentialIdHex: "070809",
                delegation: { publicKey: "synthetic-marker", delegations: [] },
            };
        },
    );
    vi.stubGlobal("fetch", mocks.pageFetch);
});
afterEach(() => {
    window.dispatchEvent(new Event("pagehide"));
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.documentElement.innerHTML = "<head></head><body></body>";
});

describe("bundled local browser authentication page (synthetic DOM + real linking lifecycle/one-shot transport)", () => {
    it("loads only public request metadata; never opens a picker or calls official services before a user gesture", async () => {
        await mount();
        expect(text("username")).toBe("synthetic-user");
        expect(input("code").type).toBe("text");
        expect(mocks.pageFetch).toHaveBeenCalledOnce();
        expect(mocks.pageFetch.mock.calls[0][0]).toBe("/challenge");
        expect(mocks.agent).not.toHaveBeenCalled();
        expect(mocks.network).not.toHaveBeenCalled();
        expect(mocks.createPasskey).not.toHaveBeenCalled();
        expect(mocks.signer).not.toHaveBeenCalled();
        expect(mocks.lookup).not.toHaveBeenCalled();
        expect(localSubmissions()).toHaveLength(0);
    });

    it("lets the user correct a locally invalid code without consuming it or restarting the flow", async () => {
        await mount();
        button("start-link").click();
        input("code").value = "BAD";
        button("verify-code").click();
        await vi.waitFor(() => expect(text("link-status")).toContain("Nothing was sent"));
        expect(mocks.agent).not.toHaveBeenCalled();
        expect(mocks.network).not.toHaveBeenCalled();
        expect(button("verify-code").disabled).toBe(false);
        expect(input("code").disabled).toBe(false);
        input("code").value = "ABC234";
        button("verify-code").click();
        await vi.waitFor(() => expect(text("link-status")).toContain("Username verified"));
        expect(input("code").value).toBe("");
        expect(operations()).toEqual(["verify"]);
        expect(mocks.createPasskey).not.toHaveBeenCalled();
    });

    it("requires separate confirmation, finalizes once using a fresh one-shot agent with the same exact ephemeral key", async () => {
        await mount();
        await verifyCode();
        expect(button("create-passkey").disabled).toBe(true);
        button("create-passkey").click();
        expect(mocks.createPasskey).not.toHaveBeenCalled();
        expect(operations()).toEqual(["verify"]);
        confirmCreation();
        await vi.waitFor(() => expect(text("link-status")).toContain("Passkey linked"));
        expect(mocks.createPasskey).toHaveBeenCalledExactlyOnceWith(
            "localhost",
            "synthetic-user",
            expect.any(AbortSignal),
        );
        expect(operations()).toEqual(["verify", "finalise"]);
        expect(mocks.agent).toHaveBeenCalledTimes(2);
        expect(mocks.agents[1].transport).not.toBe(mocks.agents[0].transport);
        expect(mocks.agents[1].key).toBe(mocks.agents[0].key);
        const key = mocks.agents[0].key as ECDSAKeyIdentity;
        expect(mocks.agent.mock.calls[0].slice(1)).toEqual([
            identity,
            "https://icp-api.io",
            false,
            true,
        ]);
        expect(mocks.agent.mock.calls[1].slice(1)).toEqual([
            identity,
            "https://icp-api.io",
            false,
            true,
        ]);
        expect(mocks.finalise.mock.calls[0][2]).toBe(key);
        expect(mocks.finalise.mock.calls[0][3]).toBe(syntheticCredential);
        expect(localSubmissions()).toHaveLength(0); // Linking never implicitly signs in the APK.
        expect(button("start-link").disabled).toBe(true);
        button("create-passkey").dispatchEvent(new Event("click"));
        expect(mocks.finalise).toHaveBeenCalledOnce();
        await expect(
            mocks.agents[1].transport(`https://icp-api.io/api/v3/canister/${identity}/call`, {
                method: "POST",
            }),
        ).rejects.toThrow("automatic resubmission");
        expect(operations()).toEqual(["verify", "finalise"]);
    });

    it.each(["expiry", "pagehide"])(
        "cancels pending creation on %s and never finalizes a late provider result",
        async (reason) => {
            const pending = deferred<typeof syntheticCredential>();
            mocks.createPasskey.mockReturnValue(pending.promise);
            await mount();
            await verifyCode();
            confirmCreation();
            await vi.waitFor(() => expect(mocks.createPasskey).toHaveBeenCalledOnce());
            const signal = mocks.createPasskey.mock.calls[0][2] as AbortSignal;
            expect(signal.aborted).toBe(false);
            if (reason === "expiry")
                await vi.advanceTimersByTimeAsync(challenge.expiresAtMs - Date.now());
            else window.dispatchEvent(new Event("pagehide"));
            expect(signal.aborted).toBe(true);
            // A provider can race cancellation; post-create finalization checks must remain.
            pending.resolve(syntheticCredential);
            await vi.advanceTimersByTimeAsync(0);
            expect(operations()).toEqual(["verify"]);
            expect(mocks.finalise).not.toHaveBeenCalled();
            expect(mocks.signer).not.toHaveBeenCalled();
            expect(mocks.createPasskey).toHaveBeenCalledOnce();
            expect(localSubmissions()).toHaveLength(0);
            expect(text("link-status")).not.toContain("Passkey linked");
            if (reason === "expiry") {
                expect(text("status")).toContain("No account-link finalization was requested");
                expect(button("create-passkey").disabled).toBe(true);
            }
        },
    );

    it("rejects a code for a different account without creating a passkey", async () => {
        mocks.network.mockResolvedValue(
            new Response(JSON.stringify({ kind: "success", username: "other-user" })),
        );
        await mount();
        button("start-link").click();
        input("code").value = "ABC234";
        button("verify-code").click();
        await vi.waitFor(() => expect(text("link-status")).toContain("did not match"));
        expect(mocks.createPasskey).not.toHaveBeenCalled();
        expect(mocks.finalise).not.toHaveBeenCalled();
        expect(button("create-passkey").disabled).toBe(true);
    });

    it("reports uncertainty, not unchanged links, when the request expires after finalization was submitted", async () => {
        const pending = deferred<Response>();
        mocks.network.mockImplementation(async (_url, init) =>
            JSON.parse(init.body).operation === "finalise"
                ? pending.promise
                : new Response(JSON.stringify({ kind: "success", username: "synthetic-user" })),
        );
        await mount();
        await verifyCode();
        confirmCreation();
        await vi.waitFor(() => expect(operations()).toEqual(["verify", "finalise"]));
        await vi.advanceTimersByTimeAsync(challenge.expiresAtMs - Date.now());
        expect(text("status")).toContain("Account linking may have completed");
        expect(text("status")).not.toContain("unchanged");
        expect(button("start-link").disabled).toBe(true);
        pending.resolve(new Response("{}"));
        await vi.advanceTimersByTimeAsync(0);
        expect(text("status")).toContain("Account linking may have completed");
        expect(text("link-status")).not.toContain("Passkey linked");
        expect(mocks.finalise).toHaveBeenCalledOnce();
        expect(localSubmissions()).toHaveLength(0);
    });

    it("does not offer to repeat uncertain finalization or automatically submit a sign-in", async () => {
        mocks.network.mockImplementation(async (_url, init) => {
            if (JSON.parse(init.body).operation === "finalise")
                throw new Error("Synthetic lost response");
            return new Response(JSON.stringify({ kind: "success", username: "synthetic-user" }));
        });
        await mount();
        await verifyCode();
        confirmCreation();
        await vi.waitFor(() => expect(text("link-status")).toContain("Linking may have succeeded"));
        expect(button("start-link").disabled).toBe(true);
        expect(button("sign-in").disabled).toBe(false);
        expect(mocks.signer).not.toHaveBeenCalled();
        expect(localSubmissions()).toHaveLength(0);
        button("create-passkey").dispatchEvent(new Event("click"));
        expect(mocks.finalise).toHaveBeenCalledOnce();
    });

    it("submits exactly once only after an explicit existing-passkey click and passes cancellation to lookup", async () => {
        await mount();
        button("sign-in").click();
        await vi.waitFor(() =>
            expect(text("status")).toContain("Response submitted, not yet verified"),
        );
        expect(mocks.signer).toHaveBeenCalledOnce();
        expect(localSubmissions()).toHaveLength(1);
        expect(mocks.lookup.mock.calls[0].slice(0, 3)).toEqual([
            identity,
            "https://icp-api.io",
            credentialId,
        ]);
        const signal = mocks.lookup.mock.calls[0][3] as AbortSignal;
        expect(signal.aborted).toBe(false);
        expect(mocks.signer.mock.calls[0][3]).toBe(signal);
        expect(mocks.agent).not.toHaveBeenCalled();
        expect(mocks.createPasskey).not.toHaveBeenCalled();
        button("sign-in").dispatchEvent(new Event("click"));
        expect(mocks.signer).toHaveBeenCalledOnce();
        expect(localSubmissions()).toHaveLength(1);
        window.dispatchEvent(new Event("pagehide"));
        expect(signal.aborted).toBe(true);
    });

    it("never submits a late signer result after the page has been closed", async () => {
        const pending = deferred<unknown>();
        mocks.signer.mockReturnValue(pending.promise);
        await mount();
        button("sign-in").click();
        expect(mocks.signer).toHaveBeenCalledOnce();
        window.dispatchEvent(new Event("pagehide"));
        pending.resolve({ synthetic: true });
        await vi.waitFor(() => expect(text("status")).toContain("could not finish"));
        expect(localSubmissions()).toHaveLength(0);
    });
});
