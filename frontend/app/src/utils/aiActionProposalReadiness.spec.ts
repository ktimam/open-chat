import { beforeEach, describe, expect, it, vi } from "vitest";

const { browserReadiness, genericReadiness, webRuntimeClient } = vi.hoisted(() => ({
    browserReadiness: vi.fn(),
    genericReadiness: vi.fn(),
    webRuntimeClient: vi.fn(),
}));

vi.mock("./onDeviceInference", () => ({
    onDeviceInferenceReadiness: genericReadiness,
    usesWebInferenceRuntime: webRuntimeClient,
}));

vi.mock("./webInference", () => ({
    browserImageModelFirstReadiness: browserReadiness,
}));

import { aiActionProposalReadiness } from "./aiActionProposalReadiness";

describe("AI-action proposal readiness", () => {
    beforeEach(() => {
        webRuntimeClient.mockReset();
        webRuntimeClient.mockReturnValue(true);
        browserReadiness.mockReset();
        genericReadiness.mockReset();
    });

    it("preserves stale-Qwen update guidance for a browser model-only image", async () => {
        const result = {
            available: false,
            reason: "The selected Qwen3-VL 2B model needs an update. Open On-device models and tap Retry download.",
        };
        browserReadiness.mockResolvedValue(result);

        await expect(aiActionProposalReadiness(true)).resolves.toEqual(result);
        expect(browserReadiness).toHaveBeenCalledWith({ retryAfterRecentFailure: true });
        expect(genericReadiness).not.toHaveBeenCalled();
    });

    it.each([
        ["browser text", false, false],
        ["native image", true, true],
    ])("uses generic native/model readiness for %s", async (_name, native, image) => {
        webRuntimeClient.mockReturnValue(!native);
        genericReadiness.mockResolvedValue({ available: true });

        await expect(aiActionProposalReadiness(image)).resolves.toEqual({ available: true });
        expect(genericReadiness).toHaveBeenCalledOnce();
        expect(browserReadiness).not.toHaveBeenCalled();
    });
});
