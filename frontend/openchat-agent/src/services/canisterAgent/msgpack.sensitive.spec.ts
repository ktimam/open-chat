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
});
