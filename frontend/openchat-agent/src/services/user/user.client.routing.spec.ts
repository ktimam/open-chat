// @vitest-environment node
import { AnonymousIdentity, type HttpAgent } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import type { DirectChatIdentifier, EventWrapper, Message } from "@shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../../config";
import type { ChatsDb } from "../../utils/chatsDb";
import { deserializeFromMsgPack } from "../../utils/msgpack";
import type { UserDb } from "../../utils/userCache";
import { UserClient } from "./user.client";

// Routing only: no attachments, real accounts, credentials, network or persisted messages.
// Keep the UserClient constructor, inherited Msgpack routing, schema validation and codec real.
vi.mock("../data/data.client", () => ({
    DataClient: class {
        uploadData = vi.fn(async () => undefined);
        forwardData = vi.fn(async () => undefined);
    },
}));

const principal = (...bytes: number[]) => Principal.fromUint8Array(Uint8Array.from(bytes)).toText();
const LEGACY_USER = principal(0, 0, 0, 0, 0, 0, 0, 11, 1, 1);
const MULTI_USER_CANISTER = principal(0, 0, 0, 0, 0, 0, 0, 12, 1, 1);
// Fixed byte fixtures, intentionally not calculated by the routing helper being tested.
const MULTI_USER = principal(0, 0, 0, 0, 0, 0, 0, 12, 37, 128);
const MULTI_USER_LAST_INDEX = principal(0, 0, 0, 0, 0, 0, 0, 12, 255, 255);
const RECIPIENT = principal(0, 0, 0, 0, 0, 0, 0, 13, 9, 128);
const TEXT = "SYNTHETIC ROUTING TEST - NEVER SENT";

function message(sender: string): EventWrapper<Message> {
    return {
        index: 0,
        timestamp: 1n,
        event: {
            kind: "message",
            messageId: 1n,
            messageIndex: 0,
            sender,
            content: { kind: "text_content", text: TEXT },
            reactions: [],
            tips: {},
            edited: false,
            forwarded: false,
            deleted: false,
            blockLevelMarkdown: true,
            ogPreviews: [],
            messagePreviews: [],
        },
    };
}

describe("UserClient official direct-message routing", () => {
    const forbiddenNetwork = vi.fn(() => {
        throw new Error("Network is forbidden in the synthetic routing test");
    });

    beforeEach(() => {
        forbiddenNetwork.mockClear();
        vi.stubGlobal("fetch", forbiddenNetwork);
        vi.spyOn(console, "log").mockImplementation(() => undefined);
    });

    afterEach(() => {
        expect(forbiddenNetwork).not.toHaveBeenCalled();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    function setup(userId: string) {
        // Capture the final IC call boundary, then stop. No success, certificate or save is faked.
        const call = vi
            .fn<HttpAgent["call"]>()
            .mockRejectedValue(new Error("SYNTHETIC_TRANSPORT_STOP"));
        const query = vi.fn<HttpAgent["query"]>().mockRejectedValue(new Error("Unexpected query"));
        const agent = { call, query } as unknown as HttpAgent;
        const cache = {
            removeFailedMessage: vi.fn(),
            recordFailedMessage: vi.fn(),
            setCachedMessageFromSendResponse: vi.fn(),
        };
        const client = new UserClient(
            userId,
            new AnonymousIdentity(),
            agent,
            {} as AgentConfig,
            cache as unknown as ChatsDb,
            {} as UserDb,
        );
        return { client, call, query, cache };
    }

    it.each([
        { name: "legacy User canister", userId: LEGACY_USER, canister: LEGACY_USER },
        { name: "indexed MultiUser", userId: MULTI_USER, canister: MULTI_USER_CANISTER },
        {
            name: "last indexed MultiUser",
            userId: MULTI_USER_LAST_INDEX,
            canister: MULTI_USER_CANISTER,
        },
    ])("routes $name through its canister's send_message_v2", async ({ userId, canister }) => {
        const { client, call, query, cache } = setup(userId);
        const chat: DirectChatIdentifier = { kind: "direct_chat", userId: RECIPIENT };
        const event = message(userId);
        const onRequestAccepted = vi.fn();

        await expect(
            client.sendMessage(chat, event, undefined, undefined, undefined, onRequestAccepted),
        ).rejects.toThrow();

        expect(call).toHaveBeenCalledOnce();
        const [target, request] = call.mock.calls[0];
        expect(target.toString()).toBe(canister);
        expect(request.effectiveCanisterId?.toString()).toBe(canister);
        expect(request.methodName).toBe("send_message_v2_msgpack");
        expect(request.callSync).toBe(false);
        expect(client.userId).toBe(userId);
        const args = deserializeFromMsgPack<{ recipient: Uint8Array; content: unknown }>(
            request.arg as Uint8Array,
        );
        // Target reconstruction must not accidentally rewrite the peer's user ID in the payload.
        expect(Principal.fromUint8Array(args.recipient).toText()).toBe(RECIPIENT);
        expect(args.content).toEqual({ Text: { text: TEXT } });
        expect(query).not.toHaveBeenCalled();
        expect(onRequestAccepted).not.toHaveBeenCalled();
        expect(cache.recordFailedMessage).toHaveBeenCalledOnce();
        expect(cache.setCachedMessageFromSendResponse).not.toHaveBeenCalled();
    });

    it("rejects a malformed user ID before any transport can be constructed", () => {
        expect(() => setup("synthetic-not-a-principal")).toThrow();
    });
});
