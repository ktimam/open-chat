import type { AttachmentContent, MessageContext, OpenChat } from "@client";
import { messageContextsEqual } from "@client";
import { contentToInput } from "./aiActionRunner";
import { runLocalAiCommand, type LocalAiChatMessage, type LocalAiResult } from "./localAiCommand";

type LocalAiComposerClient = Pick<OpenChat, "downloadPublicBlob" | "sendMessageWithContent">;

export type LocalAiComposerOutcome =
    | { kind: "sent" }
    | { kind: "busy" }
    | { kind: "stale" }
    | { kind: "unavailable"; reason: string }
    | { kind: "error"; error: string };

export interface CapturedLocalAiComposerContext {
    viewer: string;
    messageContext: MessageContext;
}

export interface LocalAiComposerRequest {
    client: LocalAiComposerClient;
    prompt: string;
    attachment?: AttachmentContent;
    context: LocalAiChatMessage[];
    captured: CapturedLocalAiComposerContext;
    stillCurrent: () => boolean;
    // The normal composer send owns attachment upload and the visible user prompt. It must run
    // synchronously, before the first await, while its parent callback still belongs to this chat.
    onAccepted: () => void;
}

interface LocalAiComposerDependencies {
    contentToInput: typeof contentToInput;
    infer: (
        prompt: string,
        image?: Uint8Array,
        context?: LocalAiChatMessage[],
    ) => Promise<LocalAiResult>;
}

export interface LocalAiComposerRunner {
    readonly running: boolean;
    run: (request: LocalAiComposerRequest) => Promise<LocalAiComposerOutcome>;
}

export function captureLocalAiComposerContext(
    viewer: string,
    messageContext: MessageContext,
): CapturedLocalAiComposerContext {
    return {
        viewer,
        messageContext: {
            chatId: { ...messageContext.chatId },
            ...(messageContext.threadRootMessageIndex === undefined
                ? {}
                : { threadRootMessageIndex: messageContext.threadRootMessageIndex }),
        },
    };
}

export function localAiComposerContextIsCurrent(
    captured: CapturedLocalAiComposerContext,
    viewer: string,
    messageContext: MessageContext,
): boolean {
    return (
        captured.viewer === viewer && messageContextsEqual(captured.messageContext, messageContext)
    );
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function createLocalAiComposerRunner(
    overrides: Partial<LocalAiComposerDependencies> = {},
): LocalAiComposerRunner {
    const dependencies: LocalAiComposerDependencies = {
        contentToInput,
        infer: runLocalAiCommand,
        ...overrides,
    };
    let running = false;

    async function execute(request: LocalAiComposerRequest): Promise<LocalAiComposerOutcome> {
        try {
            if (!request.stillCurrent()) return { kind: "stale" };

            // Reserve the run before posting the visible prompt. `run` sets `running` synchronously,
            // so a second click/Enter cannot post another prompt while this request is in flight.
            request.onAccepted();

            let image: Uint8Array | undefined;
            if (request.attachment?.kind === "image_content") {
                const input = await dependencies.contentToInput(request.attachment, request.client);
                // Loading a settled image may cross the worker bridge. Never start a costly model
                // run, much less send its result, after the viewer/chat/thread has changed.
                if (!request.stillCurrent()) return { kind: "stale" };
                if (input?.image === undefined) {
                    return {
                        kind: "error",
                        error: "The staged image could not be read for local AI processing.",
                    };
                }
                image = input.image;
            }

            if (!request.stillCurrent()) return { kind: "stale" };
            const inference = await dependencies.infer(request.prompt, image, request.context);
            if (!request.stillCurrent()) return { kind: "stale" };
            if (inference.kind !== "ok") return inference;

            const reply = inference.reply.length > 0 ? inference.reply : "(no output)";
            // `captured.messageContext`, not the live Svelte prop, is the destination. The guard is
            // checked immediately before initiating the write so an account/chat switch cannot make
            // the selected model's output cross into a newly selected conversation.
            if (!request.stillCurrent()) return { kind: "stale" };
            const response = await request.client.sendMessageWithContent(
                request.captured.messageContext,
                { kind: "text_content", text: `🤖 ${reply}` },
                true,
                [],
                false,
            );
            if (!request.stillCurrent()) return { kind: "stale" };
            if (response.kind !== "success") {
                return {
                    kind: "error",
                    error: `could not post the AI response (${response.kind})`,
                };
            }
            return { kind: "sent" };
        } catch (error) {
            return request.stillCurrent()
                ? { kind: "error", error: errorMessage(error) }
                : { kind: "stale" };
        }
    }

    return {
        get running() {
            return running;
        },
        run(request) {
            if (running) return Promise.resolve({ kind: "busy" });
            running = true;
            return execute(request).finally(() => {
                running = false;
            });
        },
    };
}
