// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost:45678/setup"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSetupChallenge, startLocalNativeAppSetup } from "./localNativeAppSetup";
import { openAppSetupPopup } from "./utils/localAppSetupPopup";
vi.mock("./utils/localAppSetupPopup", async (original) => ({
    ...(await original<object>()),
    openAppSetupPopup: vi.fn(),
}));
const challenge = () => ({
    version: 1,
    setupId: "a".repeat(32),
    appId: "sample",
    setupUrl: "https://app.example/connect",
    expiresAtMs: Date.now() + 600000,
    browserProofHex: "b".repeat(64),
});
let cleanup: (() => void) | undefined;
beforeEach(() => {
    history.replaceState(null, "", `/setup#bootstrap=${"c".repeat(64)}`);
});
afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
describe("native setup fixed page", () => {
    it.each([
        { extra: "no" },
        { version: 2 },
        { setupId: "bad" },
        { browserProofHex: "bad" },
        { setupUrl: "http://external.example/connect" },
        { expiresAtMs: 1 },
        { expiresAtMs: Date.now() + 3600000 },
    ])("rejects malformed or expired challenge", async (change) => {
        await expect(
            readSetupChallenge(new Response(JSON.stringify({ ...challenge(), ...change }))),
        ).rejects.toThrow();
    });
    it("rejects oversized challenge before parsing", async () => {
        await expect(readSetupChallenge(new Response("x".repeat(16385)))).rejects.toThrow();
    });
    it("opens only after click and keeps the native proof out of the app packet", async () => {
        document.body.innerHTML =
            '<p id="setup-status"></p><button id="connect-app" disabled>Connect</button>';
        const value = challenge();
        const fetcher = vi
            .fn()
            .mockResolvedValueOnce(new Response(JSON.stringify(value)))
            .mockResolvedValueOnce(new Response("{}"));
        vi.stubGlobal("fetch", fetcher);
        vi.mocked(openAppSetupPopup).mockResolvedValue('{"version":1,"apps":[]}');
        cleanup = startLocalNativeAppSetup();
        expect(location.hash).toBe("");
        const button = document.querySelector<HTMLButtonElement>("#connect-app")!;
        await vi.waitFor(() => expect(button.disabled).toBe(false));
        expect(openAppSetupPopup).not.toHaveBeenCalled();
        button.click();
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
        expect(openAppSetupPopup).toHaveBeenCalledWith(
            "sample",
            "https://app.example/connect",
            expect.any(AbortSignal),
        );
        expect(fetcher.mock.calls[0][1]).toMatchObject({
            headers: { "X-OpenChat-Setup-Bootstrap": "c".repeat(64) },
            credentials: "omit",
            redirect: "error",
            mode: "same-origin",
        });
        const [route, options] = fetcher.mock.calls[1];
        expect(route).toBe("/result");
        expect(JSON.parse(options.body)).toEqual({
            version: 1,
            setupId: value.setupId,
            browserProofHex: value.browserProofHex,
            catalogJson: '{"version":1,"apps":[]}',
        });
        expect(options).toMatchObject({
            method: "POST",
            credentials: "omit",
            redirect: "error",
            mode: "same-origin",
        });
    });
    it("does not reconnect or post after page teardown", async () => {
        document.body.innerHTML =
            '<p id="setup-status"></p><button id="connect-app" disabled>Connect</button>';
        let resolvePopup!: (value: string) => void;
        vi.mocked(openAppSetupPopup).mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolvePopup = resolve;
                }),
        );
        const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(challenge())));
        vi.stubGlobal("fetch", fetcher);
        cleanup = startLocalNativeAppSetup();
        const button = document.querySelector<HTMLButtonElement>("#connect-app")!;
        await vi.waitFor(() => expect(button.disabled).toBe(false));
        button.click();
        cleanup();
        resolvePopup("{}");
        await Promise.resolve();
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
});
