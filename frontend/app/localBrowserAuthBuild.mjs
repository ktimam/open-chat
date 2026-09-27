import fs from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";

/** Bundled first-party signer only; no runtime source URL or arbitrary entrypoint is accepted. */
export function localBrowserAuthBuildPlugin({ enabled = false, identityCanister } = {}) {
    return {
        name: "local-browser-auth-assets",
        async generateBundle() {
            if (!enabled) return;
            if (typeof identityCanister !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(identityCanister)) {
                throw new Error("Local browser sign-in requires the official identity canister");
            }
            const html = await fs.readFile(new URL("./local-browser-auth.html", import.meta.url), "utf8");
            if (!html.includes('src="/sign-in.js"')) throw new Error("Local browser signer HTML must load its fixed native script path");
            const result = await build({
                entryPoints: [fileURLToPath(new URL("./src/localBrowserAuth.ts", import.meta.url))],
                tsconfig: fileURLToPath(new URL("./tsconfig.json", import.meta.url)),
                bundle: true, write: false, platform: "browser", format: "iife", target: "es2022", minify: true,
                define: { __LOCAL_IDENTITY_CANISTER__: JSON.stringify(identityCanister), "process.env.NODE_ENV": '"production"' },
            });
            const script = result.outputFiles?.[0]?.contents;
            if (script === undefined || script.byteLength === 0 || script.byteLength > 4 * 1024 * 1024) {
                throw new Error("Local browser signer did not produce a bounded script");
            }
            this.emitFile({ type: "asset", fileName: "local-browser-auth.html", source: html });
            this.emitFile({ type: "asset", fileName: "local-browser-auth.js", source: script });
        },
    };
}
