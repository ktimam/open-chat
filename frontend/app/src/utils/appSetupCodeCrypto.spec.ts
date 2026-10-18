// @vitest-environment node
import { createCipheriv, createDecipheriv, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSetupCode, deriveSetupCode, encryptSetupCode, decryptSetupCode, SETUP_CODE_DOMAIN, SETUP_CODE_MAX_PLAINTEXT_BYTES, type SetupCodePurpose } from "./appSetupCodeCrypto";

// Public synthetic vector: code bytes 00..1f, IV bytes a0..ab. Node crypto independently generated these values.
const CODE = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const ID = "630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd";
const CLAIM = "f5f14261237fa6ed56615bdf45bdb7638b99b2f47da0a41ddc3acb9a9318fb1f";
const CLAIM_HASH = "099e7eb82d97e87ae149929f936be6ca8c2c9771082368f1518f45c795eeb6f6";
const VECTORS = {
    context: "a0a1a2a3a4a5a6a7a8a9aaab70704ebe9fd7da020859da8f474337e46d7624a5a65faf45ebad46f8487360eb021e19741a13",
    result: "a0a1a2a3a4a5a6a7a8a9aaab3ebca4f92107480bac43b6c30d58ab5ceb42e6d085cd6b90e0e7c39a101c6ec4685efde39354",
};
const bytes = (value: string) => Uint8Array.from(Buffer.from(value, "hex"));
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
const key = (purpose: SetupCodePurpose) => Buffer.from(hkdfSync("sha256", Buffer.from(CODE, "base64url"), SETUP_CODE_DOMAIN, purpose, 32));
const aad = (purpose: SetupCodePurpose) => Buffer.from(JSON.stringify([SETUP_CODE_DOMAIN, purpose, ID]));

