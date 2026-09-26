import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { UNOFFICIAL_LOCAL_CANISTERS } from "../frontend/unofficialLocalProfile.mjs";
import { createUnofficialLocalApkEnvironment, localApkBundleMarker } from "../frontend/unofficialLocalApkProfile.mjs";
import { localApkBuildPlan, parseLocalApkArgs } from "./build-unofficial-local-apk.mjs";
import { localNativeAppHandoffBuildPlugin } from "../frontend/app/localNativeAppHandoffBuild.mjs";

const canisters = Object.fromEntries(Object.values(UNOFFICIAL_LOCAL_CANISTERS).map((name) => [name, { ic: "aaaaa-aa" }]));
const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

test("local APK pins official backend, distinct identity and no production updates/signing", () => {
    const env = createUnofficialLocalApkEnvironment(canisters, { inherited: {
        OC_BASE_ORIGIN: "https://oc.app", OC_ANDROID_APPLICATION_ID: "com.oclabs.openchat",
        OC_OTA_UPDATES: "major", OC_ANDROID_KEYSTORE_PASSWORD: "not-a-secret-synthetic", NODE_OPTIONS: "untrusted",
    }});
    assert.equal(env.OC_ANDROID_APPLICATION_ID, "dev.openchatfork.localtest");
    assert.equal(env.OC_BASE_ORIGIN, "http://tauri.localhost");
    assert.equal(env.OC_IC_URL, "https://icp-api.io");
    assert.equal(env.OC_DFX_NETWORK, "ic");
    assert.equal(env.OC_UNOFFICIAL_CLIENT, "true");
    assert.equal(env.OC_OTA_UPDATES, "none");
    assert.equal(env.OC_ANDROID_OTA_UPDATES, "none");
    assert.equal(env.OC_ANDROID_KEYSTORE_PASSWORD, "");
    assert.equal(env.NODE_OPTIONS, "");
    assert.equal(env.OC_ANDROID_RP_ID, "");
    assert.equal(env.OC_II_DERIVATION_ORIGIN, "");
    assert.equal(env.OC_ANDROID_NATIVE_AUTH, "browser-bridge-v1");
    assert.equal(env.CARGO_NET_OFFLINE, "true");
});

test("optimized APK keeps development deployment policy and model/OCR feature", () => {
    const env = createUnofficialLocalApkEnvironment(canisters);
    assert.equal(env.NODE_ENV, "production");
    assert.equal(env.OC_NODE_ENV, "development");
    assert.equal(env.OC_BUILD_ENV, "development");
    assert.equal(env.OC_TRANSFORMERS_WEBGPU_IMAGE_SPIKE, "true");
    assert.equal(env.OC_TRANSFORMERS_WEBGPU_ASSET_DELIVERY, "immutable-hub-v1");
    assert.equal(env.OC_MOBILE_LAYOUT, "v2");
});

test("rebuild cache key changes without changing pinned weight delivery", () => {
    const first = createUnofficialLocalApkEnvironment(canisters);
    const second = createUnofficialLocalApkEnvironment(canisters);
    assert.notEqual(first.OC_WEBSITE_VERSION, second.OC_WEBSITE_VERSION);
    assert.equal(first.OC_TRANSFORMERS_WEBGPU_ASSET_DELIVERY, second.OC_TRANSFORMERS_WEBGPU_ASSET_DELIVERY);
    assert.equal(createUnofficialLocalApkEnvironment(canisters, { buildId: first.OC_UNOFFICIAL_APK_BUILD_ID }).OC_WEBSITE_VERSION, first.OC_WEBSITE_VERSION);
    for (const buildId of ["", "../../anything", "f".repeat(31), "G".repeat(32)]) assert.throws(() => createUnofficialLocalApkEnvironment(canisters, { buildId }));
});

test("bundle marker is fixed local browser-bridge profile", () => {
    const marker = localApkBundleMarker("aaaaa-aa", "ABCD");
    assert.equal(marker.applicationId, "dev.openchatfork.localtest");
    assert.equal(marker.label, "OpenChat Fork · Local Test");
    assert.equal(marker.ota, "none");
    assert.equal(marker.nativeAuthentication, "browser-bridge-v1");
    assert.throws(() => localApkBundleMarker("https://oc.app", "ABCD"));
    assert.throws(() => localApkBundleMarker("aaaaa-aa", "nothex"));
});

test("CLI only accepts bounded build targets and no device/data operations", () => {
    assert.equal(parseLocalApkArgs([]).target, "aarch64");
    assert.equal(parseLocalApkArgs(["--target", "x86_64"]).target, "x86_64");
    for (const args of [["--install"], ["--target", "arm"], ["--target"], ["--target", "aarch64", "--target", "x86_64"], ["--config", "arbitrary"]]) assert.throws(() => parseLocalApkArgs(args));
});

test("build plan contains GPU and separate auth/private-handoff features; never invokes shell/install", () => {
    const repo = fileURLToPath(new URL("..", import.meta.url));
    const plan = localApkBuildPlan(repo, canisters, parseLocalApkArgs([]));
    assert.equal(plan.options.shell, false);
    assert.equal(plan.options.windowsHide, true);
    assert.ok(plan.args.includes("transformers-webgpu-android,local-test-browser-auth,local-test-app-handoff"));
    assert.ok(plan.args.includes("--apk"));
    assert.ok(!plan.args.some((arg) => ["install", "uninstall", "dev", "run"].includes(arg)));
});

test("frontend child retains parent's unique build ID", () => {
    const parent = createUnofficialLocalApkEnvironment(canisters);
    const child = localApkBuildPlan(".", canisters, parseLocalApkArgs(["--frontend-only"]), parent);
    assert.equal(child.options.env.OC_WEBSITE_VERSION, parent.OC_WEBSITE_VERSION);
});

