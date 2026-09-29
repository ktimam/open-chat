import fs from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";

/** Fixed app-setup page, independently gated from financial-draft and authentication transports. */
export function localNativeAppSetupBuildPlugin({ enabled = false } = {}) {
    return {
        name: "local-native-app-setup-assets",
        async generateBundle() {
            if (!enabled) return;
            const html = await fs.readFile(
                new URL("./local-native-app-setup.html", import.meta.url),
                "utf8",
            );
            if (!html.includes('src="/setup.js"'))
                throw new Error("Setup HTML must use its fixed native script route");
            const result = await build({
                entryPoints: [
                    fileURLToPath(new URL("./src/localNativeAppSetup.ts", import.meta.url)),
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
            if (!script?.byteLength || script.byteLength > 1024 * 1024)
                throw new Error("Setup script is missing or oversized");
            this.emitFile({ type: "asset", fileName: "local-native-app-setup.html", source: html });
            this.emitFile({ type: "asset", fileName: "local-native-app-setup.js", source: script });
            this.emitFile({
                type: "asset",
                fileName: "local-native-app-setup-profile.json",
                source: JSON.stringify({
                    version: 1,
                    applicationId: "dev.openchatfork.localtest",
                    transport: "private-app-setup-v1",
                }),
            });
        },
    };
}
