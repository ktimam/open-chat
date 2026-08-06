import type { OpenChat } from "@client";

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
