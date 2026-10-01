import type { EncryptedLocalAppDeliveryRequest } from "./localAppEncryption";

const localAppBase64Url = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");

/** Structural transport fixture ONLY; real cryptography is tested separately without mocks. */
export function encryptedRequestFixture(
    overrides: Partial<EncryptedLocalAppDeliveryRequest> = {},
): EncryptedLocalAppDeliveryRequest {
    return {
        appId: "example",
        appRevision: "local-import-v2",
        actionId: "record",
        destination: "https://app.example/import",
        idempotencyKey: "B".repeat(42) + "A",
        envelope: {
            version: 1,
            scheme: "p256-hkdf-sha256-aes-256-gcm-v1",
            keyId: "a".repeat(64),
            recipientContext: "Y29udGV4dA",
            ephemeralPublicKey: localAppBase64Url(new Uint8Array([4, ...new Uint8Array(64)])),
            salt: localAppBase64Url(new Uint8Array(32)),
            iv: localAppBase64Url(new Uint8Array(12)),
            ciphertext: localAppBase64Url(new Uint8Array(48)),
        },
        ...overrides,
    };
}
