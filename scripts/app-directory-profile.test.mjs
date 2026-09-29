import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createUnofficialLocalEnvironment, UNOFFICIAL_LOCAL_CANISTERS, parseAppDirectoryUrl } from "../frontend/unofficialLocalProfile.mjs";
import { createUnofficialLocalApkEnvironment } from "../frontend/unofficialLocalApkProfile.mjs";
import { parseUnofficialLocalArgs } from "./start-unofficial-local.mjs";
import { parseBuildArgs } from "./build-unofficial-local-web.mjs";
import { localApkBuildPlan, parseLocalApkArgs } from "./build-unofficial-local-apk.mjs";
import { localNativeAppSetupBuildPlugin } from "../frontend/app/localNativeAppSetupBuild.mjs";
const canisters = Object.fromEntries(Object.values(UNOFFICIAL_LOCAL_CANISTERS).map((name) => [name, { ic: "aaaaa-aa" }]));
const directory = "https://publisher.example/apps-v1.json";
test("operator config, not inherited environment, selects generic app directory", () => {
    assert.equal(createUnofficialLocalEnvironment(canisters, { inherited: { OC_APP_DIRECTORY_URL: directory } }).OC_APP_DIRECTORY_URL, "");
    assert.equal(createUnofficialLocalEnvironment(canisters, { appDirectoryUrl: directory }).OC_APP_DIRECTORY_URL, directory);
    assert.equal(createUnofficialLocalApkEnvironment(canisters, { appDirectoryUrl: directory }).OC_APP_DIRECTORY_URL, directory);
    for (const value of ["http://remote.example/apps.json", "https://u:p@publisher.example/apps.json", "https://publisher.example/a?token=x", "https://publisher.example/a#x", "javascript:alert(1)"])
        assert.throws(() => parseAppDirectoryUrl(value));
});
test("all local build entrypoints accept explicit app directory; child retains it", () => {
    assert.equal(parseUnofficialLocalArgs(["--app-directory", directory]).appDirectoryUrl, directory);
    assert.equal(parseBuildArgs(["--output", "/unused", "--app-directory", directory]).appDirectoryUrl, directory);
    assert.equal(parseLocalApkArgs(["--app-directory", directory]).appDirectoryUrl, directory);
    const parent = createUnofficialLocalApkEnvironment(canisters, { appDirectoryUrl: directory });
    const child = localApkBuildPlan(".", canisters, { frontendOnly: true }, parent);
    assert.equal(child.options.env.OC_APP_DIRECTORY_URL, directory);
});
test("setup bridge assets are bundled only for explicit local builds", async () => {
    const assets = [];
    await localNativeAppSetupBuildPlugin().generateBundle.call({ emitFile: (asset) => assets.push(asset) });
    assert.equal(assets.length, 0);
    await localNativeAppSetupBuildPlugin({ enabled: true }).generateBundle.call({ emitFile: (asset) => assets.push(asset) });
    assert.deepEqual(assets.map((asset) => asset.fileName), ["local-native-app-setup.html", "local-native-app-setup.js", "local-native-app-setup-profile.json"]);
    assert.match(assets[0].source, /src="\/setup.js"/);
    assert.doesNotThrow(() => new Function(new TextDecoder().decode(assets[1].source)));
    assert.equal(JSON.parse(assets[2].source).transport, "private-app-setup-v1");
    const overlay = JSON.parse(readFileSync(new URL("../frontend/src-tauri/tauri.localtest.conf.json", import.meta.url)));
    const capability = overlay.app.security.capabilities.find((entry) => entry.identifier === "local-app-setup");
    assert.deepEqual(capability.permissions, ["oc:allow-local-app-setup"]);
    assert.deepEqual(capability.windows, ["main"]);
    assert.equal(capability.local, true);
});
