import type { AttachmentContent, MessageContext } from "@client";
import { afterEach, describe, expect, it, vi } from "vitest";

// `contentToInput` currently lives in the action orchestrator, whose other branches import the full
// model runtime. Keep this focused composer test on the input seam without loading Wllama/WebGPU.
vi.mock("./onDeviceInference", () => ({
    inferOnDevice: vi.fn(),
    inferOnDeviceTextOnlyNoProjector: vi.fn(),
    isNativeClient: () => false,
    onDeviceInferenceCapability: () => ({
        available: true,
        runtimesSupported: ["transformers-webgpu"],
        selectedModalities: ["text", "image"],
    }),
}));
vi.mock("./webInference", () => ({
    browserImageModelFirstReadiness: vi.fn(),
    webImageInferenceEvidence: vi.fn(),
    webModelCatalogId: vi.fn(),
}));

import {
    captureLocalAiComposerContext,
    createLocalAiComposerRunner,
    localAiComposerContextIsCurrent,
    type LocalAiComposerRequest,
} from "./localAiComposer";

const CHAT_A = {
    chatId: { kind: "direct_chat", userId: "chat-a" },
    threadRootMessageIndex: 9,
} as MessageContext;
const CHAT_B = {
    chatId: { kind: "direct_chat", userId: "chat-b" },
} as MessageContext;

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

function request(
    client: {
        downloadPublicBlob: ReturnType<typeof vi.fn>;
        sendMessageWithContent: ReturnType<typeof vi.fn>;
    },
    overrides: Partial<LocalAiComposerRequest> = {},
): LocalAiComposerRequest {
    const captured = captureLocalAiComposerContext("viewer-a", CHAT_A);
    return {
        client: client as never,
        prompt: "summarize this chat",
        context: [
            { author: "Mickey", text: "Reservation is 1-10 August" },
            { author: "Alex", text: "The price is 700 USD" },
        ],
        captured,
        stillCurrent: () => true,
        onAccepted: vi.fn(),
        ...overrides,
    };
}

