import { WebAuthnIdentity } from "@icp-sdk/core/identity";
import type { WebAuthnKeyFull } from "@shared";
import { authDataToCose } from "./webAuthn";
import { browserPasskeyContext } from "./browserPasskey";
import { browserSignInFailureMessage } from "./browserSignInDiagnostics";

export type BrowserAccountLinkState = {
    stage:
        | "idle"
        | "verifying"
        | "verified"
        | "linking"
        | "linked"
        | "error"
        | "uncertain"
        | "cancelled";
    message: string;
    username?: string;
    canStartFresh: boolean;
};

type Adapter = {
    verify(code: string): Promise<string>;
    createPasskey(username: string): Promise<WebAuthnKeyFull>;
    finalize(key: WebAuthnKeyFull): Promise<void>;
    forget(): void;
};

export type BrowserSignInExpectation = { username: string; credentialId: Uint8Array };

export class BrowserAccountLinkFlow {
    #state: BrowserAccountLinkState = {
        stage: "idle",
        message: "Nothing has been sent.",
        canStartFresh: false,
    };
    #used = false;
    #busy = false;
    #cancelled = false;
    #verified = false;
    #finalized = false;
    #credential?: WebAuthnKeyFull;

    constructor(
        private adapter: Adapter,
        private onChange: (state: BrowserAccountLinkState) => void = () => {},
    ) {}

    get state(): BrowserAccountLinkState {
        return { ...this.#state };
    }

    signInExpectation(): BrowserSignInExpectation | undefined {
        return this.#credential && this.#state.username
            ? {
                  username: this.#state.username,
                  credentialId: this.#credential.credentialId.slice(),
              }
            : undefined;
    }

    #set(state: BrowserAccountLinkState) {
        this.#state = state;
        try {
            this.onChange(this.state);
        } catch {
            /* Rendering cannot alter the protocol. */
        }
    }

    async verify(rawCode: string, expectedUsername: string): Promise<void> {
        if (this.#busy || this.#used || this.#cancelled) return;
        const username = expectedUsername.trim();
        const code = rawCode
            .replace(/[\s\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069-]/g, "")
            .toUpperCase();
        if (!username || username.length > 100 || !/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/.test(code)) {
            this.#set({
                stage: "error",
                message:
                    "Enter your existing username and the complete six-character official account-linking code. Nothing was sent.",
                canStartFresh: false,
            });
            return;
        }
        this.#used = this.#busy = true;
        this.#set({
            stage: "verifying",
            message: "Verifying this one-time code. No passkey has been created.",
            canStartFresh: false,
        });
        try {
            const verifiedUsername = await this.adapter.verify(code);
            if (this.#cancelled) return;
            if (verifiedUsername !== username) {
                this.adapter.forget();
                this.#set({
                    stage: "error",
                    message:
                        "The verified username did not match. No passkey was created and no account was linked. Generate a fresh code for the intended account.",
                    canStartFresh: true,
                });
                return;
            }
            this.#verified = true;
            this.#set({
                stage: "verified",
                username,
                message:
                    "Username verified. Review it, then explicitly confirm adding a passkey for this client.",
                canStartFresh: false,
            });
        } catch {
            this.adapter.forget();
            if (!this.#cancelled)
                this.#set({
                    stage: "error",
                    message:
                        "Code verification failed or its outcome is unknown. Do not reuse this code; generate a fresh official linking code.",
                    canStartFresh: true,
                });
        } finally {
            this.#busy = false;
        }
    }

    async complete(): Promise<void> {
        if (this.#busy || !this.#verified || this.#cancelled || this.#finalized) return;
        this.#busy = true;
        this.#verified = false;
        const username = this.#state.username!;
        this.#set({
            stage: "linking",
            username,
            message:
                "Creating a browser passkey, then linking it to the verified existing account.",
            canStartFresh: false,
        });
        try {
            const credential = await this.adapter.createPasskey(username);
            if (this.#cancelled) return;
            this.#credential = credential;
            this.#finalized = true;
            await this.adapter.finalize(credential);
            if (!this.#cancelled)
                this.#set({
                    stage: "linked",
                    username,
                    message: "Passkey linked. Sign in with it now to open your existing account.",
                    canStartFresh: false,
                });
        } catch {
            if (!this.#cancelled)
                this.#set({
                    stage: this.#finalized ? "uncertain" : "error",
                    username,
                    message: this.#finalized
                        ? "Linking may have succeeded. Do not repeat linking. Use fresh passkey sign-in to check this account."
                        : "Passkey creation failed or was cancelled. No account-link finalization was requested. Use a fresh code if you choose to try again.",
                    canStartFresh: !this.#finalized,
                });
        } finally {
            this.#busy = false;
            this.adapter.forget();
        }
    }

    cancel(): void {
        this.#cancelled = true;
        this.#verified = false;
        this.adapter.forget();
    }
}

