// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createLocalAppHandoffSession } from "./localAppHandoff";
import {
    localAppBase64Url,
    localAppDecodeBase64Url,
    localAppEncryptionAad,
    sealLocalAppDelivery,
    validateEncryptedLocalAppDeliveryRequest,
    LOCAL_APP_ENCRYPTION_DOMAIN,
    type EncryptedLocalAppDeliveryRequest,
} from "./localAppEncryption";
import { encryptedRequestFixture } from "./localAppEncryption.testFixtures";
import type { LocalDraftDeliveryRequest } from "./localAppDrafts";

async function fixture() {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
        "deriveBits",
    ]);
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
    const keyId = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", spki)), (b) =>
        b.toString(16).padStart(2, "0"),
    ).join("");
    const request: LocalDraftDeliveryRequest = {
        appId: "example",
        appRevision: "local-import-v2",
        actionId: "record",
        destination: "https://app.example/import",
        recipient: "PRIVATE LABEL",
        idempotencyKey: "A".repeat(43),
        deliveryEncryption: {
            version: 1,
            scheme: "p256-hkdf-sha256-aes-256-gcm-v1",
            keyId,
            publicKeySpki: localAppBase64Url(spki),
            recipientContext: "Y29udGV4dA",
        },
        payload: {
            amount: 12900,
            currency: "EGP",
            note: "PRIVATE_SYNTHETIC_NOTE",
            date: "2026-08-14",
        },
    };
    return { pair, request };
}
async function decrypt(wire: EncryptedLocalAppDeliveryRequest, privateKey: CryptoKey) {
    const e = wire.envelope;
    const ephemeral = await crypto.subtle.importKey(
        "raw",
        localAppDecodeBase64Url(e.ephemeralPublicKey, 65),
        { name: "ECDH", namedCurve: "P-256" },
        false,
        [],
    );
    const bits = await crypto.subtle.deriveBits(
        { name: "ECDH", public: ephemeral },
        privateKey,
        256,
    );
    const secret = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
        {
            name: "HKDF",
            hash: "SHA-256",
            salt: localAppDecodeBase64Url(e.salt, 32),
            info: new TextEncoder().encode(LOCAL_APP_ENCRYPTION_DOMAIN),
        },
        secret,
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"],
    );
    return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
            await crypto.subtle.decrypt(
                {
                    name: "AES-GCM",
                    iv: localAppDecodeBase64Url(e.iv, 12),
                    additionalData: localAppEncryptionAad(wire, e.keyId, e.recipientContext),
                    tagLength: 128,
                },
                key,
                localAppDecodeBase64Url(e.ciphertext, 17, 65552),
            ),
        ),
    );
}
describe("client-side private app encryption", () => {
    it("encrypts before the handoff boundary and only the linked recipient decrypts exact fields", async () => {
        const { pair, request } = await fixture();
        const wire = await sealLocalAppDelivery(request);
        const sent: unknown[] = [];
        const receiver = {};
        const session = createLocalAppHandoffSession({
            request: wire,
            receiver,
            sessionNonce: "A".repeat(43),
            send: (m) => sent.push(m),
            onOutcome: () => {},
        });
        session.start();
        session.receive({
            source: receiver,
            origin: "https://app.example",
            data: { type: "oc:app-import:ready", version: 2, sessionNonce: "A".repeat(43) },
        });
        expect(sent).toHaveLength(2);
        for (const marker of [
            "PRIVATE_SYNTHETIC_NOTE",
            "PRIVATE LABEL",
            "2026-08-14",
            "12900",
            '"payload"',
        ])
            expect(JSON.stringify(sent)).not.toContain(marker);
        expect(await decrypt(wire, pair.privateKey)).toEqual(request.payload);
        const wrong = await fixture();
        await expect(decrypt(wire, wrong.pair.privateKey)).rejects.toThrow();
    });
    it.each(["appId", "appRevision", "actionId", "destination", "idempotencyKey"] as const)(
        "authenticates %s against retargeting",
        async (field) => {
            const { pair, request } = await fixture();
            const wire = await sealLocalAppDelivery(request);
            await expect(
                decrypt({ ...wire, [field]: wire[field] + "changed" }, pair.privateKey),
            ).rejects.toThrow();
        },
    );
    it.each(["keyId", "recipientContext", "iv", "salt", "ciphertext"] as const)(
        "rejects tampered %s",
        async (field) => {
            const { pair, request } = await fixture();
            const wire = await sealLocalAppDelivery(request);
            const value = wire.envelope[field];
            const tampered = (value[0] === "A" ? "B" : "A") + value.slice(1);
            await expect(
                decrypt(
                    { ...wire, envelope: { ...wire.envelope, [field]: tampered } },
                    pair.privateKey,
                ),
            ).rejects.toThrow();
        },
    );
    it("fresh retries retain the import ID, not encryption nonces; no raw request is accepted", async () => {
        const { pair, request } = await fixture();
        const a = await sealLocalAppDelivery(request);
        const b = await sealLocalAppDelivery(request);
        expect(a.idempotencyKey).toBe(b.idempotencyKey);
        for (const field of ["ephemeralPublicKey", "salt", "iv", "ciphertext"] as const)
            expect(a.envelope[field]).not.toBe(b.envelope[field]);
        expect(await decrypt(b, pair.privateKey)).toEqual(request.payload);
        expect(() => validateEncryptedLocalAppDeliveryRequest(request)).toThrow();
        expect(() =>
            validateEncryptedLocalAppDeliveryRequest({ ...a, payload: request.payload }),
        ).toThrow();
    });
    it("fails closed on missing/mismatched keys, cancelled approval and oversized plaintext", async () => {
        const { request } = await fixture();
        await expect(
            sealLocalAppDelivery({ ...request, deliveryEncryption: undefined }),
        ).rejects.toThrow();
        await expect(
            sealLocalAppDelivery({
                ...request,
                deliveryEncryption: { ...request.deliveryEncryption!, keyId: "0".repeat(64) },
            }),
        ).rejects.toThrow();
        const abort = new AbortController();
        abort.abort();
        await expect(sealLocalAppDelivery(request, abort.signal)).rejects.toThrow();
        await expect(
            sealLocalAppDelivery({ ...request, payload: "a".repeat(65537) }),
        ).rejects.toThrow();
    });
    it("rejects malformed and noncanonical envelopes and insecure destinations", () => {
        const wire = encryptedRequestFixture();
        for (const patch of [
            { version: 2 },
            { iv: "a" },
            { salt: "=".repeat(43) },
            { ciphertext: "AA" },
            { scheme: "plaintext" },
        ])
            expect(() =>
                validateEncryptedLocalAppDeliveryRequest({
                    ...wire,
                    envelope: { ...wire.envelope, ...patch },
                }),
            ).toThrow();
        expect(() =>
            validateEncryptedLocalAppDeliveryRequest({
                ...wire,
                destination: "http://remote.example/import",
            }),
        ).toThrow();
    });
});
