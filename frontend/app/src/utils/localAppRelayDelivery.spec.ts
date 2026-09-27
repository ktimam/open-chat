import { afterEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import {
    cancelLocalAppHandoffs,
    deliverLocalAppViaRelay,
    localAppDeliveryStatus,
} from "./localAppRelayDelivery";
import type { LocalDraftDeliveryRequest } from "./localAppDrafts";

const request: LocalDraftDeliveryRequest = Object.freeze({
    appId: "example",
    actionId: "record",
    destination: "https://app.example/import",
    recipient: "Review in app",
    idempotencyKey: "B".repeat(42) + "A",
    payload: Object.freeze({ reading: 42, note: "SYNTHETIC_APPROVED_MARKER" }),
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
    const emit = (type: string, rest: object = {}) =>
        channel.onmessage?.({ data: { type, version: 1, sessionNonce: nonce, ...rest } });
    return { channel, open, result, controller, listeners, emit };
}

afterEach(() => {
    cancelLocalAppHandoffs();
    vi.unstubAllGlobals();
});

describe("confirmed local relay delivery lifecycle", () => {
    it("puts no payload in URLs and sends the approved request once after a bound ready", async () => {
        const f = fixture();
        expect(JSON.stringify(f.open.mock.calls)).not.toContain("SYNTHETIC_APPROVED_MARKER");
        expect(f.channel.postMessage).not.toHaveBeenCalled();
        f.emit("relay-ready", { sessionNonce: "wrong" });
        expect(f.channel.postMessage).not.toHaveBeenCalled();
        f.emit("relay-ready");
        f.emit("relay-ready");
        expect(f.channel.postMessage).toHaveBeenCalledTimes(1);
        expect(f.channel.postMessage.mock.calls[0][0]).toMatchObject({
            type: "relay-approved",
            request,
        });
        f.controller.abort();
        expect(await f.result).toEqual({ kind: "uncertain" });
    });
    it("cancels a live relay on decoding failure before receipt and ignores late messages", async () => {
        const f = fixture();
        f.emit("relay-ready");
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
        f.emit("relay-ready");
        f.listeners.get("pagehide")?.();
        expect(await f.result).toEqual({ kind: "uncertain" });
        expect(f.channel.postMessage.mock.calls.map(([message]) => message.type)).toEqual([
            "relay-approved",
            "relay-cancel",
        ]);
        f.emit("relay-ready");
        expect(f.channel.postMessage).toHaveBeenCalledTimes(2);
    });
    it("preserves received-not-saved after communication loss", async () => {
        const f = fixture();
        f.emit("relay-ready");
        f.emit("relay-outcome", { outcome: "received", importId: request.idempotencyKey });
        expect(await f.result).toEqual({ kind: "delivered" });
        f.channel.onmessageerror?.();
        expect(get(localAppDeliveryStatus)?.status).toBe("received");
        expect(f.channel.close).toHaveBeenCalledOnce();
        f.emit("relay-outcome", { outcome: "saved", importId: request.idempotencyKey });
        expect(get(localAppDeliveryStatus)?.status).toBe("received");
    });
    it("clears account-scoped monitoring and ignores a late saved claim", async () => {
        const f = fixture();
        f.emit("relay-ready");
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
