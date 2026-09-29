// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { localAppRelayPlugin } from "./localAppRelayBuild.mjs";

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
});