test("separate manifest omits official domain/scheme associations and Firebase initializer", () => {
    const manifest = read("frontend/src-tauri/gen/android/app/src/localTest/AndroidManifest.xml");
    assert.doesNotMatch(manifest, /android:host=|android:scheme=|BROWSABLE|asset_statements|autoVerify/);
    assert.match(manifest, /FirebaseInitProvider" tools:node="remove"/);
    assert.match(manifest, /android.permission.RECORD_AUDIO/);
    assert.match(manifest, /android.permission.READ_MEDIA_IMAGES/);
    assert.match(manifest, /\$\{applicationId\}\.fileprovider/);
    assert.match(manifest, /@string\/local_test_app_name/);
});

test("Gradle identity is separate; JNI namespace remains stable", () => {
    const gradle = read("frontend/src-tauri/gen/android/app/build.gradle.kts");
    assert.match(gradle, /applicationId = if \(unofficialLocalTest\) localTestApplicationId/);
    assert.match(gradle, /namespace = "com.oclabs.openchat"/);
    assert.match(gradle, /!unofficialLocalTest && propFile.exists\(\)/);
    assert.match(gradle, /src\/localTest\/AndroidManifest.xml/);
    assert.match(gradle, /openchat-fork-local-test.apk/);
});

test("bridge capability is only granted by the explicit local overlay", () => {
    const overlay = JSON.parse(read("frontend/src-tauri/tauri.localtest.conf.json"));
    assert.deepEqual(overlay.plugins["deep-link"].mobile, []);
    const capability = overlay.app.security.capabilities.find((entry) => typeof entry === "object");
    assert.deepEqual(capability.windows, ["main"]);
    assert.equal(capability.local, true);
    assert.deepEqual(capability.permissions, ["oc:allow-local-browser-auth"]);
    const handoff = overlay.app.security.capabilities.find((entry) => entry.identifier === "local-app-handoff");
    assert.deepEqual(handoff.windows, ["main"]);
    assert.equal(handoff.local, true);
    assert.deepEqual(handoff.permissions, ["oc:allow-local-app-handoff"]);
    const permission = read("frontend/tauri-plugin-oc/permissions/local-app-handoff.toml");
    assert.match(permission, /begin_local_app_handoff.*poll_local_app_handoff.*cancel_local_app_handoff/);
});

test("Rollup keeps local web mode independent and emits only bundled signer assets", () => {
    const rollup = read("frontend/app/rollup.config.mjs");
    assert.match(rollup, /localAppRelayPlugin\(\{ enabled: localWebBuild \}\)/);
    assert.match(rollup, /localBrowserAuthBuildPlugin\(\{ enabled: localTestApk/);
    assert.match(rollup, /import.meta.env.OC_UNOFFICIAL_LOCAL_APK/);
    assert.match(rollup, /localClientBuild \? \{ queryPublicKey: queryOfficialUserIndexPublicKey/);
    const plugin = read("frontend/app/localBrowserAuthBuild.mjs");
    assert.match(plugin, /src=\\"\/sign-in.js\\"|src="\/sign-in.js"/);
    assert.match(plugin, /bundle: true, write: false/);
    assert.match(plugin, /fileName: "local-browser-auth.js"/);
    assert.match(rollup, /localNativeAppHandoffBuildPlugin\(\{ enabled: localTestApk \}\)/);
    const handoff = read("frontend/app/localNativeAppHandoffBuild.mjs");
    assert.match(handoff, /src="\/handoff.js"/);
    assert.match(handoff, /fileName: "local-native-app-handoff.js"/);
    assert.match(handoff, /fileName: "local-native-app-handoff-profile.json"/);
    assert.match(handoff, /applicationId: "dev.openchatfork.localtest", transport: "private-app-code-v1"/);
});

test("local native code never silently falls back to official passkeys or Firebase", () => {
    const passkey = read("frontend/tauri-plugin-oc/android/src/main/java/commands/PasskeyAuth.kt");
    assert.equal((passkey.match(/if \(isUnofficialLocalTest\(activity\)\)/g) ?? []).length, 3);
    assert.match(passkey, /credentialManager by lazy/);
    const plugin = read("frontend/tauri-plugin-oc/android/src/main/java/OpenChatPlugin.kt");
    assert.match(plugin, /if \(!isUnofficialLocalTest\(activity\)\) OCPluginCompanion.initFcmTokenCache/);
    const opener = read("frontend/tauri-plugin-oc/android/src/main/java/commands/OpenUrl.kt");
    assert.match(opener, /isUnofficialLocalTest\(activity\) && uri.host == "localhost"/);
});

test("private handoff plugin bundles the real browser entry and is inert outside local APK", async () => {
    const absent = [];
    await localNativeAppHandoffBuildPlugin().generateBundle.call({ emitFile: (asset) => absent.push(asset) });
    assert.deepEqual(absent, []);
    const assets = [];
    await localNativeAppHandoffBuildPlugin({ enabled: true }).generateBundle.call({ emitFile: (asset) => assets.push(asset) });
    assert.deepEqual(assets.map((asset) => asset.fileName), [
        "local-native-app-handoff.html", "local-native-app-handoff.js", "local-native-app-handoff-profile.json",
    ]);
    const script = new TextDecoder().decode(assets[1].source);
    assert.ok(script.length > 0 && script.length < 1024 * 1024);
    assert.doesNotThrow(() => new Function(script));
    assert.match(assets[0].source, /src="\/handoff.js"/);
    assert.deepEqual(JSON.parse(assets[2].source), {
        version: 1, applicationId: "dev.openchatfork.localtest", transport: "private-app-code-v1",
    });
});
