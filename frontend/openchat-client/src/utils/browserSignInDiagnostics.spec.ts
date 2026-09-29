import { describe, expect, it, vi } from "vitest";
import {
    BrowserSignInFailure,
    browserSignInFailureMessage,
    browserSignInStep,
} from "./browserSignInDiagnostics";

describe("credential-safe sign-in diagnostics", () => {
    it("invokes an operation synchronously and distinguishes request failure from validation", async () => {
        const operation = vi.fn(() => Promise.resolve("synthetic-result"));
        const pending = browserSignInStep("passkey-request", operation);
        expect(operation).toHaveBeenCalledOnce();
        await expect(pending).resolves.toBe("synthetic-result");
        expect(browserSignInFailureMessage(new BrowserSignInFailure("passkey-request"))).toContain(
            "The browser did not return a passkey assertion.",
        );
        expect(browserSignInFailureMessage(new BrowserSignInFailure("passkey"))).toContain(
            "The passkey response could not be validated.",
        );
    });

    it.each(["UnknownError", "NotSupportedError", "synthetic-sensitive-name"])(
        "replaces an unclassified request error without retaining its name or details: %s",
        async (name) => {
            const error = Object.assign(
                new Error("synthetic-sensitive-message", {
                    cause: { assertion: "synthetic-sensitive-assertion" },
                }),
                { name },
            );
            let failure: unknown;
            try {
                await browserSignInStep("passkey", () =>
                    browserSignInStep("passkey-request", () => {
                        throw error;
                    }),
                );
            } catch (caught) {
                failure = caught;
            }
            expect(failure).toBeInstanceOf(BrowserSignInFailure);
            expect(browserSignInFailureMessage(failure)).toContain("[SIGNIN/passkey-request]");
            expect((failure as Error).cause).toBeUndefined();
            expect(JSON.stringify(failure)).not.toContain(name);
            expect(JSON.stringify(failure)).not.toContain("synthetic-sensitive");
            expect((failure as Error).message).not.toContain("synthetic-sensitive");
        },
    );

    it("retains the innermost stage and never retains raw SDK payloads", async () => {
        let failure: unknown;
        try {
            await browserSignInStep("passkey", () =>
                browserSignInStep("public-key", async () => {
                    throw new Error("synthetic-sensitive-assertion-and-session");
                }),
            );
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeInstanceOf(BrowserSignInFailure);
        expect(browserSignInFailureMessage(failure)).toContain("[SIGNIN/public-key]");
        expect(JSON.stringify(failure)).not.toContain("synthetic-sensitive");
        expect((failure as Error).cause).toBeUndefined();
        expect((failure as Error).message).not.toContain("synthetic-sensitive");
    });

    it("preserves classified cancellation, origin and unknown-account errors", async () => {
        for (const error of [
            new DOMException("sensitive", "AbortError"),
            new DOMException("sensitive", "NotAllowedError"),
            new DOMException("sensitive", "SecurityError"),
            { code: "existing_account_required" },
        ]) {
            for (const stage of ["passkey", "passkey-request"] as const) {
                await expect(
                    browserSignInStep(stage, async () => {
                        throw error;
                    }),
                ).rejects.toBe(error);
            }
        }
    });

    it("does not accept arbitrary diagnostic strings or retain successful data", async () => {
        expect(browserSignInFailureMessage({ stage: "untrusted" })).toBeUndefined();
        expect(await browserSignInStep("account-profile", async () => "synthetic-result")).toBe(
            "synthetic-result",
        );
        expect(browserSignInFailureMessage(new Error("synthetic-secret"))).toBeUndefined();
    });
});
