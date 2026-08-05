import type { AiAppCardConfirmationGrant } from "openchat-shared";

type ConfirmationGrantResponse =
    | { Success: { grant: Uint8Array | number[]; expires_at: bigint } }
    | "InvalidProvenance"
    | "AppUnavailable"
    | { InvalidRequest: string }
    | { Error: unknown };

export function createAiAppCardConfirmationGrantResponse(
    response: ConfirmationGrantResponse,
): AiAppCardConfirmationGrant | undefined {
    if (typeof response !== "object" || !("Success" in response)) return undefined;
    const grant = Uint8Array.from(response.Success.grant);
    if (grant.byteLength !== 32) return undefined;
    return { grant, expiresAt: response.Success.expires_at };
}
