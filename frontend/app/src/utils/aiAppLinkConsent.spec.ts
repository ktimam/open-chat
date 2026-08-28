import { describe, expect, it, vi } from "vitest";
import { aiAppLinkCompleted, cancelAiAppLinkConsent } from "./aiAppLinkConsent";

describe("AI-app link completion", () => {
    const current = [{ appId: 7, publicKey: "current-key", keyVersion: 4n }];

    it("accepts a non-empty key for first-time Connect, including a rolling legacy response", () => {
        expect(aiAppLinkCompleted(current, 7)).toBe(true);
        expect(aiAppLinkCompleted([{ appId: 7, publicKey: "legacy", keyVersion: 0n }], 7)).toBe(
            true,
        );
        expect(aiAppLinkCompleted([{ appId: 7, publicKey: "", keyVersion: 5n }], 7)).toBe(false);
    });

    it("requires a higher epoch for recovery and accepts reuse of the same PEM", () => {
        const previous = { publicKey: "current-key", keyVersion: 4n };
        expect(aiAppLinkCompleted(current, 7, previous)).toBe(false);
        expect(
            aiAppLinkCompleted(
                [{ appId: 7, publicKey: "current-key", keyVersion: 5n }],
                7,
                previous,
            ),
        ).toBe(true);
        expect(
            aiAppLinkCompleted(
                [{ appId: 7, publicKey: "rotated-key", keyVersion: 4n }],
                7,
                previous,
            ),
        ).toBe(false);
    });

    it("requires a first authoritative epoch when recovery began with no key", () => {
        const absent = { publicKey: "", keyVersion: 0n };
        expect(
            aiAppLinkCompleted([{ appId: 7, publicKey: "new-key", keyVersion: 0n }], 7, absent),
        ).toBe(false);
        expect(
            aiAppLinkCompleted([{ appId: 7, publicKey: "new-key", keyVersion: 1n }], 7, absent),
        ).toBe(true);
    });

    it("does not accept another app's newer binding", () => {
        expect(
            aiAppLinkCompleted(
                [{ appId: 8, publicKey: "new-key", keyVersion: 5n }],
                7,
                { publicKey: "current-key", keyVersion: 4n },
            ),
        ).toBe(false);
    });
});

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
