import { AndroidWebAuthnErrorCode } from "tauri-plugin-oc-api";
import { describe, expect, it } from "vitest";
import { classifyAndroidWebAuthnSignInFailure } from "./androidWebAuthnError";

describe("classifyAndroidWebAuthnSignInFailure", () => {
    it("keeps user cancellation on the sign-in screen", () => {
        expect(
            classifyAndroidWebAuthnSignInFailure({
                code: AndroidWebAuthnErrorCode.CommonUserCancelled,
            }),
        ).toEqual({ kind: "cancelled" });
    });

    it("only routes a genuine no-passkey response to account linking", () => {
        expect(
            classifyAndroidWebAuthnSignInFailure({
                code: AndroidWebAuthnErrorCode.AuthNoPasskey,
            }),
        ).toEqual({
            kind: "link_account",
            errorCode: AndroidWebAuthnErrorCode.AuthNoPasskey,
        });
    });

    it("preserves all other known native error codes", () => {
        expect(
            classifyAndroidWebAuthnSignInFailure({
                code: AndroidWebAuthnErrorCode.CommonSecurityDenied,
            }),
        ).toEqual({
            kind: "error",
            errorCode: AndroidWebAuthnErrorCode.CommonSecurityDenied,
        });
    });

    it("fails unknown errors to the generic message instead of account linking", () => {
        expect(classifyAndroidWebAuthnSignInFailure(new Error("unknown"))).toEqual({
            kind: "error",
            errorCode: "default",
        });
        expect(
            classifyAndroidWebAuthnSignInFailure({
                code: AndroidWebAuthnErrorCode.JsonAuthDataError,
            }),
        ).toEqual({
            kind: "error",
            errorCode: "default",
        });
    });
});
