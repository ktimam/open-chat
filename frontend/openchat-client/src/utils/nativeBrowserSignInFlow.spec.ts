// @vitest-environment node
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeBrowserAuthChallenge } from "./nativeBrowserAuth";
const mock = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("./nativeBrowserAuth", () => ({
    createNativeBrowserAuthVerifier: () => ({ verify: mock.verify }),
}));
import { runNativeBrowserSignIn } from "./nativeBrowserSignInFlow";

const now = 2_000_000_000_000;
function adapter() {
    const order: string[] = [];
    const session = { synthetic: true };
    const result = {
        begin: vi.fn(
            async (input: {
                sessionPublicKeyDerHex: string;
                expectedUsername: string;
            }): Promise<NativeBrowserAuthChallenge> => ({
                ...input,
                protocol: "openchat.local-browser-auth.v1",
                attemptId: "aa".repeat(16),
                nonce: "bb".repeat(32),
                identityCanister: "aaaaa-aa",
                identityTargetHex: "",
                origin: "http://localhost:40001",
                url: "http://localhost:40001/sign-in",
                expiresAtMs: now + 120_000,
                delegationExpiresAtMs: now + 300_000,
                clientLabel: "OpenChat Fork · Local Test",
            }),
        ),
        open: vi.fn(async () => {
            order.push("open");
        }),
        poll: vi.fn(async () => ({
            kind: "submitted" as const,
            candidate: {
                protocol: "openchat.local-browser-auth.v1" as const,
                attemptId: "aa".repeat(16),
                nonce: "bb".repeat(32),
                credentialIdHex: "0102",
                delegation: { publicKey: "03".repeat(91), delegations: [] },
            },
        })),
        cancel: vi.fn(async () => {
            order.push("cancel");
        }),
        complete: vi.fn(async () => {
            order.push("complete");
        }),
        lookup: vi.fn(async () => {
            order.push("lookup");
            return new Uint8Array(91).fill(3);
        }),
        prove: vi.fn(async () => {
            order.push("prove");
            return session;
        }),
        activate: vi.fn(async (_session: typeof session) => {
            order.push("activate");
        }),
    };
    return { result, order, session };
}
beforeEach(() => {
    vi.stubGlobal("crypto", webcrypto);
    vi.spyOn(Date, "now").mockReturnValue(now);
    mock.verify.mockResolvedValue({
        chain: {},
        credentialId: Uint8Array.of(1, 2),
        expectedUsername: "synthetic",
        authenticationExpiresAtMs: now + 300_000,
    });
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
    vi.unstubAllGlobals();
});

describe("native browser sign-in acceptance order", () => {
    it("activates only after local signature, fresh account proof and successful native completion", async () => {
        const { result, order, session } = adapter();
        await runNativeBrowserSignIn("synthetic", "aaaaa-aa", result, {
            onStatus() {
                throw new Error("view failure");
            },
        });
        expect(order).toEqual(["open", "lookup", "prove", "complete", "activate"]);
        expect(mock.verify).toHaveBeenCalledOnce();
        expect(result.complete).toHaveBeenCalledWith("aa".repeat(16), true);
        expect(result.activate.mock.calls[0][0]).toBe(session);
        expect(result.cancel).not.toHaveBeenCalled();
    });
    it.each(["lookup", "verify", "prove", "complete"])(
        "does not activate when %s fails",
        async (stage) => {
            const { result } = adapter();
            (stage === "verify"
                ? mock.verify
                : result[stage as "lookup" | "prove" | "complete"]
            ).mockRejectedValue(new Error("synthetic failure"));
            await expect(runNativeBrowserSignIn("synthetic", "aaaaa-aa", result)).rejects.toThrow();
            expect(result.activate).not.toHaveBeenCalled();
            expect(result.cancel).toHaveBeenCalledOnce();
        },
    );
    it("never activates a late account proof after cancellation", async () => {
        const { result } = adapter();
        const controller = new AbortController();
        result.prove.mockImplementation(async () => {
            controller.abort();
            return { synthetic: true };
        });
        await expect(
            runNativeBrowserSignIn("synthetic", "aaaaa-aa", result, { signal: controller.signal }),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(result.complete).not.toHaveBeenCalled();
        expect(result.activate).not.toHaveBeenCalled();
    });
    it("rejects a proof that finished after the transport deadline", async () => {
        const { result } = adapter();
        result.prove.mockImplementation(async () => {
            vi.mocked(Date.now).mockReturnValue(now + 120_001);
            return { synthetic: true };
        });
        await expect(runNativeBrowserSignIn("synthetic", "aaaaa-aa", result)).rejects.toThrow(
            "expired",
        );
        expect(result.complete).not.toHaveBeenCalled();
        expect(result.activate).not.toHaveBeenCalled();
    });
    it("rejects changed native key metadata before opening the browser", async () => {
        const { result } = adapter();
        const original = result.begin.getMockImplementation()!;
        result.begin.mockImplementation(async (input) => ({
            ...(await original(input)),
            sessionPublicKeyDerHex: "ff".repeat(91),
        }));
        await expect(runNativeBrowserSignIn("synthetic", "aaaaa-aa", result)).rejects.toThrow(
            "binding",
        );
        expect(result.open).not.toHaveBeenCalled();
        expect(result.lookup).not.toHaveBeenCalled();
    });
    it("rejects a malformed credential identifier before lookup", async () => {
        const { result } = adapter();
        const original = result.poll.getMockImplementation()!;
        result.poll.mockImplementation(async () => {
            const value = await original();
            value.candidate.credentialIdHex = "01".repeat(1025);
            return value;
        });
        await expect(runNativeBrowserSignIn("synthetic", "aaaaa-aa", result)).rejects.toThrow(
            "credential",
        );
        expect(result.lookup).not.toHaveBeenCalled();
    });
});
