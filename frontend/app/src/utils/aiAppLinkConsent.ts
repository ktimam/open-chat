import type { AiAppUserKey, OpenChat } from "@client";

export interface AiAppConnectionSnapshot {
    publicKey: string;
    keyVersion: bigint;
}

/**
 * First-time Connect accepts any non-empty key so it remains compatible with a rolling UserIndex
 * deployment. Recovery is stricter: only a higher authoritative epoch proves that the user asked
 * the exact app to claim a fresh code. The PEM may remain identical.
 */
export function aiAppLinkCompleted(
    keys: readonly AiAppUserKey[],
    appId: number,
    previousConnection?: AiAppConnectionSnapshot,
): boolean {
    return keys.some(
        (key) =>
            key.appId === appId &&
            key.publicKey.trim().length > 0 &&
            (previousConnection === undefined || key.keyVersion > previousConnection.keyVersion),
    );
}

/**
 * Cancel an explicit app-link consent attempt. Waiting for an in-flight create request closes the
 * race where the cancel reaches UserIndex first and a delayed create then leaves a fresh redeemable
 * code behind. The backend endpoint cancels only that exact token and never disconnects a key.
 *
 * This helper is intentionally called only by user-driven close/cancel handlers, never teardown.
 */
export async function cancelAiAppLinkConsent(
    client: Pick<OpenChat, "cancelAiAppLinkCode" | "removeMyAiAppKey">,
    codeSource: string | undefined | (() => string | undefined),
    pendingCodeRequest?: Promise<unknown>,
): Promise<void> {
    try {
        await pendingCodeRequest;
    } catch {
        // If the response was lost, there is no bearer the client can cancel. It expires by TTL.
    }
    const code = typeof codeSource === "function" ? codeSource() : codeSource;
    if (code === undefined) return;
    try {
        await client.cancelAiAppLinkCode(code);
    } catch {
        // Closing is never blocked. A response-lost token is bounded by its short server TTL.
    }
}
