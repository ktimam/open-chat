import { describe, expect, it } from "vitest";
import type { ChatIdentifier } from "@shared/domain";
import { chatIdentifierToString } from "@shared/utils/chat";
import { routeForMessage, routeForMessageContext } from "@shared/utils/routes";
import type { LocalAppDraftSourceReference } from "./localAppDraftPersistence";
import { localAppSourceNavigation } from "./localAppSourceNavigation";

const principal = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const direct: ChatIdentifier = { kind: "direct_chat", userId: principal };
const group: ChatIdentifier = { kind: "group_chat", groupId: principal };
const channel: ChatIdentifier = { kind: "channel", communityId: principal, channelId: 0 };
const chatIds = [direct, group, channel];
const captured = (chatId: ChatIdentifier) => ({
    chatKey: chatIdentifierToString(chatId),
    chatKind: chatId.kind,
});
const source = (
    values: Partial<LocalAppDraftSourceReference> = {},
): LocalAppDraftSourceReference => ({
    ...captured(direct),
    messageId: "987654321098765432109876543210",
    ...values,
});

describe("private-card source navigation", () => {
    it.each(chatIds)("uses the actual host capture codec for $kind", (chatId) => {
        expect(
            localAppSourceNavigation(source({ ...captured(chatId), messageIndex: 0 }))?.route,
        ).toBe(routeForMessage("none", { chatId }, 0));
    });
    it.each([
        { chatId: direct, route: `/chats/user/${principal}/0`, label: `Direct chat ${principal}` },
        { chatId: group, route: `/chats/group/${principal}/0`, label: `Group ${principal}` },
        {
            chatId: channel,
            route: `/community/${principal}/channel/0/0`,
            label: `Channel 0 in ${principal}`,
        },
    ])("links an exact index zero message in $chatId.kind", ({ chatId, route, label }) => {
        const value = source({ ...captured(chatId), messageIndex: 0 });
        expect(localAppSourceNavigation(value)).toEqual({
            route,
            label: `${label} · Message #1`,
            linkLabel: "View source message",
        });
        expect(route).toBe(routeForMessage("none", { chatId }, 0));
    });

    it.each(chatIds)("preserves real shared message/thread route semantics for $kind", (chatId) => {
        const value = source({ ...captured(chatId), messageIndex: 7, threadRootMessageIndex: 0 });
        const navigation = localAppSourceNavigation(value);
        expect(navigation?.route).toBe(
            routeForMessage("none", { chatId, threadRootMessageIndex: 0 }, 7),
        );
        expect(navigation?.route).toMatch(/\/0\/7\?open=true$/u);
        expect(navigation?.label).toContain(" · Thread #1 · Message #8");
        expect(navigation?.linkLabel).toBe("View source message");
    });

    it.each(chatIds)(
        "honestly links only the chat for a known-kind source without an index: $kind",
        (chatId) => {
            const value = source(captured(chatId));
            const navigation = localAppSourceNavigation(value);
            expect(navigation?.route).toBe(routeForMessageContext("none", { chatId }));
            expect(navigation?.linkLabel).toBe("Open source chat");
            expect(navigation?.label).not.toContain("Message");
            expect(navigation?.route).not.toContain(value.messageId);
        },
    );

    it("opens a known-kind thread without pretending its message ID is an index", () => {
        const value = source({ threadRootMessageIndex: 4, messageId: "5" });
        expect(localAppSourceNavigation(value)).toEqual({
            route: `/chats/user/${principal}/4?open=true`,
            label: `Direct chat ${principal} · Thread #5`,
            linkLabel: "Open source thread",
        });
    });

    it.each([
        {},
        { messageIndex: 0 },
        { threadRootMessageIndex: 0 },
        { messageIndex: 0, threadRootMessageIndex: 0 },
    ])("does not guess a legacy bare principal's chat kind: %j", (indices) => {
        expect(
            localAppSourceNavigation(source({ chatKind: undefined, ...indices })),
        ).toBeUndefined();
    });

    it("infers a legacy channel only from its canonical host key", () => {
        expect(
            localAppSourceNavigation(source({ ...captured(channel), chatKind: undefined })),
        ).toEqual({
            route: routeForMessageContext("none", { chatId: channel }),
            label: `Channel 0 in ${principal}`,
            linkLabel: "Open source chat",
        });
    });

    it("preserves index zero and thread context for a legacy kindless channel", () => {
        const value = source({
            ...captured(channel),
            chatKind: undefined,
            messageIndex: 0,
            threadRootMessageIndex: 0,
        });
        expect(localAppSourceNavigation(value)).toEqual({
            route: routeForMessage("none", { chatId: channel, threadRootMessageIndex: 0 }, 0),
            label: `Channel 0 in ${principal} · Thread #1 · Message #1`,
            linkLabel: "View source message",
        });
    });

    it("opens a legacy kindless channel thread without claiming a source message index", () => {
        const value = source({
            ...captured(channel),
            chatKind: undefined,
            threadRootMessageIndex: 0,
        });
        expect(localAppSourceNavigation(value)).toEqual({
            route: routeForMessageContext(
                "none",
                { chatId: channel, threadRootMessageIndex: 0 },
                true,
            ),
            label: `Channel 0 in ${principal} · Thread #1`,
            linkLabel: "Open source thread",
        });
    });

    it.each([
        { ...captured(channel), chatKind: "direct_chat" },
        { ...captured(channel), chatKind: "group_chat" },
        { ...captured(direct), chatKind: "channel" },
        { ...captured(direct), chatKind: "unknown" },
        { ...captured(direct), chatKind: null },
    ])("rejects incompatible or invalid host chat kind %j", (value) => {
        expect(
            localAppSourceNavigation(source(value as Partial<LocalAppDraftSourceReference>)),
        ).toBeUndefined();
    });

    it("uses only host identifiers and indices, never opaque message ID text", () => {
        const value = source({ messageId: "opaque-host-identity", messageIndex: 9 });
        expect(localAppSourceNavigation(value)?.route).toBe(`/chats/user/${principal}/9`);
        expect(localAppSourceNavigation(value)?.label).not.toContain(value.messageId);
    });

    it("accepts safe upper index bounds without rounding them", () => {
        const value = source({
            ...captured({
                kind: "channel",
                communityId: principal,
                channelId: Number.MAX_SAFE_INTEGER,
            }),
            messageIndex: Number.MAX_SAFE_INTEGER,
            threadRootMessageIndex: Number.MAX_SAFE_INTEGER,
        });
        expect(localAppSourceNavigation(value)?.route).toBe(
            `/community/${principal}/channel/9007199254740991/9007199254740991/9007199254740991?open=true`,
        );
        expect(localAppSourceNavigation(value)?.label).toContain(
            " · Thread #9007199254740992 · Message #9007199254740992",
        );
    });

    it.each([
        "",
        "d",
        "x|aaaaa-aa",
        `dX${principal}`,
        `d|${principal}`,
        `g|${principal}`,
        `c|${principal}|0`,
        `d|${principal}|0`,
        `g|${principal}|0`,
        `c|${principal}`,
        `${principal}_`,
        `${principal}_00`,
        `${principal}_01`,
        `${principal}_+1`,
        `${principal}_-0`,
        `${principal}_-1`,
        `${principal}_1.5`,
        `${principal}_1e2`,
        `${principal}_9007199254740992`,
        `${principal}_1_2`,
        `${principal}?open=true`,
        `${principal}#fragment`,
        `${principal}/path`,
        `${principal}%3Fopen`,
        `${principal}\n`,
        `${principal}\u0000`,
        principal.toUpperCase(),
        ` ${principal}`,
        "aaaaa-ab",
        "https://example.test/",
        "javascript:alert(1)",
        "//example.test/",
    ])("rejects malformed or noncanonical key %j", (chatKey) => {
        for (const chatKind of [undefined, "direct_chat", "group_chat", "channel"] as const) {
            expect(
                localAppSourceNavigation(source({ chatKey, chatKind, messageIndex: 3 })),
            ).toBeUndefined();
        }
    });

    it.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "0", null])(
        "rejects invalid optional index %j in either position",
        (index) => {
            for (const key of ["messageIndex", "threadRootMessageIndex"] as const) {
                expect(
                    localAppSourceNavigation(
                        source({
                            [key]: index,
                        } as unknown as Partial<LocalAppDraftSourceReference>),
                    ),
                ).toBeUndefined();
            }
        },
    );

    it("rejects absent or unusable host identity without throwing", () => {
        expect(localAppSourceNavigation(undefined)).toBeUndefined();
        for (const messageId of ["", " ", "a\n", "\u0085", "a".repeat(129)]) {
            expect(localAppSourceNavigation(source({ messageId }))).toBeUndefined();
        }
    });

    it("does not mutate the source", () => {
        const value = Object.freeze(source({ messageIndex: 3, threadRootMessageIndex: 1 }));
        const before = JSON.stringify(value);
        localAppSourceNavigation(value);
        expect(JSON.stringify(value)).toBe(before);
    });
});
