import { afterEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import {
    cancelLocalAppHandoffs,
    deliverLocalAppViaRelay,
    localAppDeliveryStatus,
} from "./localAppRelayDelivery";
import type { LocalDraftDeliveryRequest } from "./localAppDrafts";
import { encryptedRequestFixture } from "./localAppEncryption.testFixtures";
// Lifecycle tests stub only sealing; real crypto/transport boundary is covered without mocks separately.
vi.mock("./localAppEncryption", async (original) => {
    const actual = await original<typeof import("./localAppEncryption")>();
    const { encryptedRequestFixture: fixture } = await import("./localAppEncryption.testFixtures");
    return {
        ...actual,
        sealLocalAppDelivery: vi.fn(async (r: LocalDraftDeliveryRequest) =>
            fixture({
                appId: r.appId,
                actionId: r.actionId,
                destination: r.destination,
                idempotencyKey: r.idempotencyKey,
            }),
        ),
    };
});

const request: LocalDraftDeliveryRequest = Object.freeze({
    appId: "example",
    actionId: "record",
    destination: "https://app.example/import",
    recipient: "Review in app",
    idempotencyKey: "B".repeat(42) + "A",
    payload: Object.freeze({ reading: 42, note: "SYNTHETIC_APPROVED_MARKER" }),
});
const encryptedRequest = encryptedRequestFixture({
    appId: request.appId,
    actionId: request.actionId,
    destination: request.destination,
    idempotencyKey: request.idempotencyKey,
});

function fixture() {
    const listeners = new Map<string, () => void>();
    const channels: FakeChannel[] = [];
    class FakeChannel {
        onmessage?: (event: { data: unknown }) => void;
        onmessageerror?: () => void;
        postMessage = vi.fn();
        close = vi.fn();
        constructor(readonly name: string) {
            channels.push(this);
        }
    }
    const open = vi.fn().mockReturnValue({});
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    vi.stubGlobal("location", { origin: "https://client.example" });
    vi.stubGlobal("window", {
        open,
        addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
        removeEventListener: (name: string) => listeners.delete(name),
    });
    const controller = new AbortController();
    const result = deliverLocalAppViaRelay(request, controller.signal);
    const channel = channels[0];
    const nonce = channel.name.split(":")[1];
    const emit = async (type: string, rest: object = {}) => {
        channel.onmessage?.({ data: { type, version: 1, sessionNonce: nonce, ...rest } });
        for (let i = 0; i < 8; i++) await Promise.resolve();
    };
    return { channel, channels, nonce, open, result, controller, listeners, emit };
}

afterEach(() => {
    cancelLocalAppHandoffs();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("confirmed local relay delivery lifecycle", () => {
    it("puts no payload in URLs and sends the approved request once after a bound ready", async () => {
        const f = fixture();
        expect(JSON.stringify(f.open.mock.calls)).not.toContain("SYNTHETIC_APPROVED_MARKER");
        expect(f.channel.postMessage).not.toHaveBeenCalled();
        await f.emit("relay-ready", { sessionNonce: "wrong" });
        expect(f.channel.postMessage).not.toHaveBeenCalled();
        await f.emit("relay-ready");
        await f.emit("relay-ready");
        expect(f.channel.postMessage).toHaveBeenCalledTimes(1);
        expect(f.channel.postMessage.mock.calls[0][0]).toMatchObject({
            type: "relay-approved",
            request: encryptedRequest,
        });
        f.controller.abort();
        expect(await f.result).toEqual({ kind: "uncertain" });
    });
    it("cancels a live relay on decoding failure before receipt and ignores late messages", async () => {
        const f = fixture();
        await f.emit("relay-ready");
        f.channel.onmessageerror?.();
        expect(await f.result).toEqual({ kind: "uncertain" });
        expect(f.channel.postMessage.mock.calls.at(-1)?.[0].type).toBe("relay-cancel");
        expect(f.channel.close).toHaveBeenCalledOnce();
        f.emit("relay-outcome", { outcome: "received", importId: request.idempotencyKey });
        expect(get(localAppDeliveryStatus)?.status).toBe("uncertain");
        expect(f.listeners.has("pagehide")).toBe(false);
    });
    it("stops the relay on host navigation without reconnecting or retrying", async () => {
        const f = fixture();
        await f.emit("relay-ready");
        f.listeners.get("pagehide")?.();
        expect(await f.result).toEqual({ kind: "uncertain" });
        expect(f.channel.postMessage.mock.calls.map(([message]) => message.type)).toEqual([
            "relay-approved",
            "relay-cancel",
        ]);
        await f.emit("relay-ready");
        expect(f.channel.postMessage).toHaveBeenCalledTimes(2);
    });
    it("preserves received-not-saved after communication loss", async () => {
        const f = fixture();
        await f.emit("relay-ready");
        f.emit("relay-outcome", { outcome: "received", importId: request.idempotencyKey });
        expect(await f.result).toEqual({ kind: "delivered" });
        f.channel.onmessageerror?.();
        expect(get(localAppDeliveryStatus)?.status).toBe("received");
        expect(f.channel.close).toHaveBeenCalledOnce();
        f.emit("relay-outcome", { outcome: "saved", importId: request.idempotencyKey });
        expect(get(localAppDeliveryStatus)?.status).toBe("received");
    });
    it("starts a fresh relay only on an explicit second delivery of the same approved import", async () => {
        vi.useFakeTimers();
        const f = fixture();
        await f.emit("relay-ready");
        f.emit("relay-outcome", { outcome: "received", importId: request.idempotencyKey });
        expect(await f.result).toEqual({ kind: "delivered" });
        expect(get(localAppDeliveryStatus)).toEqual({
            importId: request.idempotencyKey,
            status: "received",
        });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(f.open).toHaveBeenCalledTimes(1);
        expect(f.channels).toHaveLength(1);
        expect(f.channel.postMessage).toHaveBeenCalledTimes(1);
        expect(f.channel.close).not.toHaveBeenCalled();

        const retryController = new AbortController();
        const retryResult = deliverLocalAppViaRelay(request, retryController.signal);
        const retryChannel = f.channels[1];
        const retryNonce = retryChannel.name.split(":")[1];
        const emitRetry = async (type: string, rest: object = {}) => {
            retryChannel.onmessage?.({
                data: { type, version: 1, sessionNonce: retryNonce, ...rest },
            });
            for (let i = 0; i < 8; i++) await Promise.resolve();
        };
        expect(f.channel.postMessage.mock.calls.map(([message]) => message)).toEqual([
            {
                type: "relay-approved",
                version: 1,
                sessionNonce: f.nonce,
                request: encryptedRequest,
            },
            { type: "relay-cancel", version: 1, sessionNonce: f.nonce },
        ]);
        expect(f.channel.close).toHaveBeenCalledOnce();
        expect(f.channels).toHaveLength(2);
        expect(retryChannel).not.toBe(f.channel);
        expect(retryChannel.name).not.toBe(f.channel.name);
        expect(retryNonce).not.toBe(f.nonce);
        expect(f.open).toHaveBeenCalledTimes(2);
        expect(f.open.mock.calls[1][1]).toBe("_blank");
        expect(
            new URLSearchParams(new URL(f.open.mock.calls[1][0]).hash.slice(1)).get("sessionNonce"),
        ).toBe(retryNonce);
        expect(JSON.stringify(f.open.mock.calls)).not.toContain("SYNTHETIC_APPROVED_MARKER");
        expect(retryChannel.postMessage).not.toHaveBeenCalled();
        for (const outcome of ["saved", "rejected"]) {
            f.emit("relay-outcome", { outcome, importId: request.idempotencyKey });
            expect(get(localAppDeliveryStatus)).toEqual({
                importId: request.idempotencyKey,
                status: "opening",
            });
        }

        await emitRetry("relay-ready");
        await emitRetry("relay-ready");
        expect(retryChannel.postMessage).toHaveBeenCalledTimes(1);
        expect(retryChannel.postMessage.mock.calls[0][0]).toEqual({
            type: "relay-approved",
            version: 1,
            sessionNonce: retryNonce,
            request: encryptedRequest,
        });
        expect(retryChannel.postMessage.mock.calls[0][0].request).toEqual(encryptedRequest);
        emitRetry("relay-outcome", { outcome: "received", importId: request.idempotencyKey });
        expect(await retryResult).toEqual({ kind: "delivered" });
        for (const outcome of ["saved", "rejected"]) {
            f.emit("relay-outcome", { outcome, importId: request.idempotencyKey });
            expect(get(localAppDeliveryStatus)?.status).toBe("received");
        }
        emitRetry("relay-outcome", { outcome: "saved", importId: request.idempotencyKey });
        expect(get(localAppDeliveryStatus)?.status).toBe("saved");
        f.emit("relay-outcome", { outcome: "rejected", importId: request.idempotencyKey });
        await f.emit("relay-ready");
        await emitRetry("relay-ready");
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(get(localAppDeliveryStatus)?.status).toBe("saved");
        expect(retryChannel.postMessage.mock.calls.map(([message]) => message.type)).toEqual([
            "relay-approved",
            "relay-cancel",
        ]);
        expect(retryChannel.close).toHaveBeenCalledOnce();
        expect(f.channel.close).toHaveBeenCalledOnce();
        expect(f.channel.postMessage).toHaveBeenCalledTimes(2);
        expect(f.open).toHaveBeenCalledTimes(2);
        expect(f.channels).toHaveLength(2);
        expect(f.listeners.has("pagehide")).toBe(false);
    });
    it.each(["abort", "account teardown"] as const)(
        "cannot revive either attempt after explicit same-import redelivery and %s",
        async (teardown) => {
            vi.useFakeTimers();
            const f = fixture();
            await f.emit("relay-ready");
            f.emit("relay-outcome", { outcome: "received", importId: request.idempotencyKey });
            expect(await f.result).toEqual({ kind: "delivered" });
            const retryController = new AbortController();
            const retryResult = deliverLocalAppViaRelay(request, retryController.signal);
            const retryChannel = f.channels[1];
            const retryNonce = retryChannel.name.split(":")[1];
            const emitRetry = async (type: string, rest: object = {}) => {
                retryChannel.onmessage?.({
                    data: { type, version: 1, sessionNonce: retryNonce, ...rest },
                });
                for (let i = 0; i < 8; i++) await Promise.resolve();
            };
            expect(retryNonce).not.toBe(f.nonce);
            expect(f.channel.close).toHaveBeenCalledOnce();
            expect(f.channel.postMessage.mock.calls.at(-1)?.[0]).toEqual({
                type: "relay-cancel",
                version: 1,
                sessionNonce: f.nonce,
            });
            await emitRetry("relay-ready");
            expect(retryChannel.postMessage.mock.calls[0][0].request).toEqual(encryptedRequest);
            if (teardown === "account teardown") {
                emitRetry("relay-outcome", {
                    outcome: "received",
                    importId: request.idempotencyKey,
                });
                expect(await retryResult).toEqual({ kind: "delivered" });
                cancelLocalAppHandoffs();
            } else {
                retryController.abort();
                expect(await retryResult).toEqual({ kind: "uncertain" });
            }
            const expectedStatus =
                teardown === "account teardown"
                    ? undefined
                    : { importId: request.idempotencyKey, status: "uncertain" };
            expect(get(localAppDeliveryStatus)).toEqual(expectedStatus);
            expect(retryChannel.close).toHaveBeenCalledOnce();
            for (const emit of [f.emit, emitRetry]) {
                for (const outcome of ["saved", "rejected", "received"]) {
                    emit("relay-outcome", { outcome, importId: request.idempotencyKey });
                    expect(get(localAppDeliveryStatus)).toEqual(expectedStatus);
                }
                emit("relay-ready");
            }
            f.channel.onmessageerror?.();
            retryChannel.onmessageerror?.();
            f.controller.abort();
            await vi.advanceTimersByTimeAsync(10 * 60_000);
            expect(get(localAppDeliveryStatus)).toEqual(expectedStatus);
            for (const channel of f.channels) {
                expect(channel.postMessage.mock.calls.map(([message]) => message.type)).toEqual([
                    "relay-approved",
                    "relay-cancel",
                ]);
                expect(channel.close).toHaveBeenCalledOnce();
            }
            expect(f.open).toHaveBeenCalledTimes(2);
            expect(f.channels).toHaveLength(2);
            expect(f.listeners.has("pagehide")).toBe(false);
        },
    );
    it("clears account-scoped monitoring and ignores a late saved claim", async () => {
        const f = fixture();
        await f.emit("relay-ready");
        cancelLocalAppHandoffs();
        expect(await f.result).toEqual({ kind: "uncertain" });
        f.emit("relay-outcome", { outcome: "saved", importId: request.idempotencyKey });
        expect(get(localAppDeliveryStatus)).toBeUndefined();
        expect(f.channel.close).toHaveBeenCalledOnce();
    });
    it("tears down if broadcasting the approved request throws", async () => {
        const f = fixture();
        f.channel.postMessage.mockImplementation(() => {
            throw new Error("channel closed");
        });
        expect(() => f.emit("relay-ready")).not.toThrow();
        expect(await f.result).toEqual({ kind: "uncertain" });
        expect(f.channel.close).toHaveBeenCalledOnce();
    });
});
