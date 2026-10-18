/** Shared wire protocol. Keep byte-identical in OpenChat and app clients. */
export const SETUP_CODE_DOMAIN = "openchat-app-setup-code-v1";
export const SETUP_CODE_MAX_PLAINTEXT_BYTES = 1024 * 1024;
export type SetupCodePurpose = "context" | "result";
export type SetupCodeMaterial = Readonly<{
    code: string;
    requestId: string;
    claimSecret: Uint8Array;
    claimHash: Uint8Array;
}>;

const IV_BYTES = 12;
const TAG_BYTES = 16;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function invalid(): never {
    throw new Error("Invalid app setup code or encrypted frame");
}
function buffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.slice().buffer as ArrayBuffer;
}
function encodeCode(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}
function decodeCode(code: string): Uint8Array {
    if (typeof code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(code)) invalid();
    let bytes: Uint8Array;
    try {
        bytes = Uint8Array.from(atob(code.replace(/-/g, "+").replace(/_/g, "/") + "="), c => c.charCodeAt(0));
    } catch {
        return invalid();
    }
    if (bytes.byteLength !== 32 || encodeCode(bytes) !== code) invalid();
    return bytes;
}
function purposeValue(purpose: SetupCodePurpose): SetupCodePurpose {
    if (purpose !== "context" && purpose !== "result") invalid();
    return purpose;
}
async function digest(bytes: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", buffer(bytes)));
}
function hex(bytes: Uint8Array): string {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
async function rootKey(rawCode: Uint8Array): Promise<CryptoKey> {
    return crypto.subtle.importKey("raw", buffer(rawCode), "HKDF", false, ["deriveBits", "deriveKey"]);
}
function hkdf(info: "claim" | SetupCodePurpose): HkdfParams {
    return { name: "HKDF", hash: "SHA-256", salt: encoder.encode(SETUP_CODE_DOMAIN), info: encoder.encode(info) };
}
async function encryptionKey(rawCode: Uint8Array, purpose: SetupCodePurpose): Promise<CryptoKey> {
    return crypto.subtle.deriveKey(hkdf(purpose), await rootKey(rawCode), { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
function additionalData(purpose: SetupCodePurpose, requestId: string): Uint8Array {
    return encoder.encode(JSON.stringify([SETUP_CODE_DOMAIN, purpose, requestId]));
}

/** The code is a high-entropy bearer secret. Never send it to a canister or put it in a URL. */
export async function createSetupCode(): Promise<SetupCodeMaterial> {
    return deriveSetupCode(encodeCode(crypto.getRandomValues(new Uint8Array(32))));
}
export async function deriveSetupCode(code: string): Promise<SetupCodeMaterial> {
    const rawCode = decodeCode(code);
    const requestId = hex(await digest(rawCode));
    const claimSecret = new Uint8Array(await crypto.subtle.deriveBits(hkdf("claim"), await rootKey(rawCode), 256));
    return Object.freeze({ code, requestId, claimSecret, claimHash: await digest(claimSecret) });
}

/** AAD binds purpose and request. Callers must validate publisher/account/scope inside the plaintext. */
export async function encryptSetupCode(code: string, purpose: SetupCodePurpose, plaintext: string): Promise<Uint8Array> {
    purposeValue(purpose);
    const rawCode = decodeCode(code);
    if (typeof plaintext !== "string" || plaintext.length > SETUP_CODE_MAX_PLAINTEXT_BYTES) invalid();
    const bytes = encoder.encode(plaintext);
    if (bytes.byteLength > SETUP_CODE_MAX_PLAINTEXT_BYTES) invalid();
    const requestId = hex(await digest(rawCode));
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
        name: "AES-GCM", iv: buffer(iv), additionalData: buffer(additionalData(purpose, requestId)), tagLength: 128,
    }, await encryptionKey(rawCode, purpose), buffer(bytes)));
    const frame = new Uint8Array(IV_BYTES + ciphertext.byteLength);
    frame.set(iv);
    frame.set(ciphertext, IV_BYTES);
    return frame;
}
export async function decryptSetupCode(code: string, purpose: SetupCodePurpose, frame: Uint8Array): Promise<string> {
    purposeValue(purpose);
    const rawCode = decodeCode(code);
    if (!(frame instanceof Uint8Array) || frame.byteLength < IV_BYTES + TAG_BYTES ||
        frame.byteLength > SETUP_CODE_MAX_PLAINTEXT_BYTES + IV_BYTES + TAG_BYTES) invalid();
    // Snapshot before awaiting so a caller cannot mutate the authenticated frame mid-operation.
    const copied = frame.slice();
    const requestId = hex(await digest(rawCode));
    const plaintext = await crypto.subtle.decrypt({
        name: "AES-GCM", iv: buffer(copied.subarray(0, IV_BYTES)),
        additionalData: buffer(additionalData(purpose, requestId)), tagLength: 128,
    }, await encryptionKey(rawCode, purpose), buffer(copied.subarray(IV_BYTES)));
    if (plaintext.byteLength > SETUP_CODE_MAX_PLAINTEXT_BYTES) invalid();
    return decoder.decode(plaintext);
}
