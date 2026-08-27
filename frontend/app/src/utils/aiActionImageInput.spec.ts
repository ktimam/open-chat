import type { MessageContent } from "@client";
import { expect, it, vi } from "vitest";

vi.mock("./aiActionAvailability", () => ({ appContentAttestationAvailable: () => false }));
vi.mock("./onDeviceInference", () => ({
    inferOnDevice: vi.fn(),
    onDeviceInferenceCapability: () => ({
        available: true,
        runtimesSupported: ["llama-cpp"],
        selectedModalities: ["text", "image"],
    }),
}));

import { contentToInput } from "./aiActionRunner";

it("turns a settled local image reference into model bytes through the OpenChat client", async () => {
    const canisterId = "ucwa4-rx777-77774-qaada-cai";
    const bytes = new Uint8Array([11, 12, 13]);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const downloadPublicBlob = vi.fn(async () => bytes);
    const content = {
        kind: "image_content",
        caption: "Reservation receipt",
        blobUrl: `http://${canisterId}.raw.localhost:8080/blobs/55`,
        blobReference: { canisterId, blobId: 55n },
    } as unknown as MessageContent;

    await expect(
        contentToInput(content, { downloadPublicBlob } as never, {
            protocol: "https:",
            hostname: "openchat-dev.example.ts.net",
        }),
    ).resolves.toEqual({ image: bytes, text: "Reservation receipt" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(downloadPublicBlob).toHaveBeenCalledWith({ canisterId, blobId: 55n }, 5 * 1024 * 1024);
});
