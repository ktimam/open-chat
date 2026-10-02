import type { ChatIdentifier } from "@shared/domain";
import { chatIdentifierToString } from "@shared/utils/chat";
import { routeForMessage, routeForMessageContext } from "@shared/utils/routes";
import { isPrincipalValid } from "@shared/utils/string";
import type { LocalAppDraftSourceReference } from "./localAppDraftPersistence";

function safeIndex(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// Display one-based ordinals without rounding the largest permitted route index.
const ordinal = (index: number): string => (BigInt(index) + 1n).toString();

/** Local host-owned navigation only; message IDs are never message indices. */
export function localAppSourceNavigation(
    source: LocalAppDraftSourceReference | undefined,
): { route: string; label: string; linkLabel: string } | undefined {
    if (
        !source ||
        typeof source.chatKey !== "string" ||
        source.chatKey.length > 2048 ||
        typeof source.messageId !== "string" ||
        !source.messageId.trim() ||
        source.messageId.length > 128 ||
        // eslint-disable-next-line no-control-regex
        /[\u0000-\u001f\u007f-\u009f]/u.test(source.messageId)
    )
        return undefined;

    // Match the host capture codec, not the separate map-key codec. A bare
    // principal cannot distinguish an older direct-chat source from a group.
    const parts = /^([a-z2-7]+(?:-[a-z2-7]+)*)(?:_(0|[1-9][0-9]*))?$/u.exec(source.chatKey);
    if (
        !parts ||
        !isPrincipalValid(parts[1]) ||
        (source.chatKind !== undefined &&
            source.chatKind !== "direct_chat" &&
            source.chatKind !== "group_chat" &&
            source.chatKind !== "channel") ||
        (parts[2] !== undefined && !safeIndex(Number(parts[2]))) ||
        (source.messageIndex !== undefined && !safeIndex(source.messageIndex)) ||
        (source.threadRootMessageIndex !== undefined && !safeIndex(source.threadRootMessageIndex))
    )
        return undefined;

    let chatId: ChatIdentifier;
    if (parts[2] !== undefined) {
        if (source.chatKind !== undefined && source.chatKind !== "channel") return undefined;
        chatId = { kind: "channel", communityId: parts[1], channelId: Number(parts[2]) };
    } else if (source.chatKind === "direct_chat") {
        chatId = { kind: "direct_chat", userId: parts[1] };
    } else if (source.chatKind === "group_chat") {
        chatId = { kind: "group_chat", groupId: parts[1] };
    } else {
        return undefined;
    }
    if (chatIdentifierToString(chatId) !== source.chatKey) return undefined;
    const context = { chatId, threadRootMessageIndex: source.threadRootMessageIndex };
    const label = [
        chatId.kind === "direct_chat"
            ? `Direct chat ${chatId.userId}`
            : chatId.kind === "group_chat"
              ? `Group ${chatId.groupId}`
              : `Channel ${chatId.channelId} in ${chatId.communityId}`,
        ...(source.threadRootMessageIndex === undefined
            ? []
            : [`Thread #${ordinal(source.threadRootMessageIndex)}`]),
        ...(source.messageIndex === undefined ? [] : [`Message #${ordinal(source.messageIndex)}`]),
    ].join(" · ");

    return source.messageIndex === undefined
        ? {
              route: routeForMessageContext("none", context, true),
              label,
              linkLabel:
                  source.threadRootMessageIndex === undefined
                      ? "Open source chat"
                      : "Open source thread",
          }
        : {
              route: routeForMessage("none", context, source.messageIndex),
              label,
              linkLabel: "View source message",
          };
}
