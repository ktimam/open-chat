import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function component(path: string): string {
    return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

describe("mobile action-card layout", () => {
    it("lets the v2 card own the available row instead of sharing it with an avatar", () => {
        const chatMessage = component("../components_mobile/home/ChatMessage.svelte");
        const messageBubble = component("../components_mobile/home/message/MessageBubble.svelte");

        expect(chatMessage).toContain("{#if showAvatar && !isActionCard}");
        expect(chatMessage).toContain(
            'supplementalClass={`message_bubble_wrapper${isActionCard ? " action_card_message" : ""}`}',
        );
        expect(chatMessage).toContain('width={isActionCard ? "fill" : "hug"}');
        expect(chatMessage).toContain('minWidth={isActionCard ? "0" : "6rem"}');
        expect(messageBubble).toContain('overflow={isActionCard ? "hidden" : "auto"}');
        expect(messageBubble).toContain('classes.push("action_card_message")');
    });

    it("gives classic mobile cards the same full-row treatment", () => {
        const chatMessage = component("../components/home/ChatMessage.svelte");

        expect(chatMessage).toContain("{#if showAvatar && (!isActionCard || !$mobileWidth)}");
        expect(chatMessage).toContain("class:actionCard={isActionCard}");
        expect(chatMessage).toMatch(
            /\{#if !collapsed &&\s*!msg\.deleted &&\s*canReact &&\s*!failed &&\s*\(!isActionCard \|\| !\$mobileWidth\)\}/,
        );
        expect(chatMessage).not.toContain("canReact && !failed && !isActionCard");
        expect(chatMessage).toContain("flex: 1 1 0;");
        expect(chatMessage).toContain("overflow-x: hidden;");
    });

    it("bounds the shared card and iframe by their message bubble", () => {
        const card = component("../components/home/ActionCardContent.svelte");

        expect(card).toContain("box-sizing: border-box;");
        expect(card).toContain("width: min(360px, 100%);");
        expect(card).toContain("width: min(420px, 100%);");
        expect(card).toMatch(/@include mobile\(\) \{\s+width: 100%;/);
        expect(card).toContain("table-layout: fixed;");
        expect(card).toContain("overflow-wrap: anywhere;");
        expect(card).toContain("flex-wrap: wrap;");
    });
});
