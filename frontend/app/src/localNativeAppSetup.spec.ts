// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost:45678/setup"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSetupChallenge, startLocalNativeAppSetup } from "./localNativeAppSetup";
import { openAppSetupFrame } from "./utils/localAppSetupPopup";
vi.mock("./utils/localAppSetupPopup", async (original) => ({
    ...(await original<object>()),
    openAppSetupFrame: vi.fn(),
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
    vi.clearAllMocks();
    history.replaceState(null, "", `/setup#bootstrap=${"c".repeat(64)}`);
});
afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
describe("native setup fixed page", () => {
    it("accepts a bounded scoped challenge larger than the legacy metadata-only cap", async () => {
        const catalogJson = JSON.stringify({
            version: 1,
            apps: [{ id: "sample", note: "a".repeat(17000) }],
        });
        const setupContext = {
            version: 2,
            scope: "account",
            accountId: "A".repeat(43),
            routes: [],
            legacyCatalogJson: catalogJson,
        };
        expect(
            await readSetupChallenge(
                new Response(JSON.stringify({ ...challenge(), setupContext })),
            ),
        ).toMatchObject({ setupContext });
        await expect(
            readSetupChallenge(
                new Response(
                    JSON.stringify({
                        ...challenge(),
                        setupContext: { ...setupContext, handle: "A".repeat(43) },
                    }),
                ),
            ),
        ).rejects.toThrow();
    });
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
    it("opens the normal app frame automatically and keeps native authority out of app packets", async () => {
        document.body.innerHTML =
            '<p id="setup-status"></p><iframe id="app-setup" hidden></iframe>';
        const value = challenge();
        const fetcher = vi
            .fn()
            .mockResolvedValueOnce(new Response(JSON.stringify(value)))
            .mockResolvedValueOnce(new Response("{}"));
        vi.stubGlobal("fetch", fetcher);
        vi.mocked(openAppSetupFrame).mockResolvedValue('{"version":1,"apps":[]}');
        cleanup = startLocalNativeAppSetup();
        expect(location.hash).toBe("");
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
        expect(openAppSetupFrame).toHaveBeenCalledWith(
            "sample",
            "https://app.example/connect",
            expect.any(AbortSignal),
            document.querySelector("#app-setup"),
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
            '<p id="setup-status"></p><iframe id="app-setup" hidden></iframe>';
        let resolvePopup!: (value: string) => void;
        vi.mocked(openAppSetupFrame).mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolvePopup = resolve;
                }),
        );
        const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(challenge())));
        vi.stubGlobal("fetch", fetcher);
        cleanup = startLocalNativeAppSetup();
        await vi.waitFor(() => expect(openAppSetupFrame).toHaveBeenCalled());
        cleanup();
        resolvePopup("{}");
        await Promise.resolve();
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it("keeps scoped metadata in the app message, not native URLs or result authority", async () => {
        document.body.innerHTML =
            '<p id="setup-status"></p><iframe id="app-setup" hidden></iframe>';
        const setupContext = {
            version: 2,
            scope: "chat",
            accountId: "A".repeat(43),
            handle: "B".repeat(42) + "A",
        };
        const fetcher = vi
            .fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({ ...challenge(), setupContext })))
            .mockResolvedValueOnce(new Response("{}"));
        vi.stubGlobal("fetch", fetcher);
        vi.mocked(openAppSetupFrame).mockResolvedValue("scoped-result");
        cleanup = startLocalNativeAppSetup();
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
        expect(openAppSetupFrame).toHaveBeenCalledWith(
            "sample",
            "https://app.example/connect",
            expect.any(AbortSignal),
            document.querySelector("#app-setup"),
            setupContext,
        );
        expect(fetcher.mock.calls.map((call) => call[0])).toEqual(["/challenge", "/result"]);
        expect(JSON.parse(fetcher.mock.calls[1][1].body).catalogJson).toBe("scoped-result");
    });
});
