import { snapshotLocalDraftJson, type LocalDraftDeliveryRequest } from "./localAppDrafts";

export const LOCAL_APP_ENCRYPTION_SCHEME = "p256-hkdf-sha256-aes-256-gcm-v1";
export const LOCAL_APP_ENCRYPTION_DOMAIN = "openchat/private-app/handoff/v1";
export const MAX_ENCRYPTED_REQUEST_BYTES = 112 * 1024;
export interface LocalAppDeliveryEncryption {
    readonly version: 1;
    readonly scheme: typeof LOCAL_APP_ENCRYPTION_SCHEME;
    readonly keyId: string;
    readonly publicKeySpki: string;
    readonly recipientContext: string;
}
export interface LocalAppEncryptedEnvelope {
    readonly version: 1;
    readonly scheme: typeof LOCAL_APP_ENCRYPTION_SCHEME;
    readonly keyId: string;
    readonly recipientContext: string;
    readonly ephemeralPublicKey: string;
    readonly salt: string;
    readonly iv: string;
    readonly ciphertext: string;
}
/** This is the ONLY request permitted across relay/native/app transport boundaries. */
export interface EncryptedLocalAppDeliveryRequest {
    readonly appId: string;
    readonly appRevision: string;
    readonly actionId: string;
    readonly destination: string;
    readonly idempotencyKey: string;
    readonly envelope: LocalAppEncryptedEnvelope;
}
function invalid(): never {
    throw new Error(
        "Encrypted app connection is missing or invalid. Reconnect the app before sending.",
    );
}
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
    if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(value, key))
    )
        invalid();
}
export function localAppBase64Url(bytes: Uint8Array): string {
    let raw = "";
    for (const byte of bytes) raw += String.fromCharCode(byte);
    return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function localAppDecodeBase64Url(
    value: unknown,
    minimum: number,
    maximum = minimum,
): Uint8Array<ArrayBuffer> {
    if (
        typeof value !== "string" ||
        !/^[A-Za-z0-9_-]+$/.test(value) ||
        value.length > Math.ceil((maximum * 4) / 3)
    )
        invalid();
    let raw: string;
    try {
        raw = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    } catch {
        return invalid();
    }
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    if (bytes.length < minimum || bytes.length > maximum || localAppBase64Url(bytes) !== value)
        invalid();
    return bytes;
}
function identity(value: unknown, maximum: number): asserts value is string {
    if (
        typeof value !== "string" ||
        !value.trim() ||
        value.length > maximum ||
        /[\p{Cc}\p{Cf}]/u.test(value)
    )
        invalid();
}
export function validateLocalAppDeliveryEncryption(value: unknown): LocalAppDeliveryEncryption {
    exact(value, ["version", "scheme", "keyId", "publicKeySpki", "recipientContext"]);
    if (
        value.version !== 1 ||
        value.scheme !== LOCAL_APP_ENCRYPTION_SCHEME ||
        typeof value.keyId !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.keyId)
    )
        invalid();
    localAppDecodeBase64Url(value.publicKeySpki, 91);
    localAppDecodeBase64Url(value.recipientContext, 1, 1536);
    return Object.freeze({ ...value }) as unknown as LocalAppDeliveryEncryption;
}
export function validateEncryptedLocalAppDeliveryRequest(
    value: unknown,
): EncryptedLocalAppDeliveryRequest {
    exact(value, ["appId", "appRevision", "actionId", "destination", "idempotencyKey", "envelope"]);
    for (const field of ["appId", "appRevision", "actionId"]) identity(value[field], 128);
    identity(value.destination, 2048);
    if (
        typeof value.idempotencyKey !== "string" ||
        !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value.idempotencyKey)
    )
        invalid();
    const url = new URL(value.destination);
    if (
        url.href !== value.destination ||
        url.username ||
        url.password ||
        url.hash ||
        (url.protocol !== "https:" &&
            !(
                url.protocol === "http:" &&
                ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
            ))
    )
        invalid();
    const envelope = value.envelope;
    exact(envelope, [
        "version",
        "scheme",
        "keyId",
        "recipientContext",
        "ephemeralPublicKey",
        "salt",
        "iv",
        "ciphertext",
    ]);
    if (
        envelope.version !== 1 ||
        envelope.scheme !== LOCAL_APP_ENCRYPTION_SCHEME ||
        typeof envelope.keyId !== "string" ||
        !/^[a-f0-9]{64}$/.test(envelope.keyId)
    )
        invalid();
    localAppDecodeBase64Url(envelope.recipientContext, 1, 1536);
    if (localAppDecodeBase64Url(envelope.ephemeralPublicKey, 65)[0] !== 4) invalid();
    localAppDecodeBase64Url(envelope.salt, 32);
    localAppDecodeBase64Url(envelope.iv, 12);
    localAppDecodeBase64Url(envelope.ciphertext, 17, 65552);
    if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_ENCRYPTED_REQUEST_BYTES)
        invalid();
    return Object.freeze({
        ...value,
        envelope: Object.freeze({ ...envelope }),
    }) as unknown as EncryptedLocalAppDeliveryRequest;
}
export function localAppEncryptionAad(
    request: Pick<
        EncryptedLocalAppDeliveryRequest,
        "appId" | "appRevision" | "actionId" | "destination" | "idempotencyKey"
    >,
    keyId: string,
    recipientContext: string,
): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(
        JSON.stringify([
            LOCAL_APP_ENCRYPTION_DOMAIN,
            request.appId,
            request.appRevision,
            request.actionId,
            request.destination,
            request.idempotencyKey,
            keyId,
            recipientContext,
        ]),
    );
}
/** Runs in the originating OpenChat client BEFORE BroadcastChannel, IPC, loopback or postMessage.
 * Recipient setup is pinned by explicit Connect; neither models nor processors supply these keys.
 * Ciphertext is recipient-confidential, not proof of sender identity or backend attestation.
 */
