// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://client.example/communities"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectBrowserAppSetup, connectNativeAppSetup } from "./localAppSetupConnection";
import type { LocalAppDirectoryDescriptor } from "./localAppDirectory";
import { APP_SETUP_TIMEOUT_MS } from "./localAppSetupPopup";
import { parseLocalAppSetupContext } from "./localAppScopedSetup";
const scopedCatalog = JSON.stringify({ version: 1, apps: [{ id: "sample" }] });
const scopedContext = parseLocalAppSetupContext({
    version: 2,
    scope: "chat",
    accountId: "A".repeat(43),
    handle: "B".repeat(42) + "A",
});
const scopedResult = JSON.stringify({
    version: 2,
    scope: "chat",
    appId: "sample",
    accountId: "A".repeat(43),
    catalogJson: scopedCatalog,
    routes: [{ handle: "B".repeat(42) + "A", catalogJson: scopedCatalog }],
});
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false }));
const native = vi.hoisted(() => ({
    begin: vi.fn(),
    poll: vi.fn(),
    cancel: vi.fn(),
    open: vi.fn(),
}));
vi.mock("tauri-plugin-oc-api/commands/localAppSetup", () => ({
    beginLocalAppSetup: native.begin,
    pollLocalAppSetup: native.poll,
    cancelLocalAppSetup: native.cancel,
}));
vi.mock("tauri-plugin-oc-api/commands/openUrl", () => ({ openUrl: native.open }));
class Channel {
    static latest: Channel;
    onmessage?: (event: { data: unknown }) => void;
    onmessageerror?: () => void;
    postMessage = vi.fn();
    close = vi.fn();
    constructor(public name: string) {
        Channel.latest = this;
    }
    receive(data: unknown) {
        this.onmessage?.({ data });
    }
}
describe("app connection host", () => {
    let controller: AbortController;
    const target = { id: "sample", setupUrl: "https://app.example/connect" };
    beforeEach(() => {
        vi.useFakeTimers();
        controller = new AbortController();
        vi.stubGlobal("BroadcastChannel", Channel);
        vi.spyOn(window, "open").mockReturnValue({} as Window);
    });
    afterEach(() => {
        controller.abort();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });
    const common = () => ({ version: 1, sessionNonce: Channel.latest.name.split(":")[1] });
    it("sends scoped context only through the channel and rejects a mismatched reply", async () => {
        const promise = connectBrowserAppSetup(target, controller.signal, scopedContext);
        const assertion = expect(promise).rejects.toThrow();
        const channel = Channel.latest;
        channel.receive({ type: "setup-ready", ...common() });
        expect(channel.postMessage).toHaveBeenLastCalledWith({
            type: "setup-target",
            ...common(),
            appId: "sample",
            setupUrl: target.setupUrl,
            setupContext: scopedContext,
        });
        expect(String(vi.mocked(window.open).mock.calls[0][0])).not.toContain(
            scopedContext.accountId,
        );
        channel.receive({
            type: "setup-result",
            ...common(),
            catalogJson: scopedResult.replace('"scope":"chat"', '"scope":"account"'),
        });
        await assertion;
        expect(channel.close).toHaveBeenCalledOnce();
    });
    it("returns a complete scoped browser reply", async () => {
        const promise = connectBrowserAppSetup(target, controller.signal, scopedContext);
        Channel.latest.receive({ type: "setup-ready", ...common() });
        Channel.latest.receive({ type: "setup-result", ...common(), catalogJson: scopedResult });
        await expect(promise).resolves.toBe(scopedResult);
    });
    it.each([true, false])(
        "opens immediately but waits for verified context (scoped=%s)",
        async (scoped) => {
            let resolveContext!: (value: typeof scopedContext | undefined) => void;
            const context = new Promise<typeof scopedContext | undefined>((resolve) => {
                resolveContext = resolve;
            });
            const promise = connectBrowserAppSetup(target, controller.signal, context);
            expect(window.open).toHaveBeenCalledOnce();
            const channel = Channel.latest;
            channel.receive({ type: "setup-ready", ...common() });
            expect(channel.postMessage).not.toHaveBeenCalled();
            resolveContext(scoped ? scopedContext : undefined);
            await Promise.resolve();
            expect(channel.postMessage).toHaveBeenCalledOnce();
            channel.receive({
                type: "setup-result",
                ...common(),
                catalogJson: scoped ? scopedResult : "{}",
            });
            await expect(promise).resolves.toBe(scoped ? scopedResult : "{}");
        },
    );
    it.each(["abort", "timeout", "reject"])(
        "settles pending context on %s and ignores late resolution",
        async (mode) => {
            let resolveContext!: (value: typeof scopedContext) => void;
            let rejectContext!: () => void;
            const context = new Promise<typeof scopedContext>((resolve, reject) => {
                resolveContext = resolve;
                rejectContext = reject;
            });
            const promise = connectBrowserAppSetup(target, controller.signal, context);
            const assertion = expect(promise).rejects.toThrow();
            const channel = Channel.latest;
            channel.receive({ type: "setup-ready", ...common() });
            if (mode === "abort") controller.abort();
            if (mode === "timeout") await vi.advanceTimersByTimeAsync(APP_SETUP_TIMEOUT_MS);
            if (mode === "reject") rejectContext();
            await assertion;
            resolveContext(scopedContext);
            await Promise.resolve();
            expect(
                channel.postMessage.mock.calls.some(([packet]) => packet.type === "setup-target"),
            ).toBe(false);
            expect(channel.close).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBe(0);
        },
    );
    it("opens synchronously with nonce only, sends only public target and adopts one bound result", async () => {
        const promise = connectBrowserAppSetup(target, controller.signal);
        expect(window.open).toHaveBeenCalledOnce();
        const url = new URL(vi.mocked(window.open).mock.calls[0][0] as string);
        expect(url.origin + url.pathname).toBe("https://client.example/local-app-setup.html");
        expect([...new URLSearchParams(url.hash.slice(1)).keys()]).toEqual(["sessionNonce"]);
        const channel = Channel.latest;
        channel.receive({ type: "setup-ready", ...common() });
        expect(channel.postMessage).toHaveBeenLastCalledWith({
            type: "setup-target",
            ...common(),
            appId: "sample",
            setupUrl: target.setupUrl,
        });
        channel.receive({ type: "setup-result", ...common(), catalogJson: "{}" });
        await expect(promise).resolves.toBe("{}");
        expect(channel.close).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });
    it("ignores early/wrong nonce/extra field results", async () => {
        const promise = connectBrowserAppSetup(target, controller.signal);
        const settled = vi.fn();
        void promise.then(settled);
        const channel = Channel.latest;
        channel.receive({ type: "setup-result", ...common(), catalogJson: "early" });
        channel.receive({ type: "setup-ready", ...common() });
        channel.receive({
            type: "setup-result",
            ...common(),
            sessionNonce: "wrong",
            catalogJson: "wrong",
        });
        channel.receive({ type: "setup-result", ...common(), catalogJson: "wrong", extra: true });
        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();
        channel.receive({ type: "setup-result", ...common(), catalogJson: "correct" });
        await expect(promise).resolves.toBe("correct");
    });
    it.each(["block", "throw", "abort", "timeout", "decode"])(
        "closes on %s without hanging",
        async (mode) => {
            if (mode === "block") vi.mocked(window.open).mockReturnValue(null);
            if (mode === "throw")
                vi.mocked(window.open).mockImplementation(() => {
                    throw new Error();
                });
            const promise = connectBrowserAppSetup(target, controller.signal);
            const assertion = expect(promise).rejects.toThrow();
            if (mode === "abort") controller.abort();
            if (mode === "timeout") await vi.advanceTimersByTimeAsync(APP_SETUP_TIMEOUT_MS);
            if (mode === "decode") Channel.latest.onmessageerror?.();
            await assertion;
            expect(Channel.latest.close).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBe(0);
        },
    );
});