const base64url = (value: Uint8Array) =>
    btoa(String.fromCharCode(...value))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

/** The explicit unofficial-client link flow creates one discoverable, user-verified browser key. */
export async function createBrowserLinkPasskey(
    rpId: string,
    username: string,
): Promise<WebAuthnKeyFull> {
    const context = browserPasskeyContext(rpId);
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const result = (await navigator.credentials.create({
        publicKey: {
            challenge,
            rp: { id: rpId, name: "Unofficial OpenChat client" },
            user: {
                id: crypto.getRandomValues(new Uint8Array(32)),
                name: `${username} - unofficial OpenChat`,
                displayName: `${username} (unofficial client)`,
            },
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
            authenticatorSelection: { residentKey: "required", userVerification: "required" },
            attestation: "none",
            timeout: 120_000,
        },
    })) as PublicKeyCredential | null;
    if (!result || result.type !== "public-key") throw new Error("Passkey creation cancelled");
    const credentialId = new Uint8Array(result.rawId);
    const response = result.response as AuthenticatorAttestationResponse;
    const clientDataBytes = new Uint8Array(response.clientDataJSON);
    const authData = new Uint8Array(response.getAuthenticatorData());
    if (
        !credentialId.length ||
        credentialId.length > 4096 ||
        !clientDataBytes.length ||
        clientDataBytes.length > 65536 ||
        authData.length < 55 ||
        authData.length > 65536
    )
        throw new Error("Invalid passkey response");
    const clientData = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(clientDataBytes),
    );
    const rpHash = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId)),
    );
    const idLength = new DataView(
        authData.buffer,
        authData.byteOffset,
        authData.byteLength,
    ).getUint16(53);
    if (
        clientData.type !== "webauthn.create" ||
        clientData.origin !== context.origin ||
        clientData.challenge !== base64url(challenge) ||
        (clientData.crossOrigin !== undefined && clientData.crossOrigin !== false) ||
        (authData[32] & 0x45) !== 0x45 ||
        !rpHash.every((value, index) => authData[index] === value) ||
        idLength !== credentialId.length ||
        !credentialId.every((value, index) => authData[55 + index] === value)
    ) {
        throw new Error("Invalid passkey creation binding");
    }
    const identity = new WebAuthnIdentity(credentialId, authDataToCose(authData), undefined);
    return {
        credentialId,
        publicKey: new Uint8Array(identity.getPublicKey().toDer()),
        origin: rpId,
        aaguid: authData.slice(37, 53),
        crossPlatform: result.authenticatorAttachment === "cross-platform",
    };
}

export function browserSignInError(error: unknown): string {
    const diagnostic = browserSignInFailureMessage(error);
    if (diagnostic !== undefined) return diagnostic;
    if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "existing_account_required"
    ) {
        return "This passkey could not open the expected existing account. If this client is not linked yet, use the explicit account-linking option below.";
    }
    // DOMException may not inherit this realm's Error (for example, WebView/picker boundaries).
    const name = typeof error === "object" && error !== null && "name" in error ? error.name : "";
    if (name === "NotAllowedError" || name === "AbortError")
        return "Passkey sign-in was cancelled or did not finish. You can try the existing passkey again; no account link was changed.";
    if (name === "SecurityError")
        return "The browser rejected this client's passkey origin. No account link was changed.";
    return "Passkey sign-in could not finish. No new account was created. Try your existing passkey again, or explicitly link this client if needed.";
}
