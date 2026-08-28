import { describe, expect, it, vi } from "vitest";
import { createSingleFlight } from "./singleFlight";

function deferred(): {
    promise: Promise<void>;
    resolve: () => void;
    reject: (reason: unknown) => void;
} {
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe("createSingleFlight", () => {
    it("runs concurrent triggers once, shares the promise, and releases after resolve", async () => {
        const firstGate = deferred();
        const task = vi
            .fn<() => Promise<void>>()
            .mockImplementationOnce(() => firstGate.promise)
            .mockResolvedValueOnce(undefined);
        const busy = vi.fn();
        const run = createSingleFlight(task, busy);

        const first = run();
        const duplicate = run();
        expect(duplicate).toBe(first);
        expect(busy).toHaveBeenCalledTimes(1);
        expect(busy).toHaveBeenLastCalledWith(true);
        await Promise.resolve();
        expect(task).toHaveBeenCalledTimes(1);

        firstGate.resolve();
        await first;
        expect(busy.mock.calls).toEqual([[true], [false]]);

        await run();
        expect(task).toHaveBeenCalledTimes(2);
    });

    it("releases after rejection so a later trigger can run", async () => {
        const firstGate = deferred();
        const task = vi
            .fn<() => Promise<void>>()
            .mockImplementationOnce(() => firstGate.promise)
            .mockResolvedValueOnce(undefined);
        const busy = vi.fn();
        const run = createSingleFlight(task, busy);

        const first = run();
        expect(run()).toBe(first);
        firstGate.reject(new Error("inference failed"));
        await expect(first).rejects.toThrow("inference failed");
        expect(busy.mock.calls).toEqual([[true], [false]]);

        await expect(run()).resolves.toBeUndefined();
        expect(task).toHaveBeenCalledTimes(2);
        expect(busy.mock.calls).toEqual([[true], [false], [true], [false]]);
    });
});