describe("app setup code wire crypto", () => {
    it("matches independent locator, claim secret, and verifier vectors", async () => {
        const material = await deriveSetupCode(CODE);
        expect(material.code).toBe(CODE);
        expect(material.requestId).toBe(ID);
        expect(hex(material.claimSecret)).toBe(CLAIM);
        expect(hex(material.claimHash)).toBe(CLAIM_HASH);
        expect(await deriveSetupCode(CODE)).toEqual(material);
    });
    it("creates independent canonical 256-bit codes", async () => {
        const a = await createSetupCode(), b = await createSetupCode();
        expect(a.code).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
        expect(a.requestId).toMatch(/^[0-9a-f]{64}$/);
        expect(a.claimSecret).toHaveLength(32); expect(a.claimHash).toHaveLength(32);
        expect(a.code).not.toBe(b.code); expect(a.requestId).not.toBe(b.requestId);
        expect(await deriveSetupCode(a.code)).toEqual(a);
    });
    it.each(["context", "result"] as const)("decrypts the independent %s vector", async purpose => {
        expect(await decryptSetupCode(CODE, purpose, bytes(VECTORS[purpose]))).toBe("synthetic setup vector");
    });
    it.each(["context", "result"] as const)("uses interoperable AES-GCM framing and exact AAD for %s", async purpose => {
        const text = JSON.stringify({ synthetic: true, note: "اختبار — café", routes: [] });
        const frame = await encryptSetupCode(CODE, purpose, text);
        const decipher = createDecipheriv("aes-256-gcm", key(purpose), frame.subarray(0, 12));
        decipher.setAAD(aad(purpose)); decipher.setAuthTag(frame.subarray(frame.length - 16));
        expect(Buffer.concat([decipher.update(frame.subarray(12, -16)), decipher.final()]).toString("utf8")).toBe(text);
        expect(await decryptSetupCode(CODE, purpose, frame)).toBe(text);
    });
    it("uses fresh IVs even for identical plaintext (transport retries must retain one frame)", async () => {
        const a = await encryptSetupCode(CODE, "context", "same"), b = await encryptSetupCode(CODE, "context", "same");
        expect(a.subarray(0, 12)).not.toEqual(b.subarray(0, 12)); expect(a).not.toEqual(b);
        expect(await decryptSetupCode(CODE, "context", a)).toBe("same");
        expect(await decryptSetupCode(CODE, "context", b)).toBe("same");
    });
    it("rejects cross-purpose, wrong-code and tampered IV/ciphertext/tag frames", async () => {
        const frame = await encryptSetupCode(CODE, "context", "private synthetic setup");
        await expect(decryptSetupCode(CODE, "result", frame)).rejects.toThrow();
        await expect(decryptSetupCode("A".repeat(43), "context", frame)).rejects.toThrow();
        for (const index of [0, 11, 12, frame.length - 1]) {
            const changed = frame.slice(); changed[index] ^= 1;
            await expect(decryptSetupCode(CODE, "context", changed)).rejects.toThrow();
        }
    });
    it.each([CODE + "=", CODE.slice(1), CODE + "A", CODE.slice(0, 42) + "9", " " + CODE, CODE + "\n", CODE.replace("A", "+"), CODE.replace("A", "/"), "é".repeat(43), "", null, 1])("rejects malformed/noncanonical code %j", async code => {
        await expect(deriveSetupCode(code as string)).rejects.toThrow();
        await expect(encryptSetupCode(code as string, "context", "x")).rejects.toThrow();
        await expect(decryptSetupCode(code as string, "context", bytes(VECTORS.context))).rejects.toThrow();
    });
    it("rejects unsupported purposes and malformed/oversized frames", async () => {
        await expect(encryptSetupCode(CODE, "claim" as SetupCodePurpose, "x")).rejects.toThrow();
        await expect(decryptSetupCode(CODE, "claim" as SetupCodePurpose, bytes(VECTORS.context))).rejects.toThrow();
        for (const frame of [new Uint8Array(), new Uint8Array(27), new Uint8Array(SETUP_CODE_MAX_PLAINTEXT_BYTES + 29), {}]) {
            await expect(decryptSetupCode(CODE, "context", frame as Uint8Array)).rejects.toThrow();
        }
        await expect(encryptSetupCode(CODE, "context", null as unknown as string)).rejects.toThrow();
    });
    it("enforces UTF-8 byte limits and accepts exact-limit and empty plaintext", async () => {
        await expect(encryptSetupCode(CODE, "context", "x".repeat(SETUP_CODE_MAX_PLAINTEXT_BYTES + 1))).rejects.toThrow();
        await expect(encryptSetupCode(CODE, "context", "é".repeat(SETUP_CODE_MAX_PLAINTEXT_BYTES / 2 + 1))).rejects.toThrow();
        const text = "x".repeat(SETUP_CODE_MAX_PLAINTEXT_BYTES), frame = await encryptSetupCode(CODE, "result", text);
        expect(frame).toHaveLength(SETUP_CODE_MAX_PLAINTEXT_BYTES + 28);
        expect(await decryptSetupCode(CODE, "result", frame)).toBe(text);
        expect(await decryptSetupCode(CODE, "context", await encryptSetupCode(CODE, "context", ""))).toBe("");
    });
    it("rejects authenticated invalid UTF-8 rather than replacing bytes", async () => {
        const iv = Buffer.alloc(12, 3), cipher = createCipheriv("aes-256-gcm", key("context"), iv);
        cipher.setAAD(aad("context"));
        const frame = Buffer.concat([iv, cipher.update(Buffer.from([0xc3, 0x28])), cipher.final(), cipher.getAuthTag()]);
        await expect(decryptSetupCode(CODE, "context", frame)).rejects.toThrow();
    });
    it("snapshots the frame before asynchronous key derivation", async () => {
        const frame = bytes(VECTORS.context), pending = decryptSetupCode(CODE, "context", frame);
        frame.fill(0); expect(await pending).toBe("synthetic setup vector");
    });
});
