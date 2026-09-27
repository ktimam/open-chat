import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { UNOFFICIAL_LOCAL_CANISTERS } from "./unofficialLocalProfile.mjs";
import {
    copyUnofficialWebPublicFiles,
    createUnofficialLocalWebBuildEnvironment,
    unofficialLocalWebManifest,
    parseUnofficialLocalWebBuildId,
    validateUnofficialWebOutput,
} from "./unofficialLocalWebBuild.mjs";

const canisters = Object.fromEntries(Object.values(UNOFFICIAL_LOCAL_CANISTERS).map((name) => [name, { ic: `official-${name.replaceAll("_", "-")}-cai` }]));
function fixture(t) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "openchat-local-web-test-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const output = path.join(directory, "output");
    const repositoryRoot = path.join(directory, "repository");
    mkdirSync(output); mkdirSync(repositoryRoot);
    return { directory, output, repositoryRoot };
}

test("optimized JS keeps localhost, official API, immutable models and no telemetry/OTA/account creation", (t) => {
    const directories = fixture(t);
    const env = createUnofficialLocalWebBuildEnvironment(canisters, { ...directories, port: 5196, layout: "v1", inherited: {
        NODE_ENV: "test", OC_NODE_ENV: "production", OC_BASE_ORIGIN: "https://oc.app", OC_UNOFFICIAL_WEB_OUTPUT: "wrong",
        OC_IC_URL: "http://wrong", OC_ROLLBAR_ACCESS_TOKEN: "secret", NODE_OPTIONS: "--require wrong", VITE_SECRET: "secret",
    } });
    assert.equal(env.NODE_ENV, "production"); assert.equal(env.OC_NODE_ENV, "development");
    assert.equal(env.OC_BUILD_ENV, "development"); assert.equal(env.OC_UNOFFICIAL_CLIENT, "true");
    assert.equal(env.OC_UNOFFICIAL_WEB_BUILD, "true"); assert.equal(env.OC_UNOFFICIAL_WEB_OUTPUT, directories.output);
    assert.equal(env.OC_DFX_NETWORK, "ic"); assert.equal(env.OC_IC_URL, "https://icp-api.io");
    assert.equal(env.OC_BASE_ORIGIN, "http://localhost:5196"); assert.equal(env.OC_WEBAUTHN_ORIGIN, "localhost");
    assert.equal(env.OC_APP_TYPE, "web"); assert.equal(env.OC_ANDROID_RP_ID, "");
    assert.equal(env.OC_TRANSFORMERS_WEBGPU_ASSET_DELIVERY, "immutable-hub-v1");
    assert.equal(env.OC_OTA_UPDATES, "none"); assert.equal(env.OC_ROLLBAR_ACCESS_TOKEN, "");
    assert.equal(env.NODE_OPTIONS, ""); assert.equal(env.VITE_SECRET, undefined);
    assert.deepEqual(readdirSync(directories.output), []);
    for (const [variable, name] of Object.entries(UNOFFICIAL_LOCAL_CANISTERS)) assert.equal(env[variable], canisters[name].ic);
});

test("output admission is read-only and refuses broad, absent, relative, nonempty and file paths", (t) => {
    const { directory, output, repositoryRoot } = fixture(t);
    assert.equal(validateUnofficialWebOutput(output, repositoryRoot), output);
    for (const candidate of [undefined, "relative", path.parse(output).root, repositoryRoot, path.join(directory, "absent")]) {
        assert.throws(() => validateUnofficialWebOutput(candidate, repositoryRoot));
    }
    const sentinel = path.join(output, "keep.txt"); writeFileSync(sentinel, "preserve");
    assert.throws(() => validateUnofficialWebOutput(output, repositoryRoot));
    assert.throws(() => validateUnofficialWebOutput(sentinel, repositoryRoot));
    assert.equal(readFileSync(sentinel, "utf8"), "preserve");
});

test("manifest is fixed local build metadata, without credentials or arbitrary fields", (t) => {
    const env = createUnofficialLocalWebBuildEnvironment(canisters, { ...fixture(t), port: 5193 });
    const manifest = unofficialLocalWebManifest({ ...env, OC_RANDOM_SECRET: "not-for-output" });
    assert.deepEqual(manifest, {
        schemaVersion: 1, profile: "unofficial-local-web", buildMode: "optimized", runtimeNodeEnvironment: "development",
        version: env.OC_WEBSITE_VERSION,
        port: 5193, origin: "http://localhost:5193", layout: "v2", officialBackend: "https://icp-api.io",
        existingAccountOnly: true, clientOnlyApps: true, ota: "none", native: false,
        relay: { html: "/local-app-handoff.html", script: "/local-app-handoff.js" },
    });
    for (const change of [{ OC_UNOFFICIAL_CLIENT: "false" }, { OC_UNOFFICIAL_WEB_BUILD: undefined }, { OC_OTA_UPDATES: "minor" }, { OC_DFX_NETWORK: "local" }, { OC_BASE_ORIGIN: "https://oc.app" }, { OC_APP_TYPE: "android" }, { OC_BUILD_ENV: "production" }, { OC_NODE_ENV: "production" }, { NODE_ENV: "development" }, { OC_WEBAUTHN_ORIGIN: "oc.app" }, { OC_DEV_PORT: "5193@other" }, { OC_TRANSFORMERS_WEBGPU_IMAGE_SPIKE: "false" }, { OC_WEBSITE_VERSION: "2.0.0-localtest.old" }, { OC_UNOFFICIAL_WEB_BUILD_ID: "invalid" }]) {
        assert.throws(() => unofficialLocalWebManifest({ ...env, ...change }));
    }
});

