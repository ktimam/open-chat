// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://client.example/local-app-setup.html"}
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startLocalAppSetupRelay } from "./localAppSetupRelay";
import { APP_SETUP_MAX_BYTES } from "./utils/localAppSetupPopup";

const html = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../public/local-app-setup.html"),
    "utf8",
);
const nonce = "A".repeat(43);
describe("normal app connection frame", () => {
    let stop: (() => void) | undefined;
    const network = vi.fn(() => {
        throw new Error("Unexpected direct network request");
    });
    function fixture(origin = "https://app.example") {
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
        history.replaceState(null, "", `/local-app-setup.html#sessionNonce=${nonce}`);
        document.documentElement.innerHTML = html
            .replace(/<!doctype[^>]*>/i, "")
            .replace(/<\/?html[^>]*>/gi, "");
        document.body.dataset.appOrigin = origin;
        const frame = document.querySelector<HTMLIFrameElement>("#app-frame")!;
        const receiver = { postMessage: vi.fn(), closed: false };
        Object.defineProperty(frame, "contentWindow", { value: receiver });
        stop = startLocalAppSetupRelay();
        const channel = channels[0];
        const host = (type: string, extra: object = {}) =>
            channel.onmessage?.({ data: { type, version: 1, sessionNonce: nonce, ...extra } });
        const target = () =>
            host("setup-target", { appId: "sample", setupUrl: "https://app.example/connect" });
        const reply = (
            extra: object = {},
            appOrigin = "https://app.example",
            source: object = receiver,
        ) =>
            window.dispatchEvent(
                new MessageEvent("message", {
                    source: source as Window,
                    origin: appOrigin,
                    data: {
                        type: "oc:app-setup:result",
                        version: 1,
                        connectionId: receiver.postMessage.mock.calls[0]?.[0].connectionId,
                        appId: "sample",
                        catalogJson: '{"version":1}',
                        ...extra,
                    },
                }),
            );
        const results = () =>
            channel.postMessage.mock.calls
                .map(([data]) => data)
                .filter((data) => data.type === "setup-result");
        return { channel, frame, receiver, open, host, target, reply, results };
    }
    beforeEach(() => {
        vi.useFakeTimers();
        network.mockClear();
        vi.stubGlobal("fetch", network);
        vi.stubGlobal("XMLHttpRequest", network);
        vi.stubGlobal("WebSocket", network);
    });
    afterEach(async () => {
        stop?.();
        window.dispatchEvent(new Event("pagehide"));
        await Promise.resolve();
        expect(vi.getTimerCount()).toBe(0);
        expect(network).not.toHaveBeenCalled();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
        document.documentElement.innerHTML = "<head></head><body></body>";
    });
    it("has no second Continue or technical setup page, and waits for the host target", () => {
        const f = fixture();
        expect(window.opener).toBeNull();
        expect(location.href).toBe("https://client.example/local-app-setup.html");
        expect(document.querySelector("button,pre,input,textarea")).toBeNull();
        expect(document.body.textContent).not.toMatch(
            /Continue|catalog|setup URL|app ID|Private app connection/i,
        );
        expect(f.frame.hasAttribute("src")).toBe(false);
        expect(f.frame.hidden).toBe(true);
        expect(f.channel.postMessage.mock.calls).toEqual([
            [{ type: "setup-ready", version: 1, sessionNonce: nonce }],
        ]);
        expect(f.open).not.toHaveBeenCalled();
        expect(f.receiver.postMessage).not.toHaveBeenCalled();
        expect(f.frame.getAttribute("sandbox")).toBe(
            "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox",
        );
        expect(f.frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    });
    it("automatically shows normal Connect but does not infer sharing consent", async () => {
        const f = fixture();
        f.target();
        expect(f.frame.src).toBe("https://app.example/connect");
        expect(f.frame.hidden).toBe(false);
        expect(document.querySelector<HTMLElement>("#setup-status")!.hidden).toBe(true);
        expect(f.open).not.toHaveBeenCalled();
        const hello = f.receiver.postMessage.mock.calls[0][0];
        expect(Object.keys(hello).sort()).toEqual(["appId", "connectionId", "type", "version"]);
        expect(hello.connectionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(f.receiver.postMessage.mock.calls[0][1]).toBe("https://app.example");
        await vi.advanceTimersByTimeAsync(1000);
        expect(f.results()).toEqual([]);
        f.reply();
        await Promise.resolve();
        expect(f.results()).toEqual([
            { type: "setup-result", version: 1, sessionNonce: nonce, catalogJson: '{"version":1}' },
        ]);
        expect(f.channel.close).toHaveBeenCalledOnce();
        expect(f.frame.hidden).toBe(false);
        f.reply();
        expect(f.results()).toHaveLength(1);
        expect(JSON.stringify(f.receiver.postMessage.mock.calls)).not.toContain(
            "SYNTHETIC_PARENT_ONLY",
        );
    });
    it.each([
        [{}, "https://wrong.example", undefined],
        [{}, "https://app.example", {}],
        [{ connectionId: "B".repeat(43) }, "https://app.example", undefined],
        [{ appId: "other" }, "https://app.example", undefined],
        [{ extra: true }, "https://app.example", undefined],
        [
            { catalogJson: "é".repeat(APP_SETUP_MAX_BYTES / 2 + 1) },
            "https://app.example",
            undefined,
        ],
    ])(
        "rejects unbound/oversized results without losing the valid consent response",
        async (extra, origin, source) => {
            const f = fixture();
            f.target();
            f.reply(extra, origin, source ?? f.receiver);
            await Promise.resolve();
            expect(f.results()).toEqual([]);
            f.reply();
            await Promise.resolve();
            expect(f.results()).toHaveLength(1);
        },
    );
    it.each(["", "https://other.example", "https://app.example/path", "http://remote.example"])(
        "refuses unconfigured/mismatched frame origin %s",
        async (origin) => {
            const f = fixture(origin);
            f.target();
            await Promise.resolve();
            expect(f.frame.hasAttribute("src")).toBe(false);
            expect(f.receiver.postMessage).not.toHaveBeenCalled();
            expect(f.channel.close).toHaveBeenCalledOnce();
            expect(f.results()).toEqual([]);
        },
    );
    it.each([
        { sessionNonce: "wrong" },
        { extra: true },
        { setupUrl: "https://app.example/connect?private=x" },
        { setupUrl: "https://app.example/connect#private" },
        { setupUrl: "javascript:alert(1)" },
        { appId: "" },
    ])("does not frame invalid/unbound setup targets", (extra) => {
        const f = fixture();
        f.host("setup-target", {
            appId: "sample",
            setupUrl: "https://app.example/connect",
            ...extra,
        });
        expect(f.frame.hasAttribute("src")).toBe(false);
        expect(f.receiver.postMessage).not.toHaveBeenCalled();
    });
    it("forwards a scoped request without URL metadata and returns its exact bound reply", async () => {
        const f = fixture();
        const accountId = "A".repeat(43),
            handle = "B".repeat(42) + "A";
        const setupContext = { version: 2, scope: "chat", accountId, handle };
        f.host("setup-target", {
            appId: "sample",
            setupUrl: "https://app.example/connect",
            setupContext,
        });
        expect(f.frame.src).toBe("https://app.example/connect");
        expect(f.receiver.postMessage.mock.calls[0][0]).toMatchObject({ version: 2, setupContext });
        const catalogJson = JSON.stringify({ version: 1, apps: [{ id: "sample" }] });
        const result = JSON.stringify({
            version: 2,
            scope: "chat",
            appId: "sample",
            accountId,
            catalogJson,
            routes: [{ handle, catalogJson }],
        });
        f.reply({ version: 2, catalogJson: result });
        await Promise.resolve();
        expect(f.results()).toEqual([
            { type: "setup-result", version: 1, sessionNonce: nonce, catalogJson: result },
        ]);
    });
    it.each(["cancel", "pagehide", "decode", "timeout", "stop"])(
        "has no automatic share or retry after %s",
        async (reason) => {
            const f = fixture();
            f.target();
            const accepted = f.frame.src;
            if (reason === "cancel") f.host("setup-cancel");
            else if (reason === "pagehide") window.dispatchEvent(new Event("pagehide"));
            else if (reason === "decode") f.channel.onmessageerror?.();
            else if (reason === "stop") stop!();
            else await vi.advanceTimersByTimeAsync(600_000);
            f.reply();
            f.host("setup-target", { appId: "sample", setupUrl: "https://other.example/connect" });
            await Promise.resolve();
            expect(f.results()).toEqual([]);
            expect(f.frame.src).toBe(accepted);
            expect(f.channel.close).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBe(0);
        },
    );
});
