import { describe, expect, it, vi } from "vitest";
import { cancelAiAppLinkConsent } from "./aiAppLinkConsent";

describe("explicit AI-app link cancellation", () => {
    it("waits for in-flight code creation before invalidating the app tuple", async () => {
        let finishCreate!: () => void;
        const pendingCreate = new Promise<void>((resolve) => {
            finishCreate = resolve;
        });
        const removeMyAiAppKey = vi.fn(async () => true);

        const cancelling = cancelAiAppLinkConsent({ removeMyAiAppKey }, 17, pendingCreate);
        await Promise.resolve();
        expect(removeMyAiAppKey).not.toHaveBeenCalled();

        finishCreate();
        await expect(cancelling).resolves.toBe(true);
        expect(removeMyAiAppKey).toHaveBeenCalledOnce();
        expect(removeMyAiAppKey).toHaveBeenCalledWith(17);
    });

    it("still invalidates after an ambiguous/failed create response", async () => {
        const removeMyAiAppKey = vi.fn(async () => true);
        await expect(
            cancelAiAppLinkConsent(
                { removeMyAiAppKey },
                17,
                Promise.reject(new Error("response lost")),
            ),
        ).resolves.toBe(true);
        expect(removeMyAiAppKey).toHaveBeenCalledWith(17);
    });

    it("fails closed when tuple invalidation is rejected or throws", async () => {
        await expect(
            cancelAiAppLinkConsent({ removeMyAiAppKey: vi.fn(async () => false) }, 17),
        ).resolves.toBe(false);
        await expect(
            cancelAiAppLinkConsent({ removeMyAiAppKey: vi.fn(async () => Promise.reject()) }, 17),
        ).resolves.toBe(false);
    });
});