function client(sendResult: { kind: string } = { kind: "success" }) {
    return {
        downloadPublicBlob: vi.fn(),
        sendMessageWithContent: vi.fn(async () => sendResult),
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("local AI composer context capture", () => {
    it("distinguishes the exact captured viewer, chat, and thread", () => {
        const captured = captureLocalAiComposerContext("viewer-a", CHAT_A);

        expect(localAiComposerContextIsCurrent(captured, "viewer-a", CHAT_A)).toBe(true);
        expect(localAiComposerContextIsCurrent(captured, "viewer-b", CHAT_A)).toBe(false);
        expect(localAiComposerContextIsCurrent(captured, "viewer-a", CHAT_B)).toBe(false);
        expect(
            localAiComposerContextIsCurrent(captured, "viewer-a", {
                ...CHAT_A,
                threadRootMessageIndex: 10,
            }),
        ).toBe(false);
    });
});

describe("local AI composer runner", () => {
    it.each(["account", "chat"] as const)(
        "drops a deferred model result after the %s changes",
        async (changed) => {
            const inference = deferred<{ kind: "ok"; reply: string }>();
            const api = client();
            let viewer = "viewer-a";
            let currentContext = CHAT_A;
            const captured = captureLocalAiComposerContext(viewer, currentContext);
            const runner = createLocalAiComposerRunner({ infer: () => inference.promise });

            const pending = runner.run(
                request(api, {
                    captured,
                    stillCurrent: () =>
                        localAiComposerContextIsCurrent(captured, viewer, currentContext),
                }),
            );
            if (changed === "account") viewer = "viewer-b";
            else currentContext = CHAT_B;
            inference.resolve({ kind: "ok", reply: "private result" });

            await expect(pending).resolves.toEqual({ kind: "stale" });
            expect(api.sendMessageWithContent).not.toHaveBeenCalled();
        },
    );

    it("uses one single flight and does not accept a second visible prompt", async () => {
        const inference = deferred<{ kind: "ok"; reply: string }>();
        const api = client();
        const runner = createLocalAiComposerRunner({ infer: () => inference.promise });
        const firstAccepted = vi.fn();
        const secondAccepted = vi.fn();

        const first = runner.run(request(api, { onAccepted: firstAccepted }));
        await expect(runner.run(request(api, { onAccepted: secondAccepted }))).resolves.toEqual({
            kind: "busy",
        });
        expect(runner.running).toBe(true);
        expect(firstAccepted).toHaveBeenCalledOnce();
        expect(secondAccepted).not.toHaveBeenCalled();

        inference.resolve({ kind: "ok", reply: "done" });
        await expect(first).resolves.toEqual({ kind: "sent" });
        expect(runner.running).toBe(false);
    });

    it("forwards both in-memory and settled URL image bytes with bounded chat context", async () => {
        const inline = new Uint8Array([1, 2, 3]);
        const settled = new Uint8Array([4, 5, 6]);
        const infer = vi.fn(async () => ({ kind: "ok", reply: "read" }) as const);
        const api = client();
        const fetchImage = vi.fn(
            async () =>
                new Response(settled, {
                    status: 200,
                    headers: { "content-length": String(settled.byteLength) },
                }),
        );
        vi.stubGlobal("fetch", fetchImage);
        const runner = createLocalAiComposerRunner({ infer });

        await expect(
            runner.run(
                request(api, {
                    attachment: {
                        kind: "image_content",
                        blobData: inline,
                    } as AttachmentContent,
                }),
            ),
        ).resolves.toEqual({ kind: "sent" });
        await expect(
            runner.run(
                request(api, {
                    attachment: {
                        kind: "image_content",
                        blobUrl: "https://openchat.example/settled-image.jpg",
                    } as AttachmentContent,
                }),
            ),
        ).resolves.toEqual({ kind: "sent" });

        expect(infer).toHaveBeenNthCalledWith(
            1,
            "summarize this chat",
            inline,
            expect.arrayContaining([{ author: "Mickey", text: "Reservation is 1-10 August" }]),
        );
        expect(infer).toHaveBeenNthCalledWith(
            2,
            "summarize this chat",
            settled,
            expect.arrayContaining([{ author: "Alex", text: "The price is 700 USD" }]),
        );
        expect(fetchImage).toHaveBeenCalledWith(
            "https://openchat.example/settled-image.jpg",
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
    });

    it("posts only to the captured context and reports a rejected reply send", async () => {
        const api = client({ kind: "failure" });
        const runner = createLocalAiComposerRunner({
            infer: async () => ({ kind: "ok", reply: "answer" }),
        });
        const captured = captureLocalAiComposerContext("viewer-a", CHAT_A);

        await expect(runner.run(request(api, { captured }))).resolves.toEqual({
            kind: "error",
            error: "could not post the AI response (failure)",
        });
        expect(api.sendMessageWithContent).toHaveBeenCalledWith(
            captured.messageContext,
            { kind: "text_content", text: "🤖 answer" },
            true,
            [],
            false,
        );
        expect(captured.messageContext).not.toBe(CHAT_A);
    });

    it("does not start WebGPU inference after a deferred image load becomes stale", async () => {
        const bytes = deferred<{ text?: string; image?: Uint8Array } | undefined>();
        const infer = vi.fn(async () => ({ kind: "ok", reply: "should not run" }) as const);
        const api = client();
        let current = true;
        const runner = createLocalAiComposerRunner({
            contentToInput: () => bytes.promise,
            infer,
        });
        const pending = runner.run(
            request(api, {
                attachment: {
                    kind: "image_content",
                    blobData: new Uint8Array([1]),
                } as AttachmentContent,
                stillCurrent: () => current,
            }),
        );

        current = false;
        bytes.resolve({ image: new Uint8Array([1]) });
        await expect(pending).resolves.toEqual({ kind: "stale" });
        expect(infer).not.toHaveBeenCalled();
        expect(api.sendMessageWithContent).not.toHaveBeenCalled();
    });
});