test("each build rotates worker script version without changing pinned model artifact delivery or the login origin", (t) => {
    const options = fixture(t);
    const first = createUnofficialLocalWebBuildEnvironment(canisters, options);
    const second = createUnofficialLocalWebBuildEnvironment(canisters, options);
    assert.notEqual(first.OC_WEBSITE_VERSION, second.OC_WEBSITE_VERSION);
    assert.match(first.OC_WEBSITE_VERSION, /^2\.0\.0-localtest\.[a-f0-9]{32}$/);
    const workerUrl = (env) => `${env.OC_BASE_ORIGIN}/transformers_webgpu_worker.js?v=${env.OC_WEBSITE_VERSION}`;
    assert.notEqual(workerUrl(first), workerUrl(second));
    for (const field of ["OC_TRANSFORMERS_WEBGPU_ASSET_DELIVERY", "OC_TRANSFORMERS_WEBGPU_IMAGE_SPIKE", "OC_BASE_ORIGIN", "OC_WEBAUTHN_ORIGIN", "OC_DFX_NETWORK"]) assert.equal(first[field], second[field]);
    const reconstructed = createUnofficialLocalWebBuildEnvironment(canisters, { ...options, buildId: first.OC_UNOFFICIAL_WEB_BUILD_ID, inherited: { ...first, OC_WEBSITE_VERSION: "wrong" } });
    assert.equal(reconstructed.OC_WEBSITE_VERSION, first.OC_WEBSITE_VERSION);
    assert.equal(parseUnofficialLocalWebBuildId(first.OC_UNOFFICIAL_WEB_BUILD_ID), first.OC_UNOFFICIAL_WEB_BUILD_ID);
    for (const value of [undefined, "", "A".repeat(32), "a".repeat(31), "../".repeat(11)]) assert.throws(() => parseUnofficialLocalWebBuildId(value));
});

test("public copy preserves generated key and relay, ignores associations, and refuses overwriting generated assets", (t) => {
    const { directory, output } = fixture(t);
    const publicDirectory = path.join(directory, "public");
    mkdirSync(path.join(publicDirectory, ".well-known"), { recursive: true });
    mkdirSync(path.join(publicDirectory, "assets"));
    writeFileSync(path.join(publicDirectory, "public-key"), "stale-key");
    writeFileSync(path.join(publicDirectory, "local-app-handoff.html"), "stale-relay");
    writeFileSync(path.join(publicDirectory, ".well-known", "assetlinks.json"), "official-association");
    writeFileSync(path.join(publicDirectory, ".ic-assets.json5"), "official-host-policy");
    writeFileSync(path.join(publicDirectory, "assets", "icon.svg"), "icon");
    writeFileSync(path.join(output, "public-key"), "signed-key");
    writeFileSync(path.join(output, "local-app-handoff.html"), "generated-relay");
    copyUnofficialWebPublicFiles(publicDirectory, output);
    assert.equal(readFileSync(path.join(output, "public-key"), "utf8"), "signed-key");
    assert.equal(readFileSync(path.join(output, "local-app-handoff.html"), "utf8"), "generated-relay");
    assert.equal(readFileSync(path.join(output, "assets", "icon.svg"), "utf8"), "icon");
    assert.equal(readdirSync(output).some((name) => name.startsWith(".")), false);
    assert.throws(() => copyUnofficialWebPublicFiles(publicDirectory, output));
});

test("Rollup local path has explicit safety replacements, isolated output, relay and no OTA/DAL clean", () => {
    const source = readFileSync(new URL("./app/rollup.config.mjs", import.meta.url), "utf8");
    const extra = readFileSync(new URL("./app/rollup.extras.mjs", import.meta.url), "utf8");
    assert.match(source, /"import\.meta\.env\.OC_UNOFFICIAL_CLIENT": JSON\.stringify/);
    assert.match(source, /localWebBuild \? \{ "import\.meta\.env\.DEV": "false", "import\.meta\.env\.PROD": "true" \}/);
    assert.match(source, /localWebBuild \? \{ "process\.env\.NODE_ENV": JSON\.stringify\("production"\)/);
    assert.match(source, /localWebBuild \? "development" : \(process\.env\.NODE_ENV/);
    assert.match(source, /localAppRelayPlugin\(\{ enabled: localWebBuild \}\)/);
    assert.match(source, /queryPublicKey: queryOfficialUserIndexPublicKey, outputPath: outputPath\("public-key"\)/);
    assert.match(source, /\.\.\.\(!localWebBuild \? \[androidBundlePlugin/);
    assert.match(source, /const androidRpId = localWebBuild \? ""/);
    assert.match(source, /if \(localWebBuild\) \{[\s\S]*?return;\s*\}\s*console\.log\("cleaning up the build directory"\)/);
    assert.match(source, /dir: outputDirectory/);
    assert.equal(/dest: "build(?:\/|")/.test(source), false);
    assert.match(extra, /OC_UNOFFICIAL_WEB_BUILD === "true" && process\.env\.OC_UNOFFICIAL_CLIENT !== "true"/);
    assert.match(extra, /createUnofficialLocalWebBuildEnvironment\(canisters/);
    const workers = readFileSync(new URL("./app/build-workers.mjs", import.meta.url), "utf8");
    assert.match(workers, /envDir: process\.env\.OC_UNOFFICIAL_CLIENT === "true" \? false : undefined/);
});
