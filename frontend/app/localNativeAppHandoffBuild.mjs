import fs from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";

/** Fixed first-party private-draft relay only. Disabled for all official/browser builds. */
export function localNativeAppHandoffBuildPlugin({ enabled = false } = {}) {
    return {
        name: "local-native-app-handoff-assets",
        async generateBundle() {
            if (!enabled) return;
            const html = await fs.readFile(
                new URL("./local-native-app-handoff.html", import.meta.url),
                "utf8",
            );
            if (!html.includes('src="/handoff.js"'))
                throw new Error("Private handoff HTML must use the fixed native script route");
            const result = await build({
                entryPoints: [
                    fileURLToPath(new URL("./src/localNativeAppHandoff.ts", import.meta.url)),
                ],
                tsconfig: fileURLToPath(new URL("./tsconfig.json", import.meta.url)),
                bundle: true,
                write: false,
                platform: "browser",
                format: "iife",
                target: "es2022",
                minify: true,
                define: { "process.env.NODE_ENV": '"production"' },
            });
            const script = result.outputFiles?.[0]?.contents;
            if (
                script === undefined ||
                script.byteLength === 0 ||
                script.byteLength > 1024 * 1024
            ) {
                throw new Error("Private handoff did not produce a bounded script");
            }
            this.emitFile({
                type: "asset",
                fileName: "local-native-app-handoff.html",
                source: html,
            });
            this.emitFile({
                type: "asset",
                fileName: "local-native-app-handoff.js",
                source: script,
            });
            this.emitFile({
                type: "asset",
                fileName: "local-native-app-handoff-profile.json",
                source: JSON.stringify({
                    version: 1,
                    applicationId: "dev.openchatfork.localtest",
                    transport: "private-app-code-v1",
                }),
            });
        },
    };
}
