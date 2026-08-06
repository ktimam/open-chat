import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const APP_ROOT = resolve(__dirname, "../..");

function source(path: string): string {
    return readFileSync(resolve(APP_ROOT, path), "utf8").replace(/\s+/g, " ");
}

describe("opaque per-chat launch-token client plumbing", () => {
    it("carries chat, app, and exact revision through the public client and worker", () => {
        const shared = source("../openchat-shared/src/domain/worker.ts");
        const client = source("../openchat-client/src/openchat.ts");
        const worker = source("../openchat-worker/src/worker.ts");

        expect(shared).toContain(
            'kind: "createAiAppChatLinkToken"; chatId: ChatIdentifier; appId: number; appRevision: bigint;',
        );
        expect(shared).toContain('kind: "cancelAiAppChatLinkToken"; token: Uint8Array;');
        expect(client).toContain('kind: "createAiAppChatLinkToken", chatId, appId, appRevision,');
        expect(client).toContain('kind: "cancelAiAppChatLinkToken", token: token.slice()');
        expect(worker).toContain(
            'case "createAiAppChatLinkToken": return agent.createAiAppChatLinkToken( payload.chatId, payload.appId, payload.appRevision, );',
        );
        expect(worker).toContain(
            'case "cancelAiAppChatLinkToken": return agent.cancelAiAppChatLinkToken(payload.token);',
        );
    });

    it("routes minting to the authoritative group, community, or authenticated user canister", () => {
        const agent = source("../openchat-agent/src/services/openchatAgent.ts");
        expect(agent).toContain(
            'case "group_chat": return this._groupClient.createAiAppChatLinkToken(',
        );
        expect(agent).toContain(
            'case "channel": return this._communityClient.createAiAppChatLinkToken(',
        );
        expect(agent).toContain(
            'case "direct_chat": return this._userClient instanceof UserClient ? this._userClient.createAiAppChatLinkToken(',
        );
        expect(agent).toContain("this._userIndexClient.cancelAiAppChatLinkToken(token)");

        for (const [path, method] of [
            [
                "../openchat-agent/src/services/group/group.client.ts",
                "create_ai_app_chat_link_token",
            ],
            [
                "../openchat-agent/src/services/community/community.client.ts",
                "create_ai_app_chat_link_token",
            ],
            ["../openchat-agent/src/services/user/user.client.ts", "create_ai_app_chat_link_token"],
        ] as const) {
            expect(source(path)).toContain(`"${method}"`);
        }
        expect(source("../openchat-agent/src/services/userIndex/userIndex.client.ts")).toContain(
            '"cancel_ai_app_chat_link_token", { token: token.slice() }',
        );
    });

    it("validates exact byte and expiry shapes at the agent boundary", () => {
        const schemas = source("../openchat-agent/src/typebox.ts");
        const mapper = source("../openchat-agent/src/services/common/aiAppChatLinkToken.ts");
        expect(schemas).toContain(
            "const CreateAiAppChatLinkTokenSuccess = Type.Object({ token: TSBytes, expires_at: Type.BigInt(), });",
        );
        expect(schemas).toContain('Type.Literal("AppUnavailable")');
        expect(schemas).toContain('Type.Literal("ChatNotFound")');
        expect(schemas).toContain('Type.Literal("NotAuthorized")');
        expect(mapper).toContain("token?.byteLength !== 32");
        expect(mapper).toContain('typeof expiresAt !== "bigint"');
        expect(mapper).not.toContain("console.");
        expect(mapper).not.toContain("localStorage");
        expect(mapper).not.toContain("sessionStorage");
    });
});
