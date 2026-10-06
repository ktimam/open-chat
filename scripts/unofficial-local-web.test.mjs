import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { parseBuildArgs, localWebBuildPlan } from "./build-unofficial-local-web.mjs";
import { loadLocalWebBuild, localPreviewHandler, parsePreviewArgs, validateManifest } from "./preview-unofficial-local-web.mjs";
import { UNOFFICIAL_LOCAL_CANISTERS } from "../frontend/unofficialLocalProfile.mjs";
import { LOCAL_APP_RELAY_HEADERS, localAppRelayHeaders, localAppRelayOrigin } from "../frontend/app/localAppRelayHeaders.mjs";

const manifest = {
    schemaVersion: 1, profile: "unofficial-local-web", buildMode: "optimized", runtimeNodeEnvironment: "development",
    version: `2.0.0-localtest.${"a".repeat(32)}`,
    port: 5194, origin: "http://localhost:5194", layout: "v2", officialBackend: "https://icp-api.io",
    existingAccountOnly: false, clientOnlyApps: true, ota: "none", native: false,
    relay: { html: "/local-app-handoff.html", script: "/local-app-handoff.js" },
};
const ortBase = "/assets/transformers-webgpu/ort-1.29.0-dev.20260723-1b1e1db7bc";
function fixture(t, populated = true) {
    const parent = mkdtempSync(path.join(os.tmpdir(), "openchat-preview-test-"));
    const root = path.join(parent, "build");
    mkdirSync(root);
    t.after(() => rmSync(parent, { recursive: true, force: true }));
    if (populated) {
        writeFileSync(path.join(root, "unofficial-local-web.json"), JSON.stringify(manifest));
        writeFileSync(path.join(root, "index.html"), "<html>main</html>");
        writeFileSync(path.join(root, "local-app-handoff.html"), "<html>relay</html>");
        writeFileSync(path.join(root, "local-app-handoff.js"), "/* relay */");
        writeFileSync(path.join(root, "local-app-setup.html"), "<html>setup relay</html>");
        writeFileSync(path.join(root, "local-app-setup.js"), "/* setup relay */");
        writeFileSync(path.join(root, "main.js"), "/* main */");
        writeFileSync(path.join(root, "runtime.wasm"), new Uint8Array([0, 97, 115, 109]));
        writeFileSync(path.join(root, "transformers_webgpu_worker.js"), "/* synthetic runtime worker */");
        mkdirSync(path.join(root, ortBase), { recursive: true });
        writeFileSync(path.join(root, ortBase, "ort-wasm-simd-threaded.jspi.mjs"), "/* synthetic ORT */");
        writeFileSync(path.join(root, ortBase, "ort-wasm-simd-threaded.jspi.wasm"), new Uint8Array([0, 97, 115, 109]));
    }
    return { parent, root };
}
async function running(t, appOrigin) {
    const { parent, root } = fixture(t);
    if (appOrigin !== undefined) writeFileSync(path.join(root, "unofficial-local-web.json"), JSON.stringify({ ...manifest, relay: { ...manifest.relay, appOrigin } }));
    const server = createServer(localPreviewHandler(loadLocalWebBuild(root)));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
    const send = (target, options = {}) => new Promise((resolve, reject) => {
        const req = request({ hostname: "127.0.0.1", port: server.address().port, path: target, method: options.method ?? "GET", headers: { host: "localhost:5194", ...options.headers } }, (res) => {
            const chunks = []; res.on("data", (data) => chunks.push(data));
            res.once("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        });
        req.once("error", reject); req.end();
    });
    return { send, root, parent };
}

test("CLI arguments cannot change the preview host/port or invoke a shell", (t) => {
    assert.deepEqual(parsePreviewArgs(["--directory", "example"]), { directory: "example" });
    for (const args of [[], ["--host", "0.0.0.0"], ["--directory", "x", "--port", "80"]]) assert.throws(() => parsePreviewArgs(args));
    for (const args of [[], ["--output"], ["--output", "x", "--layout", "v3"], ["--output", "x", "--port", "80"], ["--output", "x", "--host", "0.0.0.0"]]) assert.throws(() => parseBuildArgs(args));
    const { parent, root } = fixture(t, false);
    const canisters = Object.fromEntries(Object.values(UNOFFICIAL_LOCAL_CANISTERS).map((name) => [name, { ic: `official-${name.replaceAll("_", "-")}-cai` }]));
    const options = parseBuildArgs(["--output", root, "--port", "5194", "--layout", "v1"]);
    const plan = localWebBuildPlan(parent, canisters, options, { OC_IC_URL: "https://wrong", NODE_OPTIONS: "--require wrong" });
    assert.equal(plan.command, process.execPath); assert.equal(plan.options.shell, false); assert.equal(plan.options.windowsHide, true);
    assert.deepEqual(plan.args.slice(1), ["--config", "rollup.config.mjs"]);
    assert.equal(plan.options.env.OC_IC_URL, "https://icp-api.io"); assert.equal(plan.options.env.NODE_OPTIONS, "");
    assert.equal(plan.options.env.OC_BASE_ORIGIN, "http://localhost:5194"); assert.equal(plan.options.env.OC_MOBILE_LAYOUT, "v1");
});

test("preview accepts only the pinned local manifest and a complete artifact", (t) => {
    assert.deepEqual(validateManifest(manifest), { port: 5194, origin: "http://localhost:5194", layout: "v2", version: manifest.version, appOrigin: undefined });
    for (const override of [{ port: undefined }, { port: "5194" }, { version: "2.0.0-localtest" }, { version: undefined }, { origin: "https://oc.app" }, { port: 5195 }, { ota: "minor" }, { existingAccountOnly: true }, { existingAccountOnly: undefined }, { clientOnlyApps: false }, { native: true }, { officialBackend: "http://wrong" }, { buildMode: "development" }, { runtimeNodeEnvironment: "production" }, { relay: { html: "/index.html", script: "/local-app-handoff.js" } }]) {
        assert.throws(() => validateManifest({ ...manifest, ...override }));
    }
    const { root } = fixture(t);
    assert.equal(loadLocalWebBuild(root).port, 5194);
    rmSync(path.join(root, "local-app-handoff.js"));
    assert.throws(() => loadLocalWebBuild(root), /Incomplete/);
    assert.throws(() => loadLocalWebBuild("relative"));
});

test("main and navigation fallback are isolated; only literal relay routes relax isolation", async (t) => {
    const { send } = await running(t);
    for (const route of ["/", "/communities", "/chat/example/"]) {
        const response = await send(route, { headers: { accept: "text/html" } });
        assert.equal(response.status, 200); assert.equal(response.body, "<html>main</html>");
        assert.equal(response.headers["cross-origin-opener-policy"], "same-origin");
        assert.equal(response.headers["cross-origin-embedder-policy"], "credentialless");
        assert.equal(response.headers["cache-control"], "no-store");
    }
    for (const route of ["/local-app-handoff.html", "/local-app-handoff.js?version=1", "/local-app-setup.html", "/local-app-setup.js?version=1"]) {
        const response = await send(route, { headers: { accept: "text/html" } });
        assert.equal(response.status, 200);
        for (const [name, value] of Object.entries(LOCAL_APP_RELAY_HEADERS)) assert.equal(response.headers[name.toLowerCase()], value);
        assert.match(response.body, /relay/);
    }
    assert.equal((await send("/%6cocal-app-handoff.html")).status, 404);
    assert.equal((await send("/local-app-handoff.js/")).status, 404);
    assert.equal((await send("/%6cocal-app-setup.html")).status, 404);
    assert.equal((await send("/local-app-setup.js/")).status, 404);
    assert.equal((await send("/missing.js", { headers: { accept: "text/html" } })).status, 404);
    const wasm = await send("/runtime.wasm"); assert.equal(wasm.headers["content-type"], "application/wasm");
    const head = await send("/main.js", { method: "HEAD" }); assert.equal(head.status, 200); assert.equal(head.body, ""); assert.equal(Number(head.headers["content-length"]), 10);
});

test("preview refuses writes, foreign hosts/origins, traversal and hidden files", async (t) => {
    const { send } = await running(t);
    for (const headers of [{ host: "oc.app" }, { host: "127.0.0.1:5194" }, { host: "localhost:5195" }, { origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }]) {
        assert.equal((await send("/", { headers })).status, 403);
    }
    assert.equal((await send("/", { method: "POST" })).status, 405);
    assert.equal((await send("/local-app-handoff.html", { method: "PUT" })).status, 405);
    for (const route of ["/../secret", "/%2e%2e/secret", "/%252e%252e/secret", "/.env", "/dir/.git/config", "/C:/secret", "/%5c..%5csecret", "/%00", "/bad%", "//evil.example/a", "http://evil.example/a"]) {
        assert.equal((await send(route)).status, 400, route);
    }
});

test("only an exact build-pinned app may fill the relay; main isolation and anti-framing stay intact", async (t) => {
  const appOrigin = "http://localhost:3000";
  const { send } = await running(t, appOrigin);
  for (const route of ["/local-app-handoff.html", "/local-app-setup.html"]) {
    const response = await send(route);
    for (const [name, value] of Object.entries(localAppRelayHeaders(appOrigin)))
      assert.equal(response.headers[name.toLowerCase()], value);
    assert.match(
      response.headers["content-security-policy"],
      /frame-src http:\/\/localhost:3000;/,
    );
    assert.match(
      response.headers["content-security-policy"],
      /frame-ancestors 'none'/,
    );
    assert.doesNotMatch(response.headers["content-security-policy"], /\*/);
  }
  const main = await send("/");
  assert.equal(main.headers["cross-origin-opener-policy"], "same-origin");
  assert.equal(main.headers["cross-origin-embedder-policy"], "credentialless");
  assert.equal(main.headers["x-frame-options"], "DENY");
});

test("relay configuration fails closed on malformed, wildcard, credentialed or non-origin destinations", () => {
  assert.equal(localAppRelayOrigin(undefined), undefined);
  assert.equal(localAppRelayOrigin(""), undefined);
  assert.equal(
    localAppRelayOrigin("https://app.example/openchat/apps.json"),
    "https://app.example",
  );
  assert.match(
    localAppRelayHeaders(undefined)["Content-Security-Policy"],
    /frame-src 'none'/,
  );
  for (const appOrigin of [
    null,
    false,
    0,
    "",
    "*",
    "https://*.example",
    "https://app.example;",
    "https://app.example'",
    "https://app.example/",
    "https://app.example/path",
    "https://app.example?x=1",
    "https://app.example#x",
    "https://u:p@app.example",
    "http://remote.example",
    "https://app.example\nframe-src *",
    "HTTPS://APP.EXAMPLE",
  ]) {
    assert.throws(() => localAppRelayHeaders(appOrigin));
    assert.throws(() =>
      validateManifest({
        ...manifest,
        relay: { ...manifest.relay, appOrigin },
      }),
    );
  }
});

test("preview cannot expose files through a directory junction", async (t) => {
    const { send, root, parent } = await running(t);
    const outside = path.join(parent, "outside"); mkdirSync(outside);
    writeFileSync(path.join(outside, "secret.txt"), "not served");
    symlinkSync(outside, path.join(root, "linked"), "junction");
    const result = await send("/linked/secret.txt");
    assert.equal(result.status, 404); assert.equal(result.body.includes("not served"), false);
});

test("only exact pinned ORT files and the current versioned worker can populate HTTP cache", async (t) => {
    const { send } = await running(t);
    for (const route of [`/transformers_webgpu_worker.js?v=${manifest.version}`, `${ortBase}/ort-wasm-simd-threaded.jspi.mjs`, `${ortBase}/ort-wasm-simd-threaded.jspi.wasm`]) {
        const response = await send(route);
        assert.equal(response.status, 200);
        assert.equal(response.headers["cache-control"], "public, max-age=31536000, immutable");
        assert.equal(response.headers["cross-origin-opener-policy"], "same-origin");
        assert.equal(response.headers["cross-origin-embedder-policy"], "credentialless");
    }
    for (const route of ["/transformers_webgpu_worker.js", "/transformers_webgpu_worker.js?v=old", `/transformers_webgpu_worker.js?v=${manifest.version}&v=other`, `${ortBase}/ort-wasm-simd-threaded.jspi.mjs?other=1`, "/main.js", "/"]) {
        assert.equal((await send(route)).headers["cache-control"], "no-store");
    }
});

test("preview runtime allowlist tracks the exact build-owned runtime asset identities", () => {
    const source = readFileSync(new URL("../frontend/app/src/utils/transformersWebGpuRuntimeAssets.ts", import.meta.url), "utf8");
    assert.ok(source.includes(`"${ortBase}"`));
    assert.ok(source.includes('"/transformers_webgpu_worker.js"'));
    assert.ok(source.includes("/ort-wasm-simd-threaded.jspi.mjs"));
    assert.ok(source.includes("/ort-wasm-simd-threaded.jspi.wasm"));
});
