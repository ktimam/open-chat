import { describe, expect, it, vi } from "vitest";
import { cancelAiAppLinkConsent } from "./aiAppLinkConsent";

describe("explicit AI-app link cancellation", () => {
    it("waits for in-flight code creation, cancels only that token, and never disconnects", async () => {
        let finishCreate!: () => void;
        const pendingCreate = new Promise<void>((resolve) => {
            finishCreate = resolve;
        });
        const cancelAiAppLinkCode = vi.fn(async () => true);
        const removeMyAiAppKey = vi.fn(async () => true);
        const client = { cancelAiAppLinkCode, removeMyAiAppKey };

        const cancelling = cancelAiAppLinkConsent(client, "ab".repeat(32), pendingCreate);
        await Promise.resolve();
        expect(cancelAiAppLinkCode).not.toHaveBeenCalled();
        expect(removeMyAiAppKey).not.toHaveBeenCalled();

        finishCreate();
        await expect(cancelling).resolves.toBeUndefined();
        expect(cancelAiAppLinkCode).toHaveBeenCalledOnce();
        expect(cancelAiAppLinkCode).toHaveBeenCalledWith("ab".repeat(32));
        expect(removeMyAiAppKey).not.toHaveBeenCalled();
    });

    it("reads the token after the pending create finishes", async () => {
        let token: string | undefined;
        const pendingCreate = Promise.resolve().then(() => {
            token = "ef".repeat(32);
        });
        const cancelAiAppLinkCode = vi.fn(async () => true);
        const removeMyAiAppKey = vi.fn(async () => true);

        await expect(
            cancelAiAppLinkConsent(
                { cancelAiAppLinkCode, removeMyAiAppKey },
                () => token,
                pendingCreate,
            ),
        ).resolves.toBeUndefined();
        expect(cancelAiAppLinkCode).toHaveBeenCalledWith("ef".repeat(32));
        expect(removeMyAiAppKey).not.toHaveBeenCalled();
    });

    it("does not turn an ambiguous create response into a disconnect", async () => {
        const cancelAiAppLinkCode = vi.fn(async () => true);
        const removeMyAiAppKey = vi.fn(async () => true);
        await expect(
            cancelAiAppLinkConsent(
                { cancelAiAppLinkCode, removeMyAiAppKey },
                undefined,
                Promise.reject(new Error("response lost")),
            ),
        ).resolves.toBeUndefined();
        expect(cancelAiAppLinkCode).not.toHaveBeenCalled();
        expect(removeMyAiAppKey).not.toHaveBeenCalled();
    });

    it("never blocks close when exact-token cancellation is rejected or throws", async () => {
        const removeMyAiAppKey = vi.fn();
        await expect(
            cancelAiAppLinkConsent(
                { cancelAiAppLinkCode: vi.fn(async () => false), removeMyAiAppKey },
                "cd".repeat(32),
            ),
        ).resolves.toBeUndefined();
        await expect(
            cancelAiAppLinkConsent(
                {
                    cancelAiAppLinkCode: vi.fn(async () => Promise.reject()),
                    removeMyAiAppKey,
                },
                "cd".repeat(32),
            ),
        ).resolves.toBeUndefined();
        expect(removeMyAiAppKey).not.toHaveBeenCalled();
    });
});
