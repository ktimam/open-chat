import { Cbor, type Signature } from "@icp-sdk/core/agent";
import { WebAuthnIdentity } from "@icp-sdk/core/identity";

const equal = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((value, index) => value === b[index]);

function boundedBytes(value: unknown, maximum: number): Uint8Array<ArrayBuffer> {
    const view = value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : ArrayBuffer.isView(value)
            ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
            : undefined;
    if (view === undefined || view.length === 0 || view.length > maximum) {
        throw new Error("Invalid passkey response");
    }
    return new Uint8Array(view);
}

function base64url(value: Uint8Array): string {
    return btoa(String.fromCharCode(...value))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function browserPasskeyContext(configuredRpId: string | undefined): { rpId: string; origin: string } {
    const origin = new URL(globalThis.location.origin);
    const rpId = configuredRpId ?? origin.hostname;
    if (
        (origin.protocol !== "https:" && !(origin.protocol === "http:" && origin.hostname === "localhost")) ||
        !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(rpId) ||
        rpId.includes("..") ||
        (origin.hostname !== rpId && !origin.hostname.endsWith(`.${rpId}`))
    ) {
        throw new Error("Passkey relying party does not match this client");
    }
    return { rpId, origin: origin.origin };
}

function assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException("Sign-in cancelled", "AbortError");
}

/**
 * Discover an existing browser credential without an allowCredentials filter. Keep the exact IC
 * challenge and reject another credential on reauthentication. These structural checks complement,
 * never replace, the IC's cryptographic verification of the unmodified assertion and delegation.
 */
export async function requestBrowserPasskeyAssertion(
    configuredRpId: string | undefined,
    blob: Uint8Array,
    expectedCredentialId?: Uint8Array,
    signal?: AbortSignal,
): Promise<{ credentialId: Uint8Array; signature: Signature }> {
    const { rpId, origin } = browserPasskeyContext(configuredRpId);
    const challenge = boundedBytes(blob, 4096);
    const expectedId = expectedCredentialId === undefined
        ? undefined
        : boundedBytes(expectedCredentialId, 4096);
    assertNotAborted(signal);
    // Invoke before the first await so the user gesture reaches the native picker.
    const result = await navigator.credentials.get({
        signal,
        publicKey: { rpId, challenge: challenge.slice(), userVerification: "preferred", timeout: 60_000 },
    }) as PublicKeyCredential | null;
    assertNotAborted(signal);
    if (result === null || result.type !== "public-key") throw new Error("Invalid passkey response");
    const credentialId = boundedBytes(result.rawId, 4096);
    if (expectedId !== undefined && !equal(credentialId, expectedId)) {
        throw new Error("Choose the passkey for the account being reauthenticated");
    }
    const response = result.response as AuthenticatorAssertionResponse;
    const clientDataJson = new TextDecoder("utf-8", { fatal: true }).decode(
        boundedBytes(response.clientDataJSON, 65536),
    );
    const clientData = JSON.parse(clientDataJson);
    const authenticatorData = boundedBytes(response.authenticatorData, 65536);
    const signature = boundedBytes(response.signature, 1024);
    const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId)));
    if (
        clientData.type !== "webauthn.get" || clientData.origin !== origin ||
        clientData.challenge !== base64url(challenge) ||
        (clientData.crossOrigin !== undefined && clientData.crossOrigin !== false) ||
        authenticatorData.length < 37 || !(authenticatorData[32] & 1) ||
        !equal(authenticatorData.slice(0, 32), rpHash)
    ) {
        throw new Error("Invalid passkey assertion");
    }
    assertNotAborted(signal);
    return {
        credentialId,
        signature: Cbor.encode({
            authenticator_data: authenticatorData,
            client_data_json: clientDataJson,
            signature,
        }) as Signature,
    };
}

export class PickerWebAuthnIdentity extends WebAuthnIdentity {
    readonly #credentialId: Uint8Array;

    constructor(
        readonly rpId: string | undefined,
        credentialId: Uint8Array,
        cose: Uint8Array,
        readonly signal?: AbortSignal,
    ) {
        const id = boundedBytes(credentialId, 4096);
        super(id, boundedBytes(cose, 65536), undefined);
        this.#credentialId = id;
    }

    override async sign(blob: Uint8Array): Promise<Signature> {
        return (await requestBrowserPasskeyAssertion(this.rpId, blob, this.#credentialId, this.signal)).signature;
    }
}
