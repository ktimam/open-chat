import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const FRONTEND_ROOT = resolve(__dirname, "../..");

function source(path: string): string {
    return readFileSync(resolve(FRONTEND_ROOT, path), "utf8").replace(/\s+/g, " ");
}

describe("direct AI-app card client routing", () => {
    it("routes private-match minting with exact app and message coordinates for every chat kind", () => {
        const agent = source("../openchat-agent/src/services/openchatAgent.ts");
        const start = agent.indexOf("createAiAppPrivateMatchCapability(");
        const end = agent.indexOf("createAiAppCardConfirmationGrant(", start);
        const method = agent.slice(start, end);

        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);
        expect(method).toContain("this._groupClient.createAiAppPrivateMatchCapability(");
        expect(method).toContain("this._communityClient.createAiAppPrivateMatchCapability(");
        expect(method).toContain("this._userClient.createAiAppPrivateMatchCapability(");
        expect(method).toContain("threadRootMessageIndex");
        expect(method).toContain("messageId");
        expect(method).toContain("appId");
        expect(method).toContain("appRevision");
        expect(method).toContain("actionId");

        for (const [client, nextMethod] of [
            ["group/group.client.ts", "createAiAppChatLinkToken("],
            ["community/community.client.ts", "createAiAppChatLinkToken("],
            ["user/user.client.ts", "createAiAppCardConfirmationGrant("],
        ] as const) {
            const clientSource = source(`../openchat-agent/src/services/${client}`);
            const methodStart = clientSource.indexOf("createAiAppPrivateMatchCapability(");
            const methodEnd = clientSource.indexOf(nextMethod, methodStart);
            const clientMethod = clientSource.slice(methodStart, methodEnd);
            expect(clientMethod).toContain('"create_ai_app_private_match_capability"');
            expect(clientMethod).toContain("recipient_public_key: recipientPublicKey.slice()");
            expect(clientMethod).toContain("{ sensitive: true }");
        }

        const worker = source("../openchat-worker/src/worker.ts");
        expect(worker).toContain('case "createAiAppPrivateMatchCapability":');
        const publicClient = source("../openchat-client/src/openchat.ts");
        expect(publicClient).toContain('kind: "createAiAppPrivateMatchCapability"');
        expect(publicClient).toContain("recipientPublicKey: recipientPublicKey.slice()");
    });

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
            "createAiAppCardCapability( userId: string, messageId: bigint, threadRootMessageIndex: number | undefined, recipientKeyScheme: string, recipientPublicKey: Uint8Array, )",
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
            "createAiAppCardConfirmationGrant( userId: string, messageId: bigint, threadRootMessageIndex: number | undefined, confirmPayload: Uint8Array, )",
        );
        expect(userClient).toContain('"create_ai_app_card_confirmation_grant"');
        expect(userClient).toContain("user_id: principalStringToBytes(userId)");
        expect(userClient).toContain("confirm_payload: confirmPayload.slice()");
    });
});
