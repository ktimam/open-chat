import type { MessageContent } from "@client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./aiActionAvailability", () => ({ appContentAttestationAvailable: () => false }));
vi.mock("./onDeviceInference", () => ({
    inferOnDevice: vi.fn(),
    onDeviceInferenceCapability: () => ({
        available: true,
        runtimesSupported: ["transformers-webgpu"],
        selectedModalities: ["text", "image", "audio"],
    }),
}));

import { contentToInput } from "./aiActionRunner";
import {
    MAX_LOCAL_AI_AUDIO_BYTES,
    MAX_LOCAL_AI_AUDIO_DURATION_MS,
    localAudioInput,
} from "./localAudioInput";

afterEach(() => vi.restoreAllMocks());

function voice(overrides: Record<string, unknown> = {}): MessageContent {
    return {
        kind: "audio_content",
        caption: "voice note",
        mimeType: "audio/webm;codecs=opus",
        samples: new Uint8Array([1, 2]),
        durationMs: 2_000n,
        ...overrides,
    } as unknown as MessageContent;
}

describe("selected voice-message input", () => {
    it("does not broaden the app-action content path unless local audio is explicitly requested", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");

        await expect(
            contentToInput(voice({ blobData: new Uint8Array([9]) })),
        ).resolves.toBeUndefined();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("uses bounded inline voice bytes and preserves their MIME and caption", async () => {
        const bytes = new Uint8Array([11, 12, 13]);
        const fetchSpy = vi.spyOn(globalThis, "fetch");

        await expect(
            contentToInput(voice({ blobData: bytes }), undefined, undefined, undefined, {
                includeAudio: true,
            }),
        ).resolves.toEqual({
            audio: bytes,
            audioMimeType: "audio/webm;codecs=opus",
            text: "voice note",
        });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("accepts 30,000 ms and fails closed at 30,001 ms", async () => {
        const bytes = new Uint8Array([14, 15]);

        await expect(
            localAudioInput(voice({ blobData: bytes, durationMs: MAX_LOCAL_AI_AUDIO_DURATION_MS })),
        ).resolves.toEqual({
            audio: bytes,
            audioMimeType: "audio/webm;codecs=opus",
        });
        await expect(
            localAudioInput(
                voice({ blobData: bytes, durationMs: MAX_LOCAL_AI_AUDIO_DURATION_MS + 1n }),
            ),
        ).resolves.toBeUndefined();
    });

    it("streams a displayable voice URL into bounded local bytes", async () => {
        const bytes = new Uint8Array([21, 22, 23, 24]);
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(bytes, {
                status: 200,
                headers: { "Content-Length": String(bytes.byteLength) },
            }),
        );

        await expect(
            contentToInput(
                voice({ blobUrl: "https://media.example/voice.webm" }),
                undefined,
                { protocol: "https:", hostname: "chat.example" },
                undefined,
                { includeAudio: true },
            ),
        ).resolves.toEqual({
            audio: bytes,
            audioMimeType: "audio/webm;codecs=opus",
            text: "voice note",
        });
    });

    it("uses the authenticated OpenChat blob loader when HTTPS cannot fetch a local blob host", async () => {
        const canisterId = "ucwa4-rx777-77774-qaada-cai";
        const bytes = new Uint8Array([31, 32]);
        const downloadPublicBlob = vi.fn(async () => bytes);
        const fetchSpy = vi.spyOn(globalThis, "fetch");

        await expect(
            contentToInput(
                voice({
                    blobUrl: `http://${canisterId}.raw.localhost:8080/blobs/55`,
                    blobReference: { canisterId, blobId: 55n },
                }),
                { downloadPublicBlob } as never,
                { protocol: "https:", hostname: "openchat-dev.example.ts.net" },
                "http://{canisterId}.raw.localhost:8080/{blobType}",
                { includeAudio: true },
            ),
        ).resolves.toEqual({
            audio: bytes,
            audioMimeType: "audio/webm;codecs=opus",
            text: "voice note",
        });
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(downloadPublicBlob).toHaveBeenCalledWith(
            { canisterId, blobId: 55n },
            MAX_LOCAL_AI_AUDIO_BYTES,
        );
    });

    it("fails closed for missing bytes, non-audio MIME, excessive duration, and oversized fetch metadata", async () => {
        await expect(
            contentToInput(voice(), undefined, undefined, undefined, { includeAudio: true }),
        ).resolves.toBeUndefined();
        await expect(
            localAudioInput(voice({ blobData: new Uint8Array([1]), mimeType: "text/html" })),
        ).resolves.toBeUndefined();
        await expect(
            localAudioInput(
                voice({
                    blobData: new Uint8Array([1]),
                    durationMs: MAX_LOCAL_AI_AUDIO_DURATION_MS + 1n,
                }),
            ),
        ).resolves.toBeUndefined();

        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(new Uint8Array([1]), {
                status: 200,
                headers: { "Content-Length": String(MAX_LOCAL_AI_AUDIO_BYTES + 1) },
            }),
        );
        await expect(
            localAudioInput(voice({ blobUrl: "https://media.example/oversized.webm" })),
        ).resolves.toBeUndefined();
    });
});
