import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLocalAppRelay, isLocalAppRelayRequest } from "./local_app_relay";

afterEach(() => vi.unstubAllGlobals());

describe("local app relay service worker bypass", () => {
    it("matches only exact handoff/setup assets, including version query strings", () => {
        const origin = "https://client.example";
        for (const path of [
            "/local-app-handoff.html",
            "/local-app-handoff.js?v=2",
            "/local-app-setup.html",
            "/local-app-setup.js?v=2",
        ])
            expect(isLocalAppRelayRequest({ url: origin + path }, origin)).toBe(true);
        for (const url of [
            origin + "/",
            origin + "/local-app-handoff.html/child",
            origin + "/other/local-app-handoff.js",
            "https://elsewhere.example/local-app-handoff.html",
            origin + "/local-app-setup.html/child",
            origin + "/other/local-app-setup.js",
            "https://elsewhere.example/local-app-setup.html",
        ])
            expect(isLocalAppRelayRequest({ url }, origin)).toBe(false);
    });
    it("preserves network response headers and bypasses caches/redirects", async () => {
        const response = new Response("relay", {
            headers: {
                "Cross-Origin-Opener-Policy": "unsafe-none",
                "Cross-Origin-Embedder-Policy": "unsafe-none",
            },
        });
        const fetchMock = vi.fn().mockResolvedValue(response);
        vi.stubGlobal("fetch", fetchMock);
        const request = new Request("https://client.example/local-app-handoff.html");
        expect(await fetchLocalAppRelay(request)).toBe(response);
        expect(fetchMock).toHaveBeenCalledExactlyOnceWith(request, {
            cache: "no-store",
            redirect: "error",
        });
    });
    it("fails offline instead of substituting the cached app document", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
        const result = await fetchLocalAppRelay(
            new Request("https://client.example/local-app-handoff.html"),
        );
        expect(result.type).toBe("error");
        expect(result.status).toBe(0);
    });
});
