// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { localAppRelayPlugin } from "./localAppRelayBuild.mjs";
import { localAppRelayHeaders } from "./localAppRelayHeaders.mjs";

vi.mock("vite", () => ({
    build: vi.fn(async () => ({ output: [{ type: "chunk", code: "/* synthetic relay */" }] })),
}));

describe("local relay dev route priority", () => {
    it.each([false, true])("runs before the HTML plugin history fallback (setup=%s)", (setup) => {
        const plugin = localAppRelayPlugin({ enabled: true, setup });
        expect(plugin.enforce).toBe("pre");
        const use = vi.fn();
        plugin.configureServer({ middlewares: { use } });
        const handle = use.mock.calls[0][0];
        const next = vi.fn();
        const response = { statusCode: 200, end: vi.fn() };
        handle(
            {
                url: setup ? "/local-app-setup.html" : "/local-app-handoff.html",
                method: "GET",
                headers: { accept: "text/html,application/xhtml+xml" },
            },
            response,
            next,
        );
        // Fail closed while compiling rather than passing this navigation to index.html.
        expect(response.statusCode).toBe(503);
        expect(response.end).toHaveBeenCalledOnce();
        expect(next).not.toHaveBeenCalled();
    });
    it.each([false, true])(
        "pins one frame publisher in emitted HTML and dev headers (setup=%s)",
        async (setup) => {
            const plugin = localAppRelayPlugin({
                enabled: true,
                setup,
                appDirectoryUrl: "http://localhost:3000/openchat/apps-v1.json",
            });
            await plugin.buildStart();
            const emitFile = vi.fn();
            plugin.generateBundle.call({ emitFile });
            const html = emitFile.mock.calls
                .map(([asset]) => asset)
                .find((asset) => asset.fileName.endsWith(".html"))?.source;
            expect(html).toContain('data-app-origin="http://localhost:3000"');
            expect(html).toContain("<iframe");
            expect(html).not.toMatch(/<button|id="(?:review|continue|send|open-app)"/);
            const use = vi.fn();
            plugin.configureServer({ middlewares: { use } });
            const response = { setHeader: vi.fn(), end: vi.fn(), statusCode: 200 };
            use.mock.calls[0][0](
                { url: setup ? "/local-app-setup.html" : "/local-app-handoff.html", method: "GET" },
                response,
                vi.fn(),
            );
            for (const [key, value] of Object.entries(
                localAppRelayHeaders("http://localhost:3000"),
            ))
                expect(response.setHeader).toHaveBeenCalledWith(key, value);
            expect(response.end).toHaveBeenCalledWith(html);
        },
    );
    it("does not derive a publisher from runtime request input or accept broad frame configuration", () => {
        for (const appDirectoryUrl of [
            "*",
            "https://*.example/apps.json",
            "https://app.example/apps.json?secret=x",
            "http://remote.example/apps.json",
            "https://user:pass@app.example/apps.json",
        ])
            expect(() => localAppRelayPlugin({ enabled: true, appDirectoryUrl })).toThrow();
    });
});
