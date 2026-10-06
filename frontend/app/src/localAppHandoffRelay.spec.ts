// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://client.example/local-app-handoff.html"}
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startLocalAppHandoffRelay } from "./localAppHandoffRelay";
import { encryptedRequestFixture } from "./utils/localAppEncryption.testFixtures";

const html = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../public/local-app-handoff.html"),
    "utf8",
);
const nonce = "A".repeat(43);
const request = encryptedRequestFixture({ appId: "synthetic.app" });

describe("normal app frame in the encrypted browser relay", () => {
    let stop: (() => void) | undefined;
    const network = vi.fn(() => {
        throw new Error("Unexpected direct network request");
    });
    function fixture(appOrigin = "https://app.example") {
        const channels: Channel[] = [];
        class Channel {
            onmessage?: (event: { data: unknown }) => void;
            onmessageerror?: () => void;
            postMessage = vi.fn();
            close = vi.fn();
            constructor(readonly name: string) {
                channels.push(this);
            }
        }
        vi.stubGlobal("BroadcastChannel", Channel);
        vi.stubGlobal("opener", { privateParentMarker: "SYNTHETIC_PARENT_ONLY" });
        const open = vi.spyOn(window, "open");
        history.replaceState(null, "", `/local-app-handoff.html#sessionNonce=${nonce}`);
        document.documentElement.innerHTML = html
            .replace(/<!doctype[^>]*>/i, "")
            .replace(/<\/?html[^>]*>/gi, "");
        document.body.dataset.appOrigin = appOrigin;
        const frame = document.querySelector<HTMLIFrameElement>("#app-frame")!;
        const receiver = { postMessage: vi.fn(), closed: false };
        Object.defineProperty(frame, "contentWindow", { value: receiver });
        stop = startLocalAppHandoffRelay();
        const channel = channels[0];
        const status = document.querySelector<HTMLElement>("#handoff-status")!;
        const host = (type: string, extra: object = {}) =>
            channel.onmessage?.({ data: { type, version: 1, sessionNonce: nonce, ...extra } });
        const approve = () => host("relay-approved", { request });
        const app = (
            type: string,
            extra: object = {},
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
                .map(([data]) => data)
                .filter((data) => data.type === "relay-outcome");
        return { channel, receiver, frame, open, status, host, approve, app, outcomes };
    }
    beforeEach(() => {
        vi.useFakeTimers();
        network.mockClear();
        vi.stubGlobal("fetch", network);
        vi.stubGlobal("XMLHttpRequest", network);
        vi.stubGlobal("WebSocket", network);
    });
    afterEach(() => {
        stop?.();
        window.dispatchEvent(new Event("pagehide"));
        expect(vi.getTimerCount()).toBe(0);
        expect(network).not.toHaveBeenCalled();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
        document.documentElement.innerHTML = "<head></head><body></body>";
    });
    it("has no transport review/buttons/metadata, and loads nothing before host approval", () => {
        const f = fixture();
        expect(window.opener).toBeNull();
        expect(location.href).toBe("https://client.example/local-app-handoff.html");
        expect(document.querySelector("button,pre,input,textarea")).toBeNull();
        expect(document.body.textContent).not.toMatch(
            /import ID|recipientKey|Private app handoff|Open app and send/,
        );
        expect(f.frame.hidden).toBe(true);
        expect(f.frame.hasAttribute("src")).toBe(false);
        expect(f.channel.postMessage.mock.calls).toEqual([
            [{ type: "relay-ready", version: 1, sessionNonce: nonce }],
        ]);
        f.app("ready");
        vi.advanceTimersByTime(1000);
        expect(f.open).not.toHaveBeenCalled();
        expect(f.receiver.postMessage).not.toHaveBeenCalled();
        expect(f.frame.getAttribute("sandbox")).toBe(
            "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox",
        );
        expect(f.frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    });
    it("shows the normal app automatically and offers only ciphertext once to the exact frame", () => {
        const f = fixture();
        f.approve();
        expect(f.frame.src).toBe(`https://app.example/import#sessionNonce=${nonce}`);
        expect(f.frame.hidden).toBe(false);
        expect(f.status.hidden).toBe(true);
        expect(f.open).not.toHaveBeenCalled();
        expect(f.receiver.postMessage.mock.calls).toEqual([
            [
                { type: "oc:app-import:hello", version: 2, sessionNonce: nonce },
                "https://app.example",
            ],
        ]);
        f.app("ready", {}, "https://other.example");
        f.app("ready", {}, "https://app.example", {});
        f.app("ready", { sessionNonce: "wrong" });
        f.app("ready", { extra: true });
        expect(f.receiver.postMessage).toHaveBeenCalledOnce();
        f.app("ready");
        f.app("ready");
        f.approve();
        expect(f.receiver.postMessage).toHaveBeenCalledTimes(2);
        expect(f.receiver.postMessage.mock.calls[1]).toEqual([
            {
                type: "oc:app-import:offer",
                version: 2,
                sessionNonce: nonce,
                importId: request.idempotencyKey,
                appId: request.appId,
                appRevision: request.appRevision,
                actionId: request.actionId,
                destination: request.destination,
                envelope: request.envelope,
            },
            "https://app.example",
        ]);
        expect(f.frame.src).not.toContain(request.envelope.ciphertext);
        expect(JSON.stringify(f.receiver.postMessage.mock.calls)).not.toContain(
            "SYNTHETIC_PARENT_ONLY",
        );
        expect(document.body.textContent).not.toContain(request.idempotencyKey);
    });
    it("ignores wrong nonce/shape and cannot replace an accepted destination", () => {
        const f = fixture();
        f.host("relay-approved", { sessionNonce: "wrong", request });
        f.host("relay-approved", { request, extra: true });
        expect(f.frame.hasAttribute("src")).toBe(false);
        f.approve();
        const accepted = f.frame.src;
        f.host("relay-approved", {
            request: { ...request, destination: "https://other.example/import" },
        });
        expect(f.frame.src).toBe(accepted);
    });
    it.each(["", "https://other.example", "https://app.example/path", "http://remote.example"])(
        "refuses unconfigured/mismatched frame origin %s",
        (origin) => {
            const f = fixture(origin);
            f.approve();
            expect(f.frame.hasAttribute("src")).toBe(false);
            expect(f.frame.hidden).toBe(true);
            expect(f.channel.close).toHaveBeenCalledOnce();
            expect(f.status.hidden).toBe(false);
            expect(f.receiver.postMessage).not.toHaveBeenCalled();
        },
    );
    it.each([
        { ...request, destination: "http://remote.example/import" },
        { ...request, destination: "https://user:secret@app.example/import" },
        { ...request, unexpected: "HIDDEN_FIELD" },
        { ...request, payload: { text: "x".repeat(73 * 1024) } },
    ])("closes invalid approved envelopes without loading an app", (invalid) => {
        const f = fixture();
        f.host("relay-approved", { request: invalid });
        expect(f.frame.hasAttribute("src")).toBe(false);
        expect(f.channel.close).toHaveBeenCalledOnce();
        f.approve();
        expect(f.receiver.postMessage).not.toHaveBeenCalled();
    });
    it.each(["stop", "cancel", "expiry", "pagehide", "decode"])(
        "does not navigate after %s before approval",
        (reason) => {
            const f = fixture();
            if (reason === "stop") stop!();
            else if (reason === "cancel") f.host("relay-cancel");
            else if (reason === "expiry") vi.advanceTimersByTime(600_000);
            else if (reason === "decode") f.channel.onmessageerror?.();
            else window.dispatchEvent(new Event("pagehide"));
            f.approve();
            expect(f.frame.hasAttribute("src")).toBe(false);
            expect(f.channel.close).toHaveBeenCalledOnce();
        },
    );
    it.each(["stop", "cancel", "pagehide", "offer timeout"])(
        "never releases ciphertext to late ready after %s",
        (reason) => {
            const f = fixture();
            f.approve();
            if (reason === "stop") stop!();
            else if (reason === "cancel") f.host("relay-cancel");
            else if (reason === "pagehide") window.dispatchEvent(new Event("pagehide"));
            else vi.advanceTimersByTime(30_000);
            const sent = f.receiver.postMessage.mock.calls.length;
            f.app("ready");
            vi.advanceTimersByTime(600_000);
            expect(f.receiver.postMessage).toHaveBeenCalledTimes(sent);
            expect(f.outcomes().map((message) => message.outcome)).toEqual(
                reason === "offer timeout" ? ["uncertain"] : [],
            );
            expect(f.channel.close).toHaveBeenCalledOnce();
        },
    );
    it("keeps send failure terminal without automatic frame reload", () => {
        const f = fixture();
        f.receiver.postMessage.mockImplementationOnce(() => {
            throw new Error("Synthetic send failure");
        });
        f.approve();
        const url = f.frame.src;
        expect(f.outcomes().map((message) => message.outcome)).toEqual(["uncertain"]);
        expect(f.status.hidden).toBe(false);
        expect(f.channel.close).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        f.app("ready");
        f.approve();
        expect(f.frame.src).toBe(url);
        expect(f.receiver.postMessage).toHaveBeenCalledOnce();
    });
    it("closes locally if reporting over the host channel fails, without leaving a live offer", () => {
        const f = fixture();
        f.approve();
        f.channel.postMessage.mockImplementation(() => {
            throw new Error("Synthetic channel failure");
        });
        expect(() => f.channel.onmessageerror?.()).not.toThrow();
        expect(f.channel.close).toHaveBeenCalledOnce();
        expect(f.status.hidden).toBe(false);
        const sent = f.receiver.postMessage.mock.calls.length;
        f.app("ready");
        vi.advanceTimersByTime(600_000);
        expect(f.receiver.postMessage).toHaveBeenCalledTimes(sent);
    });
    it("distinguishes received from saved and retains the app's final page", () => {
        const f = fixture();
        f.approve();
        f.app("ready");
        const saved = {
            importId: request.idempotencyKey,
            status: "saved",
            acceptedCount: 1,
            replayed: true,
        };
        f.app("committed", saved);
        expect(f.outcomes()).toEqual([]);
        f.app("received", { importId: request.idempotencyKey, status: "pending-review" });
        f.app("received", { importId: request.idempotencyKey, status: "pending-review" });
        f.app("committed", { ...saved, acceptedCount: 0 });
        f.app("committed", { ...saved, extra: true });
        expect(f.outcomes().map((message) => message.outcome)).toEqual(["received"]);
        f.app("committed", saved);
        expect(f.outcomes().map((message) => message.outcome)).toEqual(["received", "saved"]);
        expect(f.frame.hidden).toBe(false);
        expect(f.channel.close).toHaveBeenCalledOnce();
        f.app("committed", saved);
        expect(f.outcomes()).toHaveLength(2);
    });
    it("expires received-but-unsaved without inventing a saved result", () => {
        const f = fixture();
        f.approve();
        f.app("ready");
        f.app("received", { importId: request.idempotencyKey, status: "pending-review" });
        vi.advanceTimersByTime(600_000);
        f.app("committed", {
            importId: request.idempotencyKey,
            status: "saved",
            acceptedCount: 1,
            replayed: false,
        });
        expect(f.outcomes().map((message) => message.outcome)).toEqual(["received"]);
        expect(f.channel.postMessage.mock.calls.at(-1)?.[0].type).toBe("relay-expired");
        expect(f.open).not.toHaveBeenCalled();
        expect(f.frame.hidden).toBe(false);
    });
});
