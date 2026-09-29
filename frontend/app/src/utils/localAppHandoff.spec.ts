import { describe, expect, it, vi } from "vitest";
import { createLocalAppHandoffSession } from "./localAppHandoff";
import type { LocalDraftDeliveryRequest } from "./localAppDrafts";

function fixture(authorizeOffer?: () => Promise<boolean>) {
    const receiver = {};
    const send = vi.fn();
    const onOutcome = vi.fn();
    const sessionNonce = "A".repeat(43);
    const request: LocalDraftDeliveryRequest = Object.freeze({
        appId: "example",
        actionId: "record",
        destination: "https://app.example/import",
        recipient: "Review in the app",
        idempotencyKey: "B".repeat(42) + "A",
        payload: Object.freeze({ reading: 42, note: "private-marker" }),
    });
    const session = createLocalAppHandoffSession({
        receiver,
        send,
        onOutcome,
        sessionNonce,
        request,
        authorizeOffer,
    });
    const event = (type: string, rest: object = {}) => ({
        origin: "https://app.example",
        source: receiver,
        data: { type: `oc:app-import:${type}`, version: 1, sessionNonce, ...rest },
    });
    return { receiver, send, onOutcome, request, session, event };
}

describe("explicit private app handoff", () => {
    it("authorizes once after ready, and releases nothing while authorization is pending", async () => {
        let resolve!: (allowed: boolean) => void;
        const authorize = vi.fn(
            () =>
                new Promise<boolean>((r) => {
                    resolve = r;
                }),
        );
        const f = fixture(authorize);
        f.session.start();
        expect(authorize).not.toHaveBeenCalled();
        f.session.receive(f.event("ready"));
        f.session.receive(f.event("ready"));
        f.session.receive(
            f.event("received", { importId: f.request.idempotencyKey, status: "pending-review" }),
        );
        expect(authorize).toHaveBeenCalledTimes(1);
        expect(f.send).toHaveBeenCalledTimes(1);
        expect(f.onOutcome).not.toHaveBeenCalled();
        resolve(true);
        await Promise.resolve();
        expect(f.send).toHaveBeenCalledTimes(2);
        f.session.receive(f.event("ready"));
        expect(authorize).toHaveBeenCalledTimes(1);
    });
    it.each(["close", "expire"] as const)(
        "never releases after %s while authorization is pending",
        async (method) => {
            let resolve!: (allowed: boolean) => void;
            const f = fixture(
                () =>
                    new Promise<boolean>((r) => {
                        resolve = r;
                    }),
            );
            f.session.start();
            f.session.receive(f.event("ready"));
            f.session[method]();
            resolve(true);
            await Promise.resolve();
            expect(f.send).toHaveBeenCalledTimes(1);
            expect(f.onOutcome.mock.calls).toEqual(method === "expire" ? [["uncertain"]] : []);
        },
    );
    it.each(["denied", "failed"])(
        "ends uncertain without an offer if authorization is %s",
        async (mode) => {
            const f = fixture(async () => {
                if (mode === "failed") throw new Error();
                return false;
            });
            f.session.start();
            f.session.receive(f.event("ready"));
            await Promise.resolve();
            await Promise.resolve();
            f.session.receive(f.event("ready"));
            expect(f.send).toHaveBeenCalledTimes(1);
            expect(f.onOutcome.mock.calls).toEqual([["uncertain"]]);
        },
    );
    it("treats a send failure as uncertain without a retry", () => {
        const f = fixture();
        f.session.start();
        f.send.mockImplementationOnce(() => {
            throw new Error();
        });
        f.session.receive(f.event("ready"));
        f.session.receive(f.event("ready"));
        expect(f.send).toHaveBeenCalledTimes(2);
        expect(f.onOutcome.mock.calls).toEqual([["uncertain"]]);
    });
    it("sends no payload until started and the exact receiver is ready; offers at most once", () => {
        const f = fixture();
        f.session.receive(f.event("ready"));
        expect(f.send).not.toHaveBeenCalled();
        f.session.start();
        f.session.start();
        expect(f.send).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(f.send.mock.calls)).not.toContain("private-marker");
        f.session.receive(f.event("ready"));
        f.session.receive(f.event("ready"));
        expect(f.send).toHaveBeenCalledTimes(2);
        expect(f.send.mock.calls[1][0]).toEqual({
            type: "oc:app-import:offer",
            version: 1,
            sessionNonce: "A".repeat(43),
            importId: f.request.idempotencyKey,
            actionId: "record",
            payload: f.request.payload,
        });
        expect(f.send.mock.calls[1][1]).toBe("https://app.example");
    });
    it.each(["origin", "source", "nonce", "extras"])(
        "rejects an unbound ready (%s)",
        (alteration) => {
            const f = fixture();
            f.session.start();
            const event = f.event("ready");
            if (alteration === "origin") event.origin = "https://evil.example";
            if (alteration === "source") event.source = {};
            if (alteration === "nonce") Object.assign(event.data, { sessionNonce: "wrong" });
            if (alteration === "extras")
                Object.assign(event.data, { endpoint: "https://evil.example" });
            f.session.receive(event);
            expect(f.send).toHaveBeenCalledTimes(1);
        },
    );
    it("distinguishes received for review from saved and ignores premature saved claims", () => {
        const f = fixture();
        f.session.start();
        f.session.receive(f.event("ready"));
        const saved = f.event("committed", {
            importId: f.request.idempotencyKey,
            status: "saved",
            acceptedCount: 1,
            replayed: false,
        });
        f.session.receive(saved);
        expect(f.onOutcome).not.toHaveBeenCalled();
        const received = f.event("received", {
            importId: f.request.idempotencyKey,
            status: "pending-review",
        });
        f.session.receive(received);
        f.session.receive(received);
        expect(f.onOutcome.mock.calls).toEqual([["received"]]);
        f.session.receive(saved);
        f.session.receive(saved);
        expect(f.onOutcome.mock.calls).toEqual([["received"], ["saved"]]);
    });
    it("times out uncertain without automatic re-offer, even after a late ready/reconnect", () => {
        const f = fixture();
        f.session.start();
        f.session.expire();
        f.session.receive(f.event("ready"));
        f.session.start();
        f.session.expire();
        expect(f.send).toHaveBeenCalledTimes(1);
        expect(f.onOutcome.mock.calls).toEqual([["uncertain"]]);
    });
    it("closing suppresses all late responses", () => {
        const f = fixture();
        f.session.start();
        f.session.close();
        f.session.receive(f.event("ready"));
        f.session.expire();
        expect(f.send).toHaveBeenCalledTimes(1);
        expect(f.onOutcome).not.toHaveBeenCalled();
    });
    it("handles a bound receiver rejection without retrying or claiming receipt", () => {
        const f = fixture();
        f.session.start();
        f.session.receive(f.event("ready"));
        f.session.receive(f.event("rejected", { reason: "id-conflict" }));
        f.session.receive(f.event("ready"));
        expect(f.onOutcome.mock.calls).toEqual([["rejected"]]);
        expect(f.send).toHaveBeenCalledTimes(2);
    });
});
