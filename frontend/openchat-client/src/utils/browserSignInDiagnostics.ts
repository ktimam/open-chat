/** Fixed diagnostic labels only: never retain an SDK exception, assertion, code or identity. */
export type BrowserSignInStage =
    | "passkey-request"
    | "passkey"
    | "public-key"
    | "account-delegation"
    | "account-profile"
    | "session-storage";

export class BrowserSignInFailure extends Error {
    readonly code = "browser_signin_failed";
    constructor(readonly stage: BrowserSignInStage) {
        super(`Existing-account sign-in failed at ${stage}`);
        this.name = "BrowserSignInFailure";
    }
}

export async function browserSignInStep<T>(
    stage: BrowserSignInStage,
    operation: () => Promise<T>,
): Promise<T> {
    // Invoke synchronously, before any await, so this wrapper does not defer a browser picker.
    try {
        return await operation();
    } catch (error) {
        // Keep narrowly classified errors without copying their messages into UI diagnostics.
        if (
            error instanceof BrowserSignInFailure ||
            (typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === "existing_account_required") ||
            (typeof error === "object" &&
                error !== null &&
                "name" in error &&
                typeof error.name === "string" &&
                ["NotAllowedError", "AbortError", "SecurityError"].includes(error.name))
        )
            throw error;
        throw new BrowserSignInFailure(stage);
    }
}

export function browserSignInFailureMessage(error: unknown): string | undefined {
    if (!(error instanceof BrowserSignInFailure)) return undefined;
    const messages: Record<BrowserSignInStage, string> = {
        "passkey-request": "The browser did not return a passkey assertion.",
        passkey: "The passkey response could not be validated.",
        "public-key":
            "The passkey was returned, but its registered public key could not be loaded.",
        "account-delegation":
            "The passkey was returned, but OpenChat could not establish the existing-account session.",
        "account-profile":
            "The session was established, but the existing OpenChat account could not be loaded.",
        "session-storage": "The verified session could not be stored on this device.",
    };
    return `${messages[error.stage]} No new account was created. [SIGNIN/${error.stage}]`;
}
