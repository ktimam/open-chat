// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://client.example/local-app-setup.html"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    APP_SETUP_MAX_BYTES,
    APP_SETUP_TIMEOUT_MS,
    boundedSetupCatalog,
    openAppSetupFrame,
    openAppSetupPopup,
    validSetupTarget,
} from "./localAppSetupPopup";
import { parseLocalAppSetupContext, type LocalAppSetupContext } from "./localAppScopedSetup";

describe.each(["popup", "frame"])("app setup %s consent boundary", (mode) => {
    let popup: { closed: boolean; postMessage: ReturnType<typeof vi.fn> };
    let controller: AbortController;
    let frame: HTMLIFrameElement;
    const connect = (
        appId: string,
        url: string,
        signal: AbortSignal,
        context?: LocalAppSetupContext,
    ) =>
        mode === "popup"
            ? openAppSetupPopup(appId, url, signal, context)
            : openAppSetupFrame(appId, url, signal, frame, context);
    beforeEach(() => {
        vi.useFakeTimers();
        popup = { closed: false, postMessage: vi.fn() };
        controller = new AbortController();
        frame = document.createElement("iframe");
        frame.hidden = true;
        Object.defineProperty(frame, "contentWindow", { value: popup, configurable: true });
        vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    });
    afterEach(() => {
        controller.abort();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });
    function reply(extra = {}, origin = "https://app.example", source: object = popup) {
        const hello = popup.postMessage.mock.calls[0][0];
        window.dispatchEvent(
            new MessageEvent("message", {
                origin,
                source: source as Window,
                data: {
                    type: "oc:app-setup:result",
                    version: 1,
                    connectionId: hello.connectionId,
                    appId: "sample",
                    catalogJson: '{"version":1}',
                    ...extra,
                },
            }),
        );
    }
    it("opens only the public URL and sends no message/account/draft content", async () => {
        const promise = connect("sample", "https://app.example/connect", controller.signal);
        if (mode === "popup")
            expect(window.open).toHaveBeenCalledWith("https://app.example/connect", "_blank");
        else {
            expect(window.open).not.toHaveBeenCalled();
            expect(frame.src).toBe("https://app.example/connect");
            expect(frame.hidden).toBe(false);
        }
        const hello = popup.postMessage.mock.calls[0][0];
        expect(Object.keys(hello).sort()).toEqual(["appId", "connectionId", "type", "version"]);
        expect(hello.connectionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(popup.postMessage.mock.calls[0][1]).toBe("https://app.example");
        reply();
        await expect(promise).resolves.toBe('{"version":1}');
        expect(vi.getTimerCount()).toBe(0);
    });
    it("binds v2 metadata only through source/origin-checked messages, never the URL", async () => {
        const context = parseLocalAppSetupContext({
            version: 2,
            scope: "chat",
            accountId: "A".repeat(43),
            handle: "B".repeat(42) + "A",
        });
        const catalogJson = JSON.stringify({ version: 1, apps: [{ id: "sample" }] });
        const result = JSON.stringify({
            version: 2,
            scope: "chat",
            appId: "sample",
            accountId: context.accountId,
            catalogJson,
            routes: [{ handle: "B".repeat(42) + "A", catalogJson }],
        });
        const promise = connect(
            "sample",
            "https://app.example/connect",
            controller.signal,
            context,
        );
        expect(popup.postMessage.mock.calls[0][0]).toEqual({
            type: "oc:app-setup:connect",
            version: 2,
            connectionId: expect.any(String),
            appId: "sample",
            setupContext: context,
        });
        expect(popup.postMessage.mock.calls[0][1]).toBe("https://app.example");
        if (mode === "popup")
            expect(window.open).toHaveBeenCalledWith("https://app.example/connect", "_blank");
        else expect(frame.src).toBe("https://app.example/connect");
        const settled = vi.fn();
        void promise.then(settled);
        reply({ version: 1, catalogJson: result });
        reply({ version: 2, catalogJson: result }, "https://evil.example");
        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();
        reply({ version: 2, catalogJson: result });
        await expect(promise).resolves.toBe(result);
        expect(vi.getTimerCount()).toBe(0);
    });
    it.each([
        [{}, "https://wrong.example", undefined],
        [{}, "https://app.example", {}],
        [{ appId: "other" }, "https://app.example", undefined],
        [{ connectionId: "A".repeat(43) }, "https://app.example", undefined],
        [{ hidden: "extra" }, "https://app.example", undefined],
        [{ catalogJson: "x".repeat(APP_SETUP_MAX_BYTES + 1) }, "https://app.example", undefined],
    ])("ignores unbound or malformed results", async (extra, origin, source) => {
        const promise = connect("sample", "https://app.example/connect", controller.signal);
        const settled = vi.fn();
        void promise.then(settled);
        reply(extra, origin, source ?? popup);
        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();
        reply();
        await promise;
    });
    it.each(["blocked", "closed", "throwing"])(
        "settles early %s popup without restarting timers",
        async (failure) => {
            if (failure === "blocked") {
                vi.mocked(window.open).mockReturnValue(null);
                Object.defineProperty(frame, "contentWindow", { value: null });
            }
            if (failure === "closed") popup.closed = true;
            if (failure === "throwing")
                popup.postMessage.mockImplementation(() => {
                    throw new Error();
                });
            await expect(
                connect("sample", "https://app.example/connect", controller.signal),
            ).rejects.toThrow();
            expect(vi.getTimerCount()).toBe(0);
        },
    );
    it("uses one fixed deadline even with repeated hellos", async () => {
        const promise = connect("sample", "https://app.example/connect", controller.signal);
        const rejection = expect(promise).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(APP_SETUP_TIMEOUT_MS);
        await rejection;
        expect(vi.getTimerCount()).toBe(0);
    });
    it("aborts without adopting a late result", async () => {
        const promise = connect("sample", "https://app.example/connect", controller.signal);
        const rejection = expect(promise).rejects.toThrow();
        controller.abort();
        reply();
        await rejection;
        expect(vi.getTimerCount()).toBe(0);
    });
    it.each([1, 2])(
        "accepts only the bound v%s Cancel and permits a fresh attempt",
        async (version) => {
            const context =
                version === 2
                    ? parseLocalAppSetupContext({ version: 2, scope: "account", routes: [] })
                    : undefined;
            const promise = connect(
                "sample",
                "https://app.example/connect",
                controller.signal,
                context,
            );
            const failed = vi.fn();
            const rejection = promise.catch(failed);
            const hello = popup.postMessage.mock.calls[0][0];
            const packet = {
                type: "oc:app-setup:cancel",
                version,
                connectionId: hello.connectionId,
                appId: "sample",
            };
            const send = (data: object, origin = "https://app.example", source: object = popup) =>
                window.dispatchEvent(
                    new MessageEvent("message", { data, origin, source: source as Window }),
                );
            send(packet, "https://wrong.example");
            send(packet, "https://app.example", {});
            send({ ...packet, connectionId: "stale" });
            send({ ...packet, appId: "other" });
            send({ ...packet, version: version === 1 ? 2 : 1 });
            send({ ...packet, catalogJson: "hidden" });
            await Promise.resolve();
            expect(failed).not.toHaveBeenCalled();
            send(packet);
            reply();
            await rejection;
            expect(failed).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBe(0);

            popup.postMessage.mockClear();
            const retry = connect("sample", "https://app.example/connect", controller.signal);
            const adopted = vi.fn();
            void retry.then(adopted);
            expect(popup.postMessage.mock.calls[0][0].connectionId).not.toBe(hello.connectionId);
            send(packet);
            await Promise.resolve();
            expect(adopted).not.toHaveBeenCalled();
            reply();
            await expect(retry).resolves.toBe('{"version":1}');
            expect(vi.getTimerCount()).toBe(0);
        },
    );
    it("counts UTF-8 bytes and rejects unsafe targets", () => {
        expect(boundedSetupCatalog("é".repeat(APP_SETUP_MAX_BYTES / 2 + 1))).toBe(false);
        for (const url of [
            "http://remote.example/connect",
            "https://u:p@app.example/",
            "https://app.example/connect?token=x",
            "https://app.example/#x",
            "javascript:alert(1)",
        ])
            expect(validSetupTarget("sample", url)).toBe(false);
        expect(validSetupTarget("sample", "http://localhost:3000/connect")).toBe(true);
    });
    it.each(["invalid", "aborted"])("never loads the %s connection target", async (reason) => {
        if (reason === "aborted") controller.abort();
        await expect(
            connect(
                "sample",
                reason === "invalid"
                    ? "https://app.example/connect?secret=x"
                    : "https://app.example/connect",
                controller.signal,
            ),
        ).rejects.toThrow();
        expect(frame.hasAttribute("src")).toBe(false);
        expect(window.open).not.toHaveBeenCalled();
        expect(popup.postMessage).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});
