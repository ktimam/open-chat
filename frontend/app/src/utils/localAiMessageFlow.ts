import type { LocalAiChatMessage, LocalAiResult } from "./localAiCommand";

export type LocalAiMessageInput = { text?: string; image?: Uint8Array };

export type LocalAiMessageFlowResult =
    | { kind: "success"; message: string }
    | { kind: "error"; message: string }
    | { kind: "stale" };

export interface LocalAiMessageFlowDeps {
    readInput: () => Promise<LocalAiMessageInput | undefined>;
    unsupportedMessage: () => string;
    promptFor: (input: LocalAiMessageInput) => string;
    contextFor: (input: LocalAiMessageInput) => LocalAiChatMessage[];
    infer: (
        prompt: string,
        image: Uint8Array | undefined,
        context: LocalAiChatMessage[],
    ) => Promise<LocalAiResult>;
    sendReply: (text: string) => Promise<{ kind: string }>;
    stillCurrent: () => boolean;
}

/** Execute selected-message local AI without crossing a stale account/chat/message boundary. */
export async function runLocalAiMessageFlow(
    deps: LocalAiMessageFlowDeps,
): Promise<LocalAiMessageFlowResult> {
    try {
        const input = await deps.readInput();
        if (!deps.stillCurrent()) return { kind: "stale" };
        if (input === undefined) throw new Error(deps.unsupportedMessage());

        const outcome = await deps.infer(
            deps.promptFor(input),
            input.image,
            deps.contextFor(input),
        );
        if (!deps.stillCurrent()) return { kind: "stale" };

        if (outcome.kind === "unavailable") {
            return {
                kind: "error",
                message: `On-device AI unavailable: ${outcome.reason}`,
            };
        }
        if (outcome.kind === "error") {
            return { kind: "error", message: `On-device AI failed: ${outcome.error}` };
        }

        const reply = outcome.reply.length > 0 ? outcome.reply : "(no output)";
        const response = await deps.sendReply(`🤖 ${reply}`);
        if (!deps.stillCurrent()) return { kind: "stale" };
        if (response.kind !== "success") {
            throw new Error(`could not post the AI response (${response.kind})`);
        }
        return { kind: "success", message: "AI response added." };
    } catch (error) {
        if (!deps.stillCurrent()) return { kind: "stale" };
        return {
            kind: "error",
            message: `On-device AI failed: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
