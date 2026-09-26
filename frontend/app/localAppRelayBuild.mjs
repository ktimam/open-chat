import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "vite";

import { LOCAL_APP_RELAY_HEADERS } from "./localAppRelayHeaders.mjs";
export { LOCAL_APP_RELAY_CSP, LOCAL_APP_RELAY_HEADERS } from "./localAppRelayHeaders.mjs";

/** Fixed, non-isolated first-party handoff page only. The model page's headers never change. */
export function localAppRelayPlugin({ enabled = false } = {}) {
    let script;
    let html;
    async function compile() {
        html = await fs.readFile(new URL("./public/local-app-handoff.html", import.meta.url), "utf8");
        const result = await build({
            configFile: false, envDir: false, logLevel: "silent",
            build: { write: false, minify: true, target: "es2022", lib: {
                entry: fileURLToPath(new URL("./src/localAppHandoffRelay.ts", import.meta.url)),
                formats: ["iife"], name: "LocalAppHandoffRelay",
            } },
        });
        const output = Array.isArray(result) ? result[0].output : result.output;
        script = output.find((item) => item.type === "chunk")?.code;
        if (typeof script !== "string") throw new Error("Local handoff relay could not be built");
    }
    return {
        name: "local-app-handoff-relay",
        // vite-plugin-html installs a pre history fallback. Handle browser navigation Accept
        // headers first or the relay becomes index.html with the main client's isolated policy.
        enforce: "pre",
        async buildStart() { if (enabled) await compile(); },
        configureServer(server) {
            if (!enabled) return;
            server.middlewares.use((req, res, next) => {
                const route = req.url?.split("?")[0];
                if (route !== "/local-app-handoff.html" && route !== "/local-app-handoff.js") return next();
                if (req.method !== "GET" && req.method !== "HEAD") { res.statusCode = 405; res.end(); return; }
                if (script === undefined || html === undefined) { res.statusCode = 503; res.end(); return; }
                for (const [key, value] of Object.entries(LOCAL_APP_RELAY_HEADERS)) res.setHeader(key, value);
                res.setHeader("Content-Type", route.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8");
                res.end(req.method === "HEAD" ? undefined : route.endsWith(".js") ? script : html);
            });
        },
        generateBundle() {
            if (!enabled) return;
            this.emitFile({ type: "asset", fileName: "local-app-handoff.html", source: html });
            this.emitFile({ type: "asset", fileName: "local-app-handoff.js", source: script });
        },
    };
}
