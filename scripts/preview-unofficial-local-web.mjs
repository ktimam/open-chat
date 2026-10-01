#!/usr/bin/env node
/** Dependency-free, loopback-only preview. Never proxies requests or accepts writes. */
import { createServer } from "node:http";
import { createReadStream, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseUnofficialLocalPort } from "../frontend/unofficialLocalProfile.mjs";
import { LOCAL_APP_RELAY_HEADERS } from "../frontend/app/localAppRelayHeaders.mjs";

const MANIFEST = "unofficial-local-web.json";
const RELAY_ROUTES = new Set(["/local-app-handoff.html", "/local-app-handoff.js", "/local-app-setup.html", "/local-app-setup.js"]);
// Mirrored from the build-owned runtime identities; the source-contract test prevents drift.
const ORT_BASE = "/assets/transformers-webgpu/ort-1.29.0-dev.20260723-1b1e1db7bc";
const PINNED_RUNTIME_ROUTES = new Set([
    `${ORT_BASE}/ort-wasm-simd-threaded.jspi.mjs`,
    `${ORT_BASE}/ort-wasm-simd-threaded.jspi.wasm`,
]);
const IMMUTABLE_RUNTIME_CACHE = "public, max-age=31536000, immutable";
const MAIN_HEADERS = Object.freeze({
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "credentialless",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
});
const MIME = new Map(Object.entries({
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json", ".map": "application/json",
    ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
    ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".mp4": "video/mp4", ".webmanifest": "application/manifest+json",
}));

export function validateManifest(manifest) {
    if (typeof manifest?.port !== "number") throw new Error("Local build manifest must pin a numeric port");
    const port = parseUnofficialLocalPort(manifest?.port);
    if (manifest?.schemaVersion !== 1 || manifest.profile !== "unofficial-local-web" ||
        manifest.origin !== `http://localhost:${port}` || manifest.buildMode !== "optimized" ||
        typeof manifest.version !== "string" || !/^2\.0\.0-localtest\.[a-f0-9]{32}$/.test(manifest.version) ||
        !["v1", "v2"].includes(manifest.layout) || manifest.officialBackend !== "https://icp-api.io" ||
        manifest.existingAccountOnly !== false || manifest.clientOnlyApps !== true || manifest.ota !== "none" ||
        manifest.native !== false || manifest.runtimeNodeEnvironment !== "development" ||
        manifest.relay?.html !== "/local-app-handoff.html" || manifest.relay?.script !== "/local-app-handoff.js") {
        throw new Error("Not a supported local-only web build manifest");
    }
    return Object.freeze({ port, origin: manifest.origin, layout: manifest.layout, version: manifest.version });
}

function fileInside(root, relative) {
    const segments = relative.split("/");
    if (segments.some((part) => !part || part.startsWith(".") || /[\\:\x00-\x1f]/.test(part))) return undefined;
    let candidate = root;
    try {
        for (const segment of segments) {
            candidate = path.join(candidate, segment);
            if (lstatSync(candidate).isSymbolicLink()) return undefined;
        }
        const resolved = realpathSync(candidate);
        const contained = path.relative(root, resolved);
        if (!contained || contained.startsWith("..") || path.isAbsolute(contained)) return undefined;
        const stat = lstatSync(resolved);
        return stat.isFile() ? { path: resolved, size: stat.size } : undefined;
    } catch { return undefined; }
}

export function loadLocalWebBuild(directory) {
    if (!path.isAbsolute(directory) || lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) {
        throw new Error("Build directory must be an existing absolute non-symlink directory");
    }
    const root = realpathSync(directory);
    const manifestFile = fileInside(root, MANIFEST);
    if (!manifestFile || manifestFile.size > 4096) throw new Error("Missing or oversized local web manifest");
    const manifest = validateManifest(JSON.parse(readFileSync(manifestFile.path, "utf8")));
    for (const required of ["index.html", "local-app-handoff.html", "local-app-handoff.js"]) {
        if (!fileInside(root, required)) throw new Error(`Incomplete local build: ${required}`);
    }
    return Object.freeze({ root, ...manifest });
}

export function localPreviewHandler(build) {
    const expectedHost = `localhost:${build.port}`;
    return (request, response) => {
        for (const [name, value] of Object.entries(MAIN_HEADERS)) response.setHeader(name, value);
        const end = (status) => { response.statusCode = status; response.end(); };
        if (request.headers.host !== expectedHost ||
            (request.headers.origin !== undefined && request.headers.origin !== build.origin) ||
            request.headers["sec-fetch-site"] === "cross-site") { end(403); return; }
        if (request.method !== "GET" && request.method !== "HEAD") { response.setHeader("Allow", "GET, HEAD"); end(405); return; }
        const raw = request.url?.split("?")[0];
        if (!raw?.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || raw.includes("#")) { end(400); return; }
        let route;
        try { route = decodeURIComponent(raw); } catch { end(400); return; }
        // Only literal relay routes may relax isolation; no encoded aliases or SPA fallback.
        if (RELAY_ROUTES.has(route) && raw !== route) { end(404); return; }
        const pieces = route.slice(1).split("/");
        if (pieces.some((part) => part.startsWith(".") || /[\\:%\x00-\x1f]/.test(part)) || route.startsWith("//")) { end(400); return; }
        let file = fileInside(build.root, route === "/" ? "index.html" : route.slice(1));
        if (!file && !RELAY_ROUTES.has(route) && !path.posix.extname(route) && request.headers.accept?.includes("text/html")) {
            file = fileInside(build.root, "index.html");
        }
        if (!file) { end(404); return; }
        if (RELAY_ROUTES.has(route)) {
            for (const [name, value] of Object.entries(LOCAL_APP_RELAY_HEADERS)) response.setHeader(name, value);
        } else if (raw === route && (
            (route === "/transformers_webgpu_worker.js" && request.url === `${route}?v=${build.version}`) ||
            (PINNED_RUNTIME_ROUTES.has(route) && request.url === route)
        )) {
            // Model Manager verifies Cache API bytes AND availability in the browser HTTP cache.
            // HTML, relay and unversioned/wrong-version worker responses must remain no-store.
            response.setHeader("Cache-Control", IMMUTABLE_RUNTIME_CACHE);
        }
        response.setHeader("Content-Type", MIME.get(path.extname(file.path)) ?? "application/octet-stream");
        response.setHeader("Content-Length", file.size);
        if (request.method === "HEAD") { response.end(); return; }
        const stream = createReadStream(file.path);
        stream.once("error", () => response.destroy());
        response.once("close", () => stream.destroy());
        stream.pipe(response);
    };
}

export function parsePreviewArgs(args) {
    if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { help: true };
    if (args.length !== 2 || args[0] !== "--directory" || !args[1]) throw new Error("Use --directory <absolute local build directory>; host and port overrides are not allowed");
    return { directory: args[1] };
}

export function main(args = process.argv.slice(2)) {
    const options = parsePreviewArgs(args);
    if (options.help) { console.log("Usage: node scripts/preview-unofficial-local-web.mjs --directory <absolute local build directory>"); return; }
    const build = loadLocalWebBuild(options.directory);
    const server = createServer(localPreviewHandler(build));
    server.once("error", () => { console.error("Local preview could not listen on its pinned port; stop that port's server or build for another port."); process.exitCode = 1; });
    server.listen(build.port, "127.0.0.1", () => console.log(`Optimized local-only OpenChat (${build.layout}): ${build.origin}`));
    return server;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    try { main(); } catch (error) { console.error(error instanceof Error ? error.message : "Local preview failed"); process.exitCode = 1; }
}
