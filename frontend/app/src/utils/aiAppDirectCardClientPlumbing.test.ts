import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const FRONTEND_ROOT = resolve(__dirname, "../..");

function source(path: string): string {
    return readFileSync(resolve(FRONTEND_ROOT, path), "utf8").replace(/\s+/g, " ");
}

describe("direct AI-app card client routing", () => {
    it("routes capability minting to the authenticated user's authoritative canister", () => {
        const agent = source("../openchat-agent/src/services/openchatAgent.ts");
        const start = agent.indexOf("createAiAppCardCapability(");
        const end = agent.indexOf("createAiAppCardConfirmationGrant(", start);
        const method = agent.slice(start, end);

        expect(method).toContain('case "direct_chat":');
        expect(method).toContain("this._userClient instanceof UserClient");
        expect(method).toContain("this._userClient.createAiAppCardCapability(");
        expect(method).toContain("chatId.userId");
        expect(method).not.toContain('case "direct_chat": return Promise.resolve(undefined)');

        const userClient = source("../openchat-agent/src/services/user/user.client.ts");
        expect(userClient).toContain(
            'createAiAppCardCapability( userId: string, messageId: bigint, threadRootMessageIndex: number | undefined, recipientKeyScheme: string, recipientPublicKey: Uint8Array, )',
        );
        expect(userClient).toContain('"create_ai_app_card_capability"');
        expect(userClient).toContain("user_id: principalStringToBytes(userId)");
    });

    it("routes confirmation-grant minting to the authenticated user's authoritative canister", () => {
        const agent = source("../openchat-agent/src/services/openchatAgent.ts");
        const start = agent.indexOf("createAiAppCardConfirmationGrant(");
        const end = agent.indexOf("removeMyAiAppKey(", start);
        const method = agent.slice(start, end);

        expect(method).toContain('case "direct_chat":');
        expect(method).toContain("this._userClient instanceof UserClient");
        expect(method).toContain("this._userClient.createAiAppCardConfirmationGrant(");
        expect(method).toContain("chatId.userId");
        expect(method).not.toContain('case "direct_chat": return Promise.resolve(undefined)');

        const userClient = source("../openchat-agent/src/services/user/user.client.ts");
        expect(userClient).toContain(
            'createAiAppCardConfirmationGrant( userId: string, messageId: bigint, threadRootMessageIndex: number | undefined, confirmPayload: Uint8Array, )',
        );
        expect(userClient).toContain('"create_ai_app_card_confirmation_grant"');
        expect(userClient).toContain("user_id: principalStringToBytes(userId)");
        expect(userClient).toContain("confirm_payload: confirmPayload.slice()");
    });
});
