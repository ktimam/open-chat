// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { localAppRelayPlugin } from "./localAppRelayBuild.mjs";

describe("local relay dev route priority", () => {
    it("runs before the HTML plugin history fallback and claims navigation-style relay requests", () => {
        const plugin = localAppRelayPlugin({ enabled: true });
        expect(plugin.enforce).toBe("pre");
        const use = vi.fn();
        plugin.configureServer({ middlewares: { use } });
        const handle = use.mock.calls[0][0];
        const next = vi.fn();
        const response = { statusCode: 200, end: vi.fn() };
        handle(
            {
                url: "/local-app-handoff.html",
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
});
