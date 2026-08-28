import { AnonymousIdentity, type HttpAgent } from "@icp-sdk/core/agent";
import { Type } from "@sinclair/typebox";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { typeboxValidate } from "../../utils/typebox";
import { SingleCanisterMsgpackAgent } from "./msgpack";

const SensitiveRequest = Type.Object({ bearer: Type.String() });
const SuccessResponse = Type.Literal("Success");

function loggedText(calls: unknown[][]): string {
    return calls
        .flat()
        .map((value) => {
            if (value instanceof Error) return value.message;
            if (typeof value === "object" && value !== null) return JSON.stringify(value);
            return String(value);
        })
        .join(" ");
}

function methodSource(file: string, methodName: string, nextMethodName: string): string {
    const source = readFileSync(file, "utf8");
    const start = source.indexOf(`${methodName}(`);
    const end = source.indexOf(`${nextMethodName}(`, start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
}

class SensitiveTestAgent extends SingleCanisterMsgpackAgent {
    constructor(agent: HttpAgent) {
        super(new AnonymousIdentity(), agent, "aaaaa-aa", "SensitiveTest");
    }

    cancel(bearer: string): Promise<string> {
        return this.update(
            "cancel_sensitive_value",
            { bearer },
            (response) => response,
            SensitiveRequest,
            SuccessResponse,
            undefined,
            { sensitive: true },
        );
    }
}

describe("sensitive Msgpack calls", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("never logs raw sensitive update arguments when the transport fails", async () => {
        const bearer = "raw-bearer-must-not-be-logged";
        const args = { bearer };
        const call = vi.fn().mockRejectedValue(new Error("transport failed: " + bearer));
        const agent = new SensitiveTestAgent({ call } as unknown as HttpAgent);
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

        await expect(agent.cancel(args.bearer)).rejects.toBeDefined();

        expect(
            log.mock.calls.some((entry) =>
                entry.some(
                    (value) =>
                        typeof value === "object" &&
                        value !== null &&
                        "bearer" in value &&
                        value.bearer === bearer,
                ),
            ),
        ).toBe(false);
        expect(log.mock.calls.flat()).not.toContain(bearer);
        expect(loggedText(log.mock.calls)).not.toContain(bearer);
    });

    it("never logs a raw sensitive value when response validation fails", () => {
        const bearer = "malformed-sensitive-response";
        const value = { bearer };
        const validator = Type.Object({ bearer: Type.Never() });
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

        expect(() =>
            typeboxValidate(value, validator, {
                sensitive: true,
            }),
        ).toThrow();

        expect(error.mock.calls.some((entry) => entry.includes(value))).toBe(false);
        expect(error.mock.calls.flat()).not.toContain(value);
        expect(error.mock.calls.flat()).not.toContain(bearer);
        expect(loggedText(error.mock.calls)).not.toContain(bearer);
    });

    it("opts every chat-link mint and cancellation call into sensitive handling", () => {
        const files = [
            resolve(__dirname, "../group/group.client.ts"),
            resolve(__dirname, "../community/community.client.ts"),
            resolve(__dirname, "../user/user.client.ts"),
            resolve(__dirname, "../userIndex/userIndex.client.ts"),
        ];

        for (const file of files) {
            const source = readFileSync(file, "utf8");
            expect(source).toContain("sensitive: true");
        }
    });

    it("opts every confirmation-grant mint into sensitive handling", () => {
        const clients = [
            {
                file: resolve(__dirname, "../group/group.client.ts"),
                nextMethod: "searchGroupChat(",
            },
            {
                file: resolve(__dirname, "../community/community.client.ts"),
                nextMethod: "setAiAppEnabled(",
            },
            {
                file: resolve(__dirname, "../user/user.client.ts"),
                nextMethod: "createAiAppChatLinkToken(",
            },
        ];

        for (const { file, nextMethod } of clients) {
            const source = readFileSync(file, "utf8");
            const start = source.indexOf("createAiAppCardConfirmationGrant(");
            const end = source.indexOf(nextMethod, start);
            const method = source.slice(start, end);

            expect(start).toBeGreaterThanOrEqual(0);
            expect(end).toBeGreaterThan(start);
            expect(method).toMatch(/\{\s*sensitive:\s*true\s*\}/);
        }
    });

    it("opts every card-capability mint into sensitive handling", () => {
        const clients = [
            {
                file: resolve(__dirname, "../group/group.client.ts"),
                nextMethod: "createAiAppChatLinkToken(",
            },
            {
                file: resolve(__dirname, "../community/community.client.ts"),
                nextMethod: "createAiAppChatLinkToken(",
            },
            {
                file: resolve(__dirname, "../user/user.client.ts"),
                nextMethod: "createAiAppCardConfirmationGrant(",
            },
        ];

        for (const { file, nextMethod } of clients) {
            const source = readFileSync(file, "utf8");
            const start = source.indexOf("createAiAppCardCapability(");
            const end = source.indexOf(nextMethod, start);
            const method = source.slice(start, end);

            expect(start).toBeGreaterThanOrEqual(0);
            expect(end).toBeGreaterThan(start);
            expect(method).toMatch(/\{\s*sensitive:\s*true\s*\}/);
        }
    });

    it("opts every action-card response carrying confirmation material into sensitive handling", () => {
        const clients = [
            resolve(__dirname, "../group/group.client.ts"),
            resolve(__dirname, "../community/community.client.ts"),
            resolve(__dirname, "../user/user.client.ts"),
        ];

        for (const file of clients) {
            const method = methodSource(file, "respondToActionCard", "createAiAppCardCapability");

            expect(method).toContain("confirmation_grant");
            expect(method).toContain("confirm_payload_override");
            expect(method).toMatch(/\{\s*sensitive:\s*true\s*\}/);
        }
    });

    it("opts provenance and legacy link-code bearer calls into sensitive handling", () => {
        const file = resolve(__dirname, "../userIndex/userIndex.client.ts");
        const methods = [
            methodSource(file, "cancelAiAppLinkCode", "cancelAiAppChatLinkToken"),
            methodSource(file, "createAiAppLinkCode", "createAiAppCardProvenance"),
            methodSource(file, "createAiAppCardProvenance", "exploreAiApps"),
        ];

        for (const method of methods) {
            expect(method).toMatch(/\{\s*sensitive:\s*true\s*\}/);
        }
    });

    it("marks only app-provenance proposal sends as sensitive", () => {
        const clients = [
            {
                file: resolve(__dirname, "../group/group.client.ts"),
                nextMethod: "updateGroup",
            },
            {
                file: resolve(__dirname, "../community/community.client.ts"),
                nextMethod: "registerPollVote",
            },
            {
                file: resolve(__dirname, "../user/user.client.ts"),
                nextMethod: "sendMessageWithTransferToGroup",
            },
        ];

        for (const { file, nextMethod } of clients) {
            const method = methodSource(file, "sendMessage", nextMethod);

            expect(method).toContain('kind === "action_card_content"');
            expect(method).toContain("appProvenance !== undefined");
            expect(method).toMatch(/\?\s*\{\s*sensitive:\s*true\s*\}\s*:\s*undefined/);
        }
    });

    it("redacts crafted ActionCard edit calls without hiding ordinary edit diagnostics", () => {
        const clients = [
            {
                file: resolve(__dirname, "../group/group.client.ts"),
                nextMethod: "sendMessage",
            },
            {
                file: resolve(__dirname, "../community/community.client.ts"),
                nextMethod: "enableInviteCode",
            },
            {
                file: resolve(__dirname, "../user/user.client.ts"),
                nextMethod: "sendMessage",
            },
        ];

        for (const { file, nextMethod } of clients) {
            const method = methodSource(file, "editMessage", nextMethod);

            expect(method).toContain('message.content.kind === "action_card_content"');
            expect(method).toMatch(/\?\s*\{\s*sensitive:\s*true\s*\}\s*:\s*undefined/);
        }
    });

    it("rejects ActionCard edits before dispatching to any canister client", () => {
        const file = resolve(__dirname, "../openchatAgent.ts");
        const method = methodSource(file, "editMessage", "sendMessage");
        const guard = method.indexOf('msg.content.kind === "action_card_content"');
        const dispatch = method.indexOf("switch (chatId.kind)");

        expect(guard).toBeGreaterThanOrEqual(0);
        expect(dispatch).toBeGreaterThan(guard);
        expect(method.slice(guard, dispatch)).toContain("ErrorCode.InvalidRequest");
    });
});
