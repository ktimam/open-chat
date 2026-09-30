// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import { createNativeAppDelivery, nativeDeliveryAllowed } from "./nativeAppDelivery";
import type { LocalDraftDeliveryRequest } from "./localAppDrafts";
import type {
    LocalAppHandoffStart,
    LocalAppHandoffStatus,
} from "tauri-plugin-oc-api/commands/localAppHandoff";

const now = 1_000_000;
const request: LocalDraftDeliveryRequest = Object.freeze({
    appId: "synthetic-app",
    actionId: "add",
    destination: "https://example.test/import",
    recipient: "Review in app",
    idempotencyKey: "a".repeat(43),
    payload: Object.freeze({ marker: "approved synthetic fields only" }),
});
const start = (): LocalAppHandoffStart => ({
    handoffId: "a".repeat(32),
    url: "http://localhost:41000/handoff",
    pairingCode: "A".repeat(20),
    claimExpiresAtMs: now + 120_000,
});
const status = (
    phase: LocalAppHandoffStatus["phase"] = "awaiting_claim",
): LocalAppHandoffStatus => ({
    phase,
    expiresAtMs: now + (phase === "awaiting_claim" ? 120_000 : 700_000),
    deliveryMayHaveOccurred: ["offered", "received", "saved"].includes(phase),
});
function fixture() {
    const deps = {
        begin: vi.fn(async () => start()),
        poll: vi.fn(async () => status()),
        cancel: vi.fn(async () => ({ deliveryMayHaveOccurred: false })),
        open: vi.fn(async (_url: string) => null),
        copy: vi.fn(async (_code: string) => {}),
        status: vi.fn(),
    };
    return { deps, adapter: createNativeAppDelivery(deps), abort: new AbortController() };
}
const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
};
async function receivedReplacementFixture() {
    const { adapter, deps, abort: previousAbort } = fixture();
    const replacementStart = {
        ...start(),
        handoffId: "b".repeat(32),
        pairingCode: "B".repeat(20),
        url: "http://localhost:41001/handoff",
    };
    deps.begin.mockResolvedValueOnce(start()).mockResolvedValueOnce(replacementStart);
    let finishPreviousPoll!: (result: LocalAppHandoffStatus) => void;
    deps.poll.mockResolvedValueOnce(status("received")).mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finishPreviousPoll = resolve;
            }),
    );
    const previous = adapter.deliver(request, previousAbort.signal);
    await flush();
    await expect(previous).resolves.toEqual({ kind: "delivered" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deps.begin).toHaveBeenCalledOnce();
    expect(deps.cancel).not.toHaveBeenCalled();
    expect(deps.poll.mock.calls).toEqual([[start().handoffId], [start().handoffId]]);
    const abort = new AbortController();
    const pending = adapter.deliver(request, abort.signal);
    await flush();
    return { adapter, deps, previousAbort, abort, pending, replacementStart, finishPreviousPoll };
}
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
});
afterEach(() => {
    window.dispatchEvent(new Event("pagehide"));
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("native private draft delivery", () => {
    it("does nothing before explicit confirmation, then sends only the exact approved JSON; copy/open remain separate", async () => {
        const { adapter, deps, abort } = fixture();
        expect(deps.begin).not.toHaveBeenCalled();
        const pending = adapter.deliver(request, abort.signal);
        await flush();
        expect(deps.begin).toHaveBeenCalledExactlyOnceWith({
            approvedRequestJson: JSON.stringify(request),
        });
        expect(get(adapter.pairing)?.pairingCode).toBe("A".repeat(20));
        expect(deps.copy).not.toHaveBeenCalled();
        expect(deps.open).not.toHaveBeenCalled();
        await adapter.copyCode("wrong-id");
        await adapter.openBrowser("wrong-id");
        expect(deps.copy).not.toHaveBeenCalled();
        expect(deps.open).not.toHaveBeenCalled();
        await adapter.copyCode(request.idempotencyKey);
        await adapter.openBrowser(request.idempotencyKey);
        expect(deps.copy).toHaveBeenCalledExactlyOnceWith("A".repeat(20));
        expect(deps.open).toHaveBeenCalledExactlyOnceWith("http://localhost:41000/handoff");
        expect(deps.open.mock.calls[0][0]).not.toContain("A".repeat(20));
        abort.abort();
        await expect(pending).resolves.toEqual({ kind: "uncertain" });
        expect(get(adapter.pairing)).toBeUndefined();
        expect(deps.cancel).toHaveBeenCalledOnce();
    });

    it("erases the code after claim; receipt settles delivery but saved remains app-reported separately", async () => {
        const { adapter, deps, abort } = fixture();
        const pending = adapter.deliver(request, abort.signal);
        await flush();
        deps.poll.mockResolvedValueOnce(status("reviewing"));
        await vi.advanceTimersByTimeAsync(1_000);
        expect(get(adapter.pairing)).toBeUndefined();
        await adapter.copyCode(request.idempotencyKey);
        await adapter.openBrowser(request.idempotencyKey);
        expect(deps.copy).not.toHaveBeenCalled();
        expect(deps.open).not.toHaveBeenCalled();
        deps.poll.mockResolvedValueOnce(status("received"));
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(pending).resolves.toEqual({ kind: "delivered" });
        expect(deps.status).toHaveBeenLastCalledWith({
            importId: request.idempotencyKey,
            status: "received",
        });
        expect(deps.cancel).not.toHaveBeenCalled();
        deps.poll.mockResolvedValueOnce(status("saved"));
        await vi.advanceTimersByTimeAsync(1_000);
        expect(deps.status).toHaveBeenLastCalledWith({
            importId: request.idempotencyKey,
            status: "saved",
        });
        expect(deps.cancel).toHaveBeenCalledOnce();
    });

    it.each(["saved", "rejected"] as const)(
        "replaces a received attempt only explicitly and ignores its late %s poll",
        async (latePhase) => {
            const { adapter, deps, previousAbort, pending, replacementStart, finishPreviousPoll } =
                await receivedReplacementFixture();
            expect(deps.begin.mock.calls).toEqual([
                [{ approvedRequestJson: JSON.stringify(request) }],
                [{ approvedRequestJson: JSON.stringify(request) }],
            ]);
            expect(deps.cancel).toHaveBeenCalledExactlyOnceWith(start().handoffId);
            expect(get(adapter.pairing)).toMatchObject({
                importId: request.idempotencyKey,
                handoffId: replacementStart.handoffId,
                pairingCode: replacementStart.pairingCode,
                url: replacementStart.url,
            });
            expect(deps.poll).toHaveBeenLastCalledWith(replacementStart.handoffId);
            expect(deps.status).toHaveBeenLastCalledWith({
                importId: request.idempotencyKey,
                status: "opening",
            });
            previousAbort.abort();
            expect(deps.cancel).toHaveBeenCalledOnce();
            deps.poll.mockResolvedValueOnce(status("received"));
            await vi.advanceTimersByTimeAsync(1_000);
            await expect(pending).resolves.toEqual({ kind: "delivered" });
            const statusCalls = deps.status.mock.calls.length;
            finishPreviousPoll(status(latePhase));
            await flush();
            expect(deps.status).toHaveBeenCalledTimes(statusCalls);
            expect(deps.status).toHaveBeenLastCalledWith({
                importId: request.idempotencyKey,
                status: "received",
            });
            expect(get(adapter.pairing)).toBeUndefined();
            expect(deps.cancel).toHaveBeenCalledOnce();
            deps.poll.mockResolvedValueOnce(status("saved"));
            await vi.advanceTimersByTimeAsync(1_000);
            expect(deps.status).toHaveBeenLastCalledWith({
                importId: request.idempotencyKey,
                status: "saved",
            });
            expect(deps.cancel.mock.calls).toEqual([
                [start().handoffId],
                [replacementStart.handoffId],
            ]);
            await vi.advanceTimersByTimeAsync(1_000_000);
            expect(deps.begin).toHaveBeenCalledTimes(2);
            expect(deps.copy).not.toHaveBeenCalled();
            expect(deps.open).not.toHaveBeenCalled();
        },
    );

    it.each([
        ["abort", "saved"],
        ["abort", "rejected"],
        ["account", "saved"],
        ["account", "rejected"],
    ] as const)(
        "does not revive a same-ID replacement after %s teardown and late %s polls",
        async (teardown, latePhase) => {
            const {
                adapter,
                deps,
                previousAbort,
                abort,
                pending,
                replacementStart,
                finishPreviousPoll,
            } = await receivedReplacementFixture();
            let finishReplacementPoll!: (result: LocalAppHandoffStatus) => void;
            deps.poll.mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        finishReplacementPoll = resolve;
                    }),
            );
            await vi.advanceTimersByTimeAsync(1_000);
            if (teardown === "abort") abort.abort();
            else adapter.cancelAll();
            await expect(pending).resolves.toEqual({ kind: "uncertain" });
            const statusCalls = deps.status.mock.calls.length;
            const pollCalls = deps.poll.mock.calls.length;
            finishPreviousPoll(status(latePhase));
            finishReplacementPoll(status(latePhase));
            previousAbort.abort();
            await flush();
            await vi.advanceTimersByTimeAsync(1_000_000);
            expect(get(adapter.pairing)).toBeUndefined();
            expect(deps.status).toHaveBeenCalledTimes(statusCalls);
            expect(deps.status).toHaveBeenLastCalledWith(
                teardown === "account"
                    ? undefined
                    : { importId: request.idempotencyKey, status: "uncertain" },
            );
            expect(deps.cancel.mock.calls).toEqual([
                [start().handoffId],
                [replacementStart.handoffId],
            ]);
            expect(deps.poll).toHaveBeenCalledTimes(pollCalls);
            expect(deps.begin).toHaveBeenCalledTimes(2);
            expect(deps.copy).not.toHaveBeenCalled();
            expect(deps.open).not.toHaveBeenCalled();
        },
    );

    it("never automatically retries a rejected begin or reports private errors", async () => {
        const { adapter, deps, abort } = fixture();
        deps.begin.mockRejectedValue(new Error("PRIVATE_NATIVE_ERROR"));
        await expect(adapter.deliver(request, abort.signal)).resolves.toEqual({
            kind: "uncertain",
        });
        await vi.advanceTimersByTimeAsync(1_000_000);
        expect(deps.begin).toHaveBeenCalledOnce();
        expect(deps.poll).not.toHaveBeenCalled();
        expect(JSON.stringify(deps.status.mock.calls)).not.toContain("PRIVATE_NATIVE_ERROR");
        expect(get(adapter.pairing)).toBeUndefined();
    });

    it("cancels a late begin response after logout without resurrecting the bearer code", async () => {
        const { adapter, deps, abort } = fixture();
        let finish!: (result: LocalAppHandoffStart) => void;
        deps.begin.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const pending = adapter.deliver(request, abort.signal);
        adapter.cancelAll();
        await expect(pending).resolves.toEqual({ kind: "uncertain" });
        finish(start());
        await flush();
        expect(get(adapter.pairing)).toBeUndefined();
        expect(deps.cancel).toHaveBeenCalledExactlyOnceWith("a".repeat(32));
        expect(deps.poll).not.toHaveBeenCalled();
        expect(deps.status).toHaveBeenLastCalledWith(undefined);
    });

    it("ignores a late poll after teardown/pagehide and cancels native even while IPC is in flight", async () => {
        const { adapter, deps, abort } = fixture();
        let finish!: (result: LocalAppHandoffStatus) => void;
        deps.poll.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const pending = adapter.deliver(request, abort.signal);
        await flush();
        window.dispatchEvent(new Event("pagehide"));
        await expect(pending).resolves.toEqual({ kind: "uncertain" });
        finish(status("saved"));
        await flush();
        expect(get(adapter.pairing)).toBeUndefined();
        expect(deps.status).toHaveBeenLastCalledWith({
            importId: request.idempotencyKey,
            status: "uncertain",
        });
        expect(deps.cancel).toHaveBeenCalledOnce();
    });

    it("clears expired pairing even if IPC hangs and closes at the total lifetime limit", async () => {
        const { adapter, deps, abort } = fixture();
        deps.poll.mockImplementationOnce(() => new Promise(() => {}));
        const pending = adapter.deliver(request, abort.signal);
        await flush();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(get(adapter.pairing)).toBeUndefined();
        await vi.advanceTimersByTimeAsync(600_000);
        await expect(pending).resolves.toEqual({ kind: "uncertain" });
        expect(deps.cancel).toHaveBeenCalledOnce();
    });

    it.each([
        "https://localhost:41000/handoff",
        "http://127.0.0.1:41000/handoff",
        "http://localhost:80/handoff",
        "http://localhost:41000/handoff?code=hidden",
        "http://localhost:41000/handoff#hidden",
        "http://user@localhost:41000/handoff",
        "https://example.test/handoff",
    ])("rejects an unsafe or unexpected browser URL: %s", async (url) => {
        const { adapter, deps, abort } = fixture();
        deps.begin.mockResolvedValueOnce({ ...start(), url });
        await expect(adapter.deliver(request, abort.signal)).resolves.toEqual({
            kind: "uncertain",
        });
        expect(get(adapter.pairing)).toBeUndefined();
        expect(deps.open).not.toHaveBeenCalled();
        expect(deps.cancel).toHaveBeenCalledOnce();
    });

    it("rejects regressing or inconsistent native phase responses", async () => {
        const { adapter, deps, abort } = fixture();
        deps.poll
            .mockResolvedValueOnce(status("reviewing"))
            .mockResolvedValueOnce(status("awaiting_claim"));
        const pending = adapter.deliver(request, abort.signal);
        await flush();
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(pending).resolves.toEqual({ kind: "uncertain" });
        expect(deps.cancel).toHaveBeenCalledOnce();
    });

    it("does not start on an already aborted signal", async () => {
        const { adapter, deps, abort } = fixture();
        abort.abort();
        await expect(adapter.deliver(request, abort.signal)).resolves.toEqual({
            kind: "uncertain",
        });
        expect(deps.begin).not.toHaveBeenCalled();
    });

    it("requires native private-app capability, independent of the authentication implementation", () => {
        const enabled = {
            isNativeApp: () => true,
            clientOnlyApps: () => true,
        };
        expect(nativeDeliveryAllowed(enabled)).toBe(true);
        expect(
            nativeDeliveryAllowed({
                ...enabled,
                existingAccountOnly: () => false,
            } as typeof enabled),
        ).toBe(true);
        for (const key of Object.keys(enabled))
            expect(nativeDeliveryAllowed({ ...enabled, [key]: () => false })).toBe(false);
        expect(nativeDeliveryAllowed(undefined)).toBe(false);
    });
});