export async function sealLocalAppDelivery(
    request: LocalDraftDeliveryRequest,
    signal?: AbortSignal,
): Promise<EncryptedLocalAppDeliveryRequest> {
    signal?.throwIfAborted();
    const binding = validateLocalAppDeliveryEncryption(request.deliveryEncryption);
    const plaintext = new TextEncoder().encode(
        JSON.stringify(snapshotLocalDraftJson(request.payload)),
    );
    try {
        const spki = localAppDecodeBase64Url(binding.publicKeySpki, 91);
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", spki));
        if (
            Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("") !==
            binding.keyId
        )
            invalid();
        const recipient = await crypto.subtle.importKey(
            "spki",
            spki,
            { name: "ECDH", namedCurve: "P-256" },
            false,
            [],
        );
        const ephemeral = await crypto.subtle.generateKey(
            { name: "ECDH", namedCurve: "P-256" },
            false,
            ["deriveBits"],
        );
        const secret = new Uint8Array(
            await crypto.subtle.deriveBits(
                { name: "ECDH", public: recipient },
                ephemeral.privateKey,
                256,
            ),
        );
        const salt = crypto.getRandomValues(new Uint8Array(32));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const hkdf = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
        secret.fill(0);
        const key = await crypto.subtle.deriveKey(
            {
                name: "HKDF",
                hash: "SHA-256",
                salt,
                info: new TextEncoder().encode(LOCAL_APP_ENCRYPTION_DOMAIN),
            },
            hkdf,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt"],
        );
        if (!request.appRevision) invalid();
        const header = {
            appId: request.appId,
            appRevision: request.appRevision,
            actionId: request.actionId,
            destination: request.destination,
            idempotencyKey: request.idempotencyKey,
        };
        const ciphertext = await crypto.subtle.encrypt(
            {
                name: "AES-GCM",
                iv,
                tagLength: 128,
                additionalData: localAppEncryptionAad(
                    header,
                    binding.keyId,
                    binding.recipientContext,
                ),
            },
            key,
            plaintext,
        );
        const raw = await crypto.subtle.exportKey("raw", ephemeral.publicKey);
        signal?.throwIfAborted();
        return validateEncryptedLocalAppDeliveryRequest({
            ...header,
            envelope: {
                version: 1,
                scheme: LOCAL_APP_ENCRYPTION_SCHEME,
                keyId: binding.keyId,
                recipientContext: binding.recipientContext,
                ephemeralPublicKey: localAppBase64Url(new Uint8Array(raw)),
                salt: localAppBase64Url(salt),
                iv: localAppBase64Url(iv),
                ciphertext: localAppBase64Url(new Uint8Array(ciphertext)),
            },
        });
    } catch {
        return invalid();
    } finally {
        plaintext.fill(0);
    }
}
