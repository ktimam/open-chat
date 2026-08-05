import type { OpenChat } from "openchat-client";

/**
 * Cancel an explicit app-link consent attempt. Waiting for an in-flight create request closes the
 * race where the cancel reaches UserIndex first and a delayed create then leaves a fresh redeemable
 * code behind. The backend endpoint is idempotent and also disconnects a key that won the race.
 *
 * This helper is intentionally called only by user-driven close/cancel handlers, never teardown.
 */
export async function cancelAiAppLinkConsent(
    client: Pick<OpenChat, "removeMyAiAppKey">,
    appId: number,
    pendingCodeRequest?: Promise<unknown>,
): Promise<boolean> {
    try {
        await pendingCodeRequest;
    } catch {
        // A failed create still needs the idempotent invalidation call: the request may have reached
        // the canister even when the client did not receive its response.
    }
    try {
        return await client.removeMyAiAppKey(appId);
    } catch {
        return false;
    }
}
