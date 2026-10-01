// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://client.example/local-app-handoff.html"}
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatLocalHandoffReview, startLocalAppHandoffRelay } from "./localAppHandoffRelay";
import { encryptedRequestFixture } from "./utils/localAppEncryption.testFixtures";

describe("encrypted relay metadata rendering", () => {
    it("shows destination metadata without fields or ciphertext", () => {
        const request = encryptedRequestFixture();
        const formatted = formatLocalHandoffReview(request);
        expect(JSON.parse(formatted)).toMatchObject({
            destination: request.destination,
            recipientKey: request.envelope.keyId,
        });
        expect(formatted).not.toContain('"payload"');
        expect(formatted).not.toContain(request.envelope.ciphertext);
    });
});

const html = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../public/local-app-handoff.html"),
    "utf8",
);
const nonce = "A".repeat(43);
const approvedRequest = encryptedRequestFixture({ appId: "synthetic.app" });

// Mount the shipped page and execute its actual relay/session logic. Only browser
// transport/popup APIs are doubles; no account, processor, model or backend is used.
describe("mounted private relay consent and lifecycle", () => {
    const network = vi.fn(() => {
        throw new Error("Unexpected network request");
    });
    let stop: (() => void) | undefined;

    function fixture() {
        const channels: FakeChannel[] = [];
        class FakeChannel {
            onmessage?: (event: { data: unknown }) => void;
            postMessage = vi.fn();
            close = vi.fn();
            constructor(readonly name: string) {
                channels.push(this);
            }
        }
        const receiver = { postMessage: vi.fn() };
        const open = vi.spyOn(window, "open").mockReturnValue(receiver as unknown as Window);
        vi.stubGlobal("BroadcastChannel", FakeChannel);
        vi.stubGlobal("opener", { unapprovedChatData: "SYNTHETIC_PARENT_ONLY_MARKER" });
        history.replaceState(null, "", `/local-app-handoff.html#sessionNonce=${nonce}`);
        document.documentElement.innerHTML = html
            .replace(/<!doctype[^>]*>/i, "")
            .replace(/<\/?html[^>]*>/gi, "");
        stop = startLocalAppHandoffRelay();
        expect(channels).toHaveLength(1);
        const channel = channels[0];
        const button = document.querySelector<HTMLButtonElement>("#open-app")!;
        const summary = document.querySelector<HTMLElement>("#handoff-summary")!;
        const status = document.querySelector<HTMLElement>("#handoff-status")!;
        const hostMessage = (type: string, extra: Record<string, unknown> = {}) =>
            channel.onmessage?.({ data: { type, version: 1, sessionNonce: nonce, ...extra } });
        const approve = () => hostMessage("relay-approved", { request: approvedRequest });
        const appMessage = (
            type: string,
            extra: Record<string, unknown> = {},
            origin = "https://app.example",
            source: unknown = receiver,
        ) =>
            window.dispatchEvent(
                new MessageEvent("message", {
                    origin,
                    source: source as Window,
                    data: {
                        type: `oc:app-import:${type}`,
                        version: 2,
                        sessionNonce: nonce,
                        ...extra,
                    },
                }),
            );
        const outcomes = () =>
            channel.postMessage.mock.calls
                .map(([message]) => message)
                .filter((message) => message.type === "relay-outcome");
        return {
            channel,
            receiver,
            open,
            button,
            summary,
            status,
            hostMessage,
            approve,
            appMessage,
            outcomes,
        };
    }

    beforeEach(() => {
        vi.useFakeTimers();
        network.mockClear();
        vi.stubGlobal("fetch", network);
        vi.stubGlobal("XMLHttpRequest", network);
        vi.stubGlobal("WebSocket", network);
    });

    afterEach(() => {
        try {
            stop?.();
            // Consume the page's once-only listener as a real navigation would, so
            // it cannot survive into the next mounted page.
            window.dispatchEvent(new Event("pagehide"));
            expect(vi.getTimerCount()).toBe(0);
            expect(network).not.toHaveBeenCalled();
        } finally {
            stop = undefined;
            vi.clearAllTimers();
            vi.useRealTimers();
            vi.restoreAllMocks();
            vi.unstubAllGlobals();
            document.documentElement.innerHTML = "<head></head><body></body>";
        }
    });

    it("severs its opener and reveals only public readiness before the second explicit review", () => {
        const f = fixture();
        expect(window.opener).toBeNull();
        expect(location.href).toBe("https://client.example/local-app-handoff.html");
        expect(f.channel.name).toBe(`openchat-local-handoff-v1:${nonce}`);
        expect(f.channel.postMessage.mock.calls).toEqual([
            [{ type: "relay-ready", version: 1, sessionNonce: nonce }],
        ]);
        expect(f.button.disabled).toBe(true);
        f.button.click();
        f.appMessage("ready");
        f.approve();
        expect(f.button.disabled).toBe(false);
        expect(JSON.parse(f.summary.textContent!)).toMatchObject({
            destination: approvedRequest.destination,
            recipientKey: approvedRequest.envelope.keyId,
        });
        expect(f.summary.textContent).not.toContain("SYNTHETIC_APPROVED_MARKER");
        expect(document.querySelector("img")).toBeNull();
        f.appMessage("ready");
        vi.advanceTimersByTime(1_000);
        expect(f.open).not.toHaveBeenCalled();
        expect(f.receiver.postMessage).not.toHaveBeenCalled();
        expect(JSON.stringify(f.channel.postMessage.mock.calls)).not.toContain("MARKER");
    });

    it("opens only on explicit consent and offers exactly the approved payload to the bound receiver once", () => {
        const f = fixture();
        f.approve();
        f.button.click();
        expect(f.open).toHaveBeenCalledExactlyOnceWith(
            `https://app.example/import#sessionNonce=${nonce}`,
            "_blank",
        );
        expect(JSON.stringify(f.open.mock.calls)).not.toContain("MARKER");
        expect(f.receiver.postMessage.mock.calls).toEqual([
            [
                { type: "oc:app-import:hello", version: 2, sessionNonce: nonce },
                "https://app.example",
            ],
        ]);
        f.appMessage("ready", {}, "https://other.example");
        f.appMessage("ready", {}, "https://app.example", {});
        f.appMessage("ready", { sessionNonce: "wrong" });
        f.appMessage("ready", { extra: "not allowed" });
        expect(f.receiver.postMessage).toHaveBeenCalledOnce();
        f.appMessage("ready");
        f.appMessage("ready");
        f.button.dispatchEvent(new Event("click"));
        expect(f.open).toHaveBeenCalledOnce();
        expect(f.receiver.postMessage.mock.calls[1]).toEqual([
            {
                type: "oc:app-import:offer",
                version: 2,
                sessionNonce: nonce,
                importId: approvedRequest.idempotencyKey,
                actionId: approvedRequest.actionId,
                appId: approvedRequest.appId,
                appRevision: approvedRequest.appRevision,
                destination: approvedRequest.destination,
                envelope: approvedRequest.envelope,
            },
            "https://app.example",
        ]);
        expect(f.receiver.postMessage).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(f.receiver.postMessage.mock.calls)).not.toContain(
            "SYNTHETIC_PARENT_ONLY_MARKER",
        );
        expect(f.outcomes()).toEqual([]);
    });

    it("ignores unbound approval messages without opening an app or replacing the reviewed request", () => {
        const f = fixture();
        f.hostMessage("relay-approved", { sessionNonce: "wrong", request: approvedRequest });
        f.hostMessage("relay-approved", { request: approvedRequest, extra: "not allowed" });
        expect(f.button.disabled).toBe(true);
        expect(f.summary.textContent).toBe("");
        f.approve();
        f.hostMessage("relay-approved", {
            request: { ...approvedRequest, destination: "https://other.example/import" },
        });
        expect(JSON.parse(f.summary.textContent!)).toMatchObject({
            destination: approvedRequest.destination,
            recipientKey: approvedRequest.envelope.keyId,
        });
        expect(f.open).not.toHaveBeenCalled();
    });

    it.each([
        { ...approvedRequest, destination: "http://remote.example/import" },
        { ...approvedRequest, destination: "https://user:secret@app.example/import" },
        { ...approvedRequest, unexpected: "SYNTHETIC_HIDDEN_FIELD" },
        { ...approvedRequest, payload: { text: "x".repeat(73 * 1024) } },
    ])("closes an invalid approved request without opening or leaking it", (request) => {
        const f = fixture();
        f.hostMessage("relay-approved", { request });
        expect(f.status.textContent).toContain("invalid");
        expect(f.summary.textContent).toBe("");
        expect(f.button.disabled).toBe(true);
        expect(f.channel.close).toHaveBeenCalledOnce();
        expect(f.channel.postMessage.mock.calls.at(-1)).toEqual([
            { type: "relay-expired", version: 1, sessionNonce: nonce },
        ]);
        f.approve();
        f.button.dispatchEvent(new Event("click"));
        expect(f.open).not.toHaveBeenCalled();
        expect(f.receiver.postMessage).not.toHaveBeenCalled();
    });

    it.each(["stop", "cancel", "expiry", "pagehide"] as const)(
        "discards the reviewed payload on %s before consent and refuses all late events",
        (reason) => {
            const f = fixture();
            f.approve();
            if (reason === "stop") stop!();
            else if (reason === "cancel") f.hostMessage("relay-cancel");
            else if (reason === "expiry") vi.advanceTimersByTime(10 * 60 * 1000);
            else window.dispatchEvent(new Event("pagehide"));
            expect(f.summary.textContent).toBe("");
            expect(f.button.disabled).toBe(true);
            expect(f.channel.close).toHaveBeenCalledOnce();
            const sent = f.channel.postMessage.mock.calls.length;
            f.approve();
            f.button.dispatchEvent(new Event("click"));
            f.appMessage("ready");
            vi.advanceTimersByTime(10 * 60 * 1000);
            expect(f.open).not.toHaveBeenCalled();
            expect(f.receiver.postMessage).not.toHaveBeenCalled();
            expect(f.channel.postMessage).toHaveBeenCalledTimes(sent);
        },
    );

    it.each(["stop", "cancel", "pagehide", "offer timeout"] as const)(
        "never releases to a late ready after %s while waiting for the app",
        (reason) => {
            const f = fixture();
            f.approve();
            f.button.click();
            if (reason === "stop") stop!();
            else if (reason === "cancel") f.hostMessage("relay-cancel");
            else if (reason === "pagehide") window.dispatchEvent(new Event("pagehide"));
            else vi.advanceTimersByTime(30_000);
            const sent = f.receiver.postMessage.mock.calls.length;
            const outcomes = f.outcomes();
            expect(outcomes.map(({ outcome }) => outcome)).toEqual(
                reason === "offer timeout" ? ["uncertain"] : [],
            );
            f.appMessage("ready");
            f.appMessage("received", {
                importId: approvedRequest.idempotencyKey,
                status: "pending-review",
            });
            vi.advanceTimersByTime(10 * 60 * 1000);
            expect(f.receiver.postMessage).toHaveBeenCalledTimes(sent);
            expect(JSON.stringify(f.receiver.postMessage.mock.calls)).not.toContain("MARKER");
            expect(f.outcomes()).toEqual(outcomes);
            expect(f.channel.close).toHaveBeenCalledOnce();
        },
    );

    it("retries a blocked popup only on another explicit click, not on a timer or ready event", () => {
        const f = fixture();
        f.open.mockReturnValueOnce(null);
        f.approve();
        f.button.click();
        expect(f.status.textContent).toContain("popup was blocked");
        expect(f.button.disabled).toBe(false);
        f.appMessage("ready");
        vi.advanceTimersByTime(5_000);
        expect(f.open).toHaveBeenCalledOnce();
        expect(f.receiver.postMessage).not.toHaveBeenCalled();
        f.button.click();
        expect(f.open).toHaveBeenCalledTimes(2);
        expect(f.button.disabled).toBe(true);
        expect(f.receiver.postMessage).toHaveBeenCalledOnce();
        f.appMessage("ready");
        expect(f.receiver.postMessage).toHaveBeenCalledTimes(2);
    });

    it("keeps an initial popup send failure terminal without restarting timers or changing its status", () => {
        const f = fixture();
        f.receiver.postMessage.mockImplementationOnce(() => {
            throw new Error("Synthetic popup transport failure");
        });
        f.approve();
        f.button.click();
        expect(f.outcomes()).toEqual([
            {
                type: "relay-outcome",
                version: 1,
                sessionNonce: nonce,
                outcome: "uncertain",
                importId: approvedRequest.idempotencyKey,
            },
        ]);
        expect(f.channel.close).toHaveBeenCalledOnce();
        expect(f.button.disabled).toBe(true);
        expect(f.summary.textContent).toBe("");
        expect(f.status.textContent).toContain("Delivery was not confirmed");
        expect(f.status.textContent).not.toContain("Waiting");
        expect(vi.getTimerCount()).toBe(0);
        const failureStatus = f.status.textContent;
        f.appMessage("ready");
        f.approve();
        f.button.dispatchEvent(new Event("click"));
        vi.advanceTimersByTime(10 * 60 * 1000);
        expect(f.receiver.postMessage).toHaveBeenCalledOnce();
        expect(f.open).toHaveBeenCalledOnce();
        expect(f.channel.close).toHaveBeenCalledOnce();
        expect(f.outcomes()).toHaveLength(1);
        expect(f.status.textContent).toBe(failureStatus);
    });

    it("forwards received separately from a complete saved receipt, then clears the page and stops", () => {
        const f = fixture();
        f.approve();
        f.button.click();
        f.appMessage("ready");
        const received = { importId: approvedRequest.idempotencyKey, status: "pending-review" };
        const saved = {
            importId: approvedRequest.idempotencyKey,
            status: "saved",
            acceptedCount: 1,
            replayed: true,
        };
        f.appMessage("committed", saved);
        expect(f.outcomes()).toEqual([]);
        f.appMessage("received", received);
        f.appMessage("received", received);
        expect(f.outcomes()).toEqual([
            {
                type: "relay-outcome",
                version: 1,
                sessionNonce: nonce,
                outcome: "received",
                importId: approvedRequest.idempotencyKey,
            },
        ]);
        expect(f.status.textContent).toContain("not yet a saved entry");
        expect(f.summary.textContent).not.toContain("SYNTHETIC_APPROVED_MARKER");
        f.appMessage("committed", { ...saved, acceptedCount: 0 });
        f.appMessage("committed", { ...saved, importId: "wrong" });
        f.appMessage("committed", { ...saved, extra: "not allowed" });
        expect(f.outcomes()).toHaveLength(1);
        f.appMessage("committed", saved);
        expect(f.outcomes()).toEqual([
            {
                type: "relay-outcome",
                version: 1,
                sessionNonce: nonce,
                outcome: "received",
                importId: approvedRequest.idempotencyKey,
            },
            {
                type: "relay-outcome",
                version: 1,
                sessionNonce: nonce,
                outcome: "saved",
                importId: approvedRequest.idempotencyKey,
            },
        ]);
        expect(f.status.textContent).toBe("The app reports that this import was saved.");
        expect(f.summary.textContent).toBe("");
        expect(f.button.disabled).toBe(true);
        expect(f.channel.close).toHaveBeenCalledOnce();
        const sent = f.receiver.postMessage.mock.calls.length;
        f.appMessage("committed", saved);
        f.appMessage("ready");
        vi.advanceTimersByTime(10 * 60 * 1000);
        expect(f.outcomes()).toHaveLength(2);
        expect(f.receiver.postMessage).toHaveBeenCalledTimes(sent);
    });

    it("expires received-but-unsaved delivery without manufacturing a saved receipt or retry", () => {
        const f = fixture();
        f.approve();
        f.button.click();
        f.appMessage("ready");
        f.appMessage("received", {
            importId: approvedRequest.idempotencyKey,
            status: "pending-review",
        });
        const sent = f.receiver.postMessage.mock.calls.length;
        vi.advanceTimersByTime(10 * 60 * 1000);
        expect(f.status.textContent).toContain("handoff expired");
        expect(f.outcomes().map(({ outcome }) => outcome)).toEqual(["received"]);
        expect(f.channel.postMessage.mock.calls.at(-1)).toEqual([
            { type: "relay-expired", version: 1, sessionNonce: nonce },
        ]);
        f.appMessage("committed", {
            importId: approvedRequest.idempotencyKey,
            status: "saved",
            acceptedCount: 1,
            replayed: false,
        });
        expect(f.outcomes().map(({ outcome }) => outcome)).toEqual(["received"]);
        expect(f.receiver.postMessage).toHaveBeenCalledTimes(sent);
        expect(f.open).toHaveBeenCalledOnce();
        expect(f.summary.textContent).toBe("");
    });
});
