import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compileString } from "sass";
import { describe, expect, test } from "vitest";
import { resolveDevAllowedHost, resolveLocalDevAllowedHost } from "../devAllowedHost.mjs";
import { resolveDevHmrConfig } from "../devHmr";
import { resolveDevPort } from "../devPort";

const appRoot = existsSync(resolve(process.cwd(), "app", "index.html"))
    ? resolve(process.cwd(), "app")
    : process.cwd();
const readAppFile = (path: string) => readFileSync(resolve(appRoot, path), "utf8");
const indexHtml = readAppFile("index.html");
const main = readAppFile("src/main.ts");
const globalStyles = readAppFile("src/styles/global.scss");
const rollupExtras = readAppFile("rollup.extras.mjs");
const svelteConfig = readAppFile("svelte.config.js");
const viteConfig = readAppFile("vite.config.ts");

describe("application bootstrap security", () => {
    test("keeps build-time CSP and version injection without loopback telemetry", () => {
        expect(indexHtml).toContain("<%- csp %>");
        expect(indexHtml).toContain("<%- injectScript %>");
        expect(indexHtml).not.toMatch(/<base[^>]+localhost/i);
        expect(indexHtml).not.toContain("127.0.0.1:38291");
        expect(indexHtml).not.toContain("__ocsend");
        expect(indexHtml).not.toContain("/src/main.ts");
    });

    test("selects desktop or mobile root without debug instrumentation", () => {
        expect(main).toContain("./components/App.svelte");
        expect(main).toContain("./components_mobile/App.svelte");
        expect(main).toContain("v2 ? mount(AppV2");
        expect(main).toContain(": mount(App");
        expect(main).not.toContain("__ocsend");
        expect(main).not.toContain("OC-DEBUG");
    });

    test("retains the cross-platform Windows Sass path fix", () => {
        expect(rollupExtras).toContain("export const stylesDir");
        expect(rollupExtras).toContain("@use 'mixins' as *");
        expect(svelteConfig).toContain("loadPaths: [stylesDir]");
        expect(svelteConfig).toContain("includePaths: [stylesDir]");
        expect(viteConfig).toContain("loadPaths: [stylesDir]");
        expect(viteConfig).toContain("includePaths: [stylesDir]");
        expect(globalStyles.split(/\r?\n/, 1)[0]).toContain("@use");
        expect(globalStyles).toContain("./mixins");

        const globalStylesPath = resolve(appRoot, "src/styles/global.scss");
        expect(() =>
            compileString(
                "@use 'sass:math'; @use 'sass:map'; @use 'mixins' as *;\n" + globalStyles,
                {
                    loadPaths: [resolve(appRoot, "src/styles")],
                    url: pathToFileURL(globalStylesPath),
                },
            ),
        ).not.toThrow();
    });

    test("uses one configurable port for the dev listener and HMR client", () => {
        expect(resolveDevPort(undefined)).toBe(5001);
        expect(resolveDevPort("5003")).toBe(5003);
        for (const invalid of ["", "0", "65536", "5003.5", "not-a-port", " 5003 "]) {
            expect(() => resolveDevPort(invalid)).toThrow("OC_DEV_PORT must be a valid TCP port");
        }
        expect(viteConfig).toContain("resolveDevPort(process.env.OC_DEV_PORT)");
        expect(viteConfig).toMatch(/server:\s*\{[\s\S]*?\bport,[\s\S]*?strictPort/);
        expect(resolveDevHmrConfig(5003, undefined)).toEqual({
            protocol: "ws",
            port: 5003,
            clientPort: 5003,
        });
        expect(resolveDevHmrConfig(5003, "openchat-dev.example.ts.net")).toEqual({
            protocol: "wss",
            host: "openchat-dev.example.ts.net",
            port: 5003,
            clientPort: 443,
        });
        expect(viteConfig).toContain("resolveDevHmrConfig(port, devAllowedHost)");
        expect(viteConfig).toContain("hmr: devHmr");
        expect(viteConfig).toContain("strictPort: true");
    });

    test("allows only one explicitly configured development proxy hostname", () => {
        expect(resolveDevAllowedHost(undefined)).toBeUndefined();
        expect(resolveDevAllowedHost("openchat-dev.example.ts.net")).toBe(
            "openchat-dev.example.ts.net",
        );
        expect(resolveDevAllowedHost("OPENCHAT-DEV.EXAMPLE.TS.NET")).toBe(
            "openchat-dev.example.ts.net",
        );
        expect(
            resolveLocalDevAllowedHost("development", "local", "OPENCHAT-DEV.EXAMPLE.TS.NET"),
        ).toBe("openchat-dev.example.ts.net");
        expect(
            resolveLocalDevAllowedHost("production", "local", "openchat-dev.example.ts.net"),
        ).toBeUndefined();
        expect(
            resolveLocalDevAllowedHost("development", "ic", "openchat-dev.example.ts.net"),
        ).toBeUndefined();
        for (const invalid of [
            " openchat-dev.example.ts.net",
            "https://openchat-dev.example.ts.net",
            "openchat-dev.example.ts.net:443",
            "openchat-dev.example.ts.net/path",
            ".example.ts.net",
            "example..ts.net",
        ]) {
            expect(() => resolveDevAllowedHost(invalid)).toThrow("OC_DEV_ALLOWED_HOST");
        }
        expect(viteConfig).toContain("resolveLocalDevAllowedHost(");
        expect(viteConfig).toContain('"import.meta.env.OC_DEV_ALLOWED_HOST"');
        expect(viteConfig).toContain('allowedHosts: ["host.docker.internal"');
        expect(viteConfig).not.toContain("allowedHosts: true");
    });

    test("keeps mobile icons on the application's initialized Svelte runtime", () => {
        expect(viteConfig).toMatch(
            /optimizeDeps:\s*\{[\s\S]*?exclude:\s*\["svelte-material-icons"\]/,
        );
    });

    test("rewrites the external development host before proxying replica API calls", () => {
        expect(viteConfig).toMatch(
            /"\/api":\s*\{[\s\S]*?target:\s*`http:\/\/\$\{dfxJson\.networks\.local\.bind\}`,[\s\S]*?changeOrigin:\s*true/,
        );
        expect(viteConfig).toContain('proxyRequest.removeHeader("x-forwarded-host")');
        expect(viteConfig).toContain('proxyRequest.removeHeader("x-forwarded-port")');
        expect(viteConfig).toContain('proxyRequest.removeHeader("forwarded")');
    });
});
