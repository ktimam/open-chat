import type { AiAppChatLinkToken } from "@shared";

function exactBytes(value: unknown): Uint8Array | undefined {
    if (value instanceof Uint8Array) return value;
    if (
        !Array.isArray(value) ||
        !value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 0xff)
    ) {
        return undefined;
    }
    return Uint8Array.from(value);
}

// Fail closed on every malformed or rejected response. In particular, never coerce arbitrary
// values into a URL bearer: only an exact 256-bit canister-minted token is accepted.
export function createAiAppChatLinkTokenResponse(
    response: unknown,
): AiAppChatLinkToken | undefined {
    if (typeof response !== "object" || response === null || !("Success" in response)) {
        return undefined;
    }
    const success = response.Success;
    if (typeof success !== "object" || success === null) return undefined;
    const token = exactBytes("token" in success ? success.token : undefined);
    const expiresAt = "expires_at" in success ? success.expires_at : undefined;
    if (token?.byteLength !== 32 || typeof expiresAt !== "bigint" || expiresAt < 0n) {
        return undefined;
    }
    return { token: token.slice(), expiresAt };
}