describe("native app connection host", () => {
    const descriptor: LocalAppDirectoryDescriptor = {
        id: "sample",
        name: "Sample",
        description: "Test",
        revision: "v1",
        setupUrl: "https://app.example/connect",
        catalog: { url: "https://app.example/app.json", sha256: "a".repeat(64), byteLength: 1 },
        processor: { url: "https://app.example/app.js", sha256: "b".repeat(64), byteLength: 1 },
    };
    beforeEach(() => {
        vi.resetAllMocks();
        native.begin.mockResolvedValue({
            setupId: "a".repeat(32),
            url: `http://localhost:5193/setup#bootstrap=${"c".repeat(64)}`,
            expiresAtMs: Date.now() + APP_SETUP_TIMEOUT_MS,
        });
        native.cancel.mockResolvedValue(undefined);
        native.open.mockResolvedValue("ok");
        native.poll.mockResolvedValue({
            phase: "received",
            expiresAtMs: Date.now() + APP_SETUP_TIMEOUT_MS,
            catalogJson: "{}",
        });
    });
    it("passes only the public target and always clears the native attempt after receiving setup", async () => {
        await expect(connectNativeAppSetup(descriptor, new AbortController().signal)).resolves.toBe(
            "{}",
        );
        expect(native.begin).toHaveBeenCalledWith({
            appId: "sample",
            setupUrl: descriptor.setupUrl,
        });
        expect(native.open).toHaveBeenCalledWith({
            url: `http://localhost:5193/setup#bootstrap=${"c".repeat(64)}`,
        });
        expect(native.cancel).toHaveBeenCalledWith("a".repeat(32));
    });
    it("passes scoped metadata to the native challenge, validates reply and clears attempt", async () => {
        native.poll.mockResolvedValue({ phase: "received", catalogJson: scopedResult });
        await expect(
            connectNativeAppSetup(descriptor, new AbortController().signal, scopedContext),
        ).resolves.toBe(scopedResult);
        expect(native.begin).toHaveBeenCalledWith({
            appId: "sample",
            setupUrl: descriptor.setupUrl,
            setupContext: scopedContext,
        });
        expect(native.cancel).toHaveBeenCalledOnce();
    });
    it("refuses a native reply for another account before installation", async () => {
        native.poll.mockResolvedValue({
            phase: "received",
            catalogJson: scopedResult.replace(
                '"accountId":"' + "A".repeat(43),
                '"accountId":"' + "C".repeat(42) + "A",
            ),
        });
        await expect(
            connectNativeAppSetup(descriptor, new AbortController().signal, scopedContext),
        ).rejects.toThrow();
        expect(native.cancel).toHaveBeenCalledOnce();
    });
    it("cancels a pending native context without beginning or opening a session", async () => {
        const controller = new AbortController();
        let resolveContext!: (value: typeof scopedContext) => void;
        const context = new Promise<typeof scopedContext>((resolve) => {
            resolveContext = resolve;
        });
        const promise = connectNativeAppSetup(descriptor, controller.signal, context);
        const assertion = expect(promise).rejects.toThrow();
        controller.abort();
        await assertion;
        resolveContext(scopedContext);
        await Promise.resolve();
        expect(native.begin).not.toHaveBeenCalled();
        expect(native.open).not.toHaveBeenCalled();
    });
    it.each([
        "http://localhost:45678/setup#bootstrap=" + "c".repeat(64),
        "http://localhost:5192/setup#bootstrap=" + "c".repeat(64),
        "http://localhost:5193/setup",
        "http://localhost:5193/setup#bootstrap=short",
        "http://evil.example:5193/setup#bootstrap=" + "c".repeat(64),
        "http://localhost:5193/setup?secret=x#bootstrap=" + "c".repeat(64),
    ])("rejects an unbound native URL", async (url) => {
        native.begin.mockResolvedValue({
            setupId: "a".repeat(32),
            url,
            expiresAtMs: Date.now() + APP_SETUP_TIMEOUT_MS,
        });
        await expect(
            connectNativeAppSetup(descriptor, new AbortController().signal),
        ).rejects.toThrow("Invalid native setup route");
        expect(native.open).not.toHaveBeenCalled();
        expect(native.cancel).toHaveBeenCalledOnce();
    });
    it("cancels while polling and refuses a late setup result", async () => {
        const controller = new AbortController();
        let resolvePoll!: (value: unknown) => void;
        native.poll.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolvePoll = resolve;
                }),
        );
        const promise = connectNativeAppSetup(descriptor, controller.signal);
        const assertion = expect(promise).rejects.toThrow();
        await vi.waitFor(() => expect(native.poll).toHaveBeenCalledOnce());
        controller.abort();
        expect(native.cancel).toHaveBeenCalled();
        resolvePoll({ phase: "received", catalogJson: "late" });
        await assertion;
    });
});
