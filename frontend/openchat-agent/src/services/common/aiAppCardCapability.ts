import type { AiAppCardCapability } from "openchat-shared";

type CapabilityResponse =
    | {
          Success: {
              token: Uint8Array | number[];
              expires_at: bigint;
              context: {
                  context_version: number;
                  app_subject: Uint8Array | number[];
                  chat_handle: Uint8Array | number[];
                  message_handle: Uint8Array | number[];
                  app_id: number;
                  app_revision: bigint;
                  action_id: string;
              };
          };
      }
    | "InvalidProvenance"
    | "AppUnavailable"
    | { InvalidRequest: string }
    | { Error: unknown };

function base64Url(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

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

export function createAiAppCardCapabilityResponse(
    response: CapabilityResponse | unknown,
): AiAppCardCapability | undefined {
    if (typeof response !== "object" || response === null || !("Success" in response)) {
        return undefined;
    }
    const success = response.Success;
    if (typeof success !== "object" || success === null) return undefined;
    const token = exactBytes("token" in success ? success.token : undefined);
    const context = "context" in success ? success.context : undefined;
    if (typeof context !== "object" || context === null) return undefined;
    const expiresAt = "expires_at" in success ? success.expires_at : undefined;
    const contextVersion =
        "context_version" in context ? context.context_version : undefined;
    const appSubject = exactBytes("app_subject" in context ? context.app_subject : undefined);
    const chatHandle = exactBytes("chat_handle" in context ? context.chat_handle : undefined);
    const messageHandle = exactBytes("message_handle" in context ? context.message_handle : undefined);
    const appId = "app_id" in context ? context.app_id : undefined;
    const appRevision = "app_revision" in context ? context.app_revision : undefined;
    const actionId = "action_id" in context ? context.action_id : undefined;
    // The capability is opaque but must never be empty. Its upper bound prevents a compromised
    // canister response from becoming an oversized postMessage/storage pressure vector.
    if (
        token?.byteLength !== 32 ||
        contextVersion !== 1 ||
        appSubject?.byteLength !== 32 ||
        chatHandle?.byteLength !== 32 ||
        messageHandle?.byteLength !== 32 ||
        typeof appId !== "number" ||
        !Number.isSafeInteger(appId) ||
        appId < 0 ||
        appId > 0xffff_ffff ||
        typeof appRevision !== "bigint" ||
        appRevision < 0n ||
        typeof expiresAt !== "bigint" ||
        expiresAt < 0n ||
        typeof actionId !== "string" ||
        actionId.length === 0 ||
        actionId.length > 128
    ) return undefined;
    return {
        capability: base64Url(token),
        expiresAt,
        context: {
            contextVersion: 1,
            appSubject: base64Url(appSubject),
            chatHandle: base64Url(chatHandle),
            messageHandle: base64Url(messageHandle),
            appId,
            appRevision,
            actionId,
        },
    };
}
