import { describe, expect, it, vi } from "vitest";
import { runLocalAiMessageFlow, type LocalAiMessageFlowDeps } from "./localAiMessageFlow";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
}

function deps(overrides: Partial<LocalAiMessageFlowDeps> = {}): LocalAiMessageFlowDeps {
    return {
        readInput: vi.fn(async () => ({ text: "hello" })),
        unsupportedMessage: () => "unsupported",
        promptFor: () => "analyze",
        contextFor: (input) => [{ author: "Alice", text: input.text }],
        infer: vi.fn(async () => ({ kind: "ok" as const, reply: "answer" })),
        sendReply: vi.fn(async () => ({ kind: "success" })),
        stillCurrent: () => true,
        ...overrides,
    };
}

describe("selected-message local AI lifecycle", () => {
    it("does not start WebGPU after an image read becomes stale", async () => {
        const read = deferred<{ image: Uint8Array }>();
        let current = true;
        const testDeps = deps({ readInput: () => read.promise, stillCurrent: () => current });

        const pending = runLocalAiMessageFlow(testDeps);
        current = false;
        read.resolve({ image: new Uint8Array([1, 2, 3]) });

        await expect(pending).resolves.toEqual({ kind: "stale" });
        expect(testDeps.infer).not.toHaveBeenCalled();
        expect(testDeps.sendReply).not.toHaveBeenCalled();
    });

    it("does not post after the account or chat changes during inference", async () => {
        const inference = deferred<{ kind: "ok"; reply: string }>();
        let current = true;
        const testDeps = deps({ infer: () => inference.promise, stillCurrent: () => current });

        const pending = runLocalAiMessageFlow(testDeps);
        await vi.waitFor(() => expect(testDeps.readInput).toHaveBeenCalledOnce());
        current = false;
        inference.resolve({ kind: "ok", reply: "private answer" });

        await expect(pending).resolves.toEqual({ kind: "stale" });
        expect(testDeps.sendReply).not.toHaveBeenCalled();
    });

    it("awaits the send and reports a rejected post", async () => {
        const send = deferred<{ kind: string }>();
        const testDeps = deps({ sendReply: () => send.promise });
        const pending = runLocalAiMessageFlow(testDeps);
        send.resolve({ kind: "not_authorized" });

        await expect(pending).resolves.toEqual({
            kind: "error",
            message: "On-device AI failed: could not post the AI response (not_authorized)",
        });
    });

    it("posts one prefixed reply after a successful result", async () => {
        const testDeps = deps();
        await expect(runLocalAiMessageFlow(testDeps)).resolves.toEqual({
            kind: "success",
            message: "AI response added.",
        });
        expect(testDeps.sendReply).toHaveBeenCalledOnce();
        expect(testDeps.sendReply).toHaveBeenCalledWith("🤖 answer");
    });

    it("passes encoded voice bytes and MIME through the same stale-safe inference boundary", async () => {
        const audio = new Uint8Array([8, 9, 10]);
        const testDeps = deps({
            readInput: vi.fn(async () => ({
                text: "voice caption",
                audio,
                audioMimeType: "audio/webm;codecs=opus",
            })),
            promptFor: () => "transcribe",
            contextFor: (input) => [
                {
                    author: "Alice",
                    text: input.text,
                    hasAudio: input.audio !== undefined,
                    audioIncluded: input.audio !== undefined,
                },
            ],
        });

        await expect(runLocalAiMessageFlow(testDeps)).resolves.toEqual({
            kind: "success",
            message: "AI response added.",
        });
        expect(testDeps.infer).toHaveBeenCalledWith(
            "transcribe",
            undefined,
            [
                {
                    author: "Alice",
                    text: "voice caption",
                    hasAudio: true,
                    audioIncluded: true,
                },
            ],
            audio,
            "audio/webm;codecs=opus",
        );
    });

    it("reports an unreadable voice message without starting inference or posting", async () => {
        const testDeps = deps({
            readInput: vi.fn(async () => undefined),
            unsupportedMessage: () =>
                "The selected voice message could not be read for local AI processing.",
        });

        await expect(runLocalAiMessageFlow(testDeps)).resolves.toEqual({
            kind: "error",
            message:
                "On-device AI failed: The selected voice message could not be read for local AI processing.",
        });
        expect(testDeps.infer).not.toHaveBeenCalled();
        expect(testDeps.sendReply).not.toHaveBeenCalled();
    });
});
