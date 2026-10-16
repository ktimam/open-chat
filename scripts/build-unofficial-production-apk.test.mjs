import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { UNOFFICIAL_LOCAL_CANISTERS } from "../frontend/unofficialLocalProfile.mjs";
import { createUnofficialLocalApkEnvironment, localApkParentRpId } from "../frontend/unofficialLocalApkProfile.mjs";
import {
    createUnofficialProductionApkEnvironment, productionApkBundleMarker, productionApkParentRpId,
    PRIVATE_APK_ID, PRIVATE_APK_VERSION, PRIVATE_APK_RP_ID, PRIVATE_APP_DIRECTORY, PRIVATE_SIGNING_KEYS,
} from "../frontend/unofficialProductionApkProfile.mjs";
import { parseProductionApkArgs, productionApkBuildPlan } from "./build-unofficial-production-apk.mjs";
import { localNativeAppHandoffBuildPlugin } from "../frontend/app/localNativeAppHandoffBuild.mjs";
import { localNativeAppSetupBuildPlugin } from "../frontend/app/localNativeAppSetupBuild.mjs";
import { transformersWebGpuFeatureEnabled } from "../frontend/app/transformersWebGpuFeatureFlag.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const canisters = Object.fromEntries(Object.values(UNOFFICIAL_LOCAL_CANISTERS).map((name) => [name, { ic: "aaaaa-aa" }]));
const signing = Object.fromEntries(PRIVATE_SIGNING_KEYS.map((name) => [name, `synthetic-${name}`]));
const env = (inherited = signing) => createUnofficialProductionApkEnvironment(canisters, { inherited });

test("production pins approved identity, mainnet endpoints, features and no OTA or telemetry", () => {
    const profile = env({ ...signing, OC_ANDROID_APPLICATION_ID: "com.oclabs.openchat", OC_APP_DIRECTORY_URL: "http://localhost:3000/apps.json",
        OC_WEBAUTHN_ORIGIN: "fork.tail000000.ts.net", OC_OTA_UPDATES: "major", VITE_SECRET: "synthetic", NODE_OPTIONS: "untrusted" });
    assert.equal(profile.OC_ANDROID_APPLICATION_ID, PRIVATE_APK_ID);
    assert.equal(profile.OC_ANDROID_VERSION_NAME, PRIVATE_APK_VERSION);
    assert.equal(profile.OC_ANDROID_RP_ID, PRIVATE_APK_RP_ID);
    assert.equal(profile.OC_APP_DIRECTORY_URL, PRIVATE_APP_DIRECTORY);
    assert.equal(profile.OC_IC_URL, "https://icp-api.io");
    assert.equal(profile.OC_DFX_NETWORK, "ic");
    assert.equal(profile.OC_BUILD_ENV, "production");
    assert.equal(profile.OC_NODE_ENV, "production");
    assert.equal(profile.OC_UNOFFICIAL_LOCAL_APK, "false");
    assert.equal(profile.OC_UNOFFICIAL_PRODUCTION_APK, "true");
    assert.equal(profile.OC_UNOFFICIAL_CLIENT, "true");
    assert.equal(profile.OC_BASE_ORIGIN, "http://tauri.localhost");
    assert.equal(profile.OC_ANDROID_NATIVE_AUTH, "android-credential-manager-v1");
    assert.equal(profile.OC_OTA_UPDATES, "none");
    assert.equal(profile.OC_ANDROID_OTA_UPDATES, "none");
    assert.equal(profile.OC_ANDROID_REQUIRE_RELEASE_SIGNING, "true");
    assert.equal(profile.OC_ROLLBAR_ACCESS_TOKEN, "");
    assert.equal(profile.OC_USERGEEK_APIKEY, "");
    assert.equal(profile.OC_METERED_APIKEY, "");
    assert.equal(profile.NODE_OPTIONS, "");
    assert.equal(profile.VITE_SECRET, undefined);
    assert.equal(profile.OC_DEV_PORT, "");
    assert.equal(profile.CARGO_NET_OFFLINE, "true");
    assert.equal(transformersWebGpuFeatureEnabled(profile), true);
    for (const variable of Object.keys(UNOFFICIAL_LOCAL_CANISTERS)) assert.equal(profile[variable], "aaaaa-aa");
});

test("missing/partial signing fails closed without disclosing values; old local profile stays debug-only", () => {
    for (const name of PRIVATE_SIGNING_KEYS) {
        for (const missing of [undefined, "", " "]) {
            assert.throws(() => env({ ...signing, [name]: missing }), (error) =>
                error.message.includes(name) && !error.message.includes("synthetic-"));
        }
    }
    const local = createUnofficialLocalApkEnvironment(canisters, { inherited: env(), rpId: "test.example.com" });
    assert.equal(local.OC_ANDROID_APPLICATION_ID, "dev.openchatfork.localtest");
    assert.equal(local.OC_UNOFFICIAL_PRODUCTION_APK, undefined);
    assert.equal(local.OC_ANDROID_REQUIRE_RELEASE_SIGNING, "false");
    assert.equal(local.OC_ANDROID_KEYSTORE_PASSWORD, "");
    assert.throws(() => localApkParentRpId(env()));
    assert.throws(() => productionApkParentRpId(local));
});

test("child validates every pinned production boundary and retains signing and build identifier", () => {
    const parent = env();
    const child = productionApkBuildPlan(repository, canisters, { frontendOnly: true }, parent);
    assert.equal(child.options.env.OC_WEBSITE_VERSION, parent.OC_WEBSITE_VERSION);
    for (const key of PRIVATE_SIGNING_KEYS) assert.equal(child.options.env[key], signing[key]);
    for (const key of ["OC_UNOFFICIAL_PRODUCTION_APK", "OC_UNOFFICIAL_LOCAL_APK", "OC_UNOFFICIAL_CLIENT",
        "OC_ANDROID_APPLICATION_ID", "OC_ANDROID_VERSION_NAME", "OC_UNOFFICIAL_APK_RP_ID", "OC_ANDROID_RP_ID",
        "OC_WEBAUTHN_ORIGIN", "OC_APP_DIRECTORY_URL", "OC_ANDROID_NATIVE_AUTH", "OC_ANDROID_REQUIRE_RELEASE_SIGNING",
        "OC_OTA_UPDATES", "OC_ANDROID_OTA_UPDATES", "OC_BUILD_ENV", "OC_NODE_ENV", "OC_DFX_NETWORK", "OC_UNOFFICIAL_APK_BUILD_ID"]) {
        assert.throws(() => productionApkBuildPlan(repository, canisters, { frontendOnly: true }, { ...parent, [key]: "wrong" }), undefined, key);
    }
    assert.throws(() => productionApkParentRpId({ ...parent, OC_UNOFFICIAL_WEB_BUILD: "true" }));
});

test("build CLI cannot retarget identity, endpoint, credentials, install, publish or enable browser auth", () => {
    assert.equal(parseProductionApkArgs([]).target, "aarch64");
    for (const flags of [["--rp-id", "oc.app"], ["--app-directory", "https://example.com"], ["--install"], ["--publish"], ["--target", "arm"], ["--target"], ["--frontend-only", "--frontend-only"]])
        assert.throws(() => parseProductionApkArgs(flags));
    const plan = productionApkBuildPlan(repository, canisters, parseProductionApkArgs([]), signing);
    assert.equal(plan.options.shell, false);
    assert.ok(plan.args.includes("transformers-webgpu-android,local-test-app-handoff"));
    assert.ok(plan.args.some((value) => value.endsWith("tauri.private.conf.json")));
    assert.doesNotMatch(JSON.stringify(plan.args), /synthetic-|local-browser-auth|--debug|install/);
    const config = JSON.parse(read("frontend/src-tauri/tauri.private.conf.json"));
    // Tauri derives JNI names from this identifier. Keep its Java namespace;
    // the actual installed identity is the separately guarded Gradle applicationId.
    assert.equal(config.identifier, undefined);
    assert.equal(JSON.parse(read("frontend/src-tauri/tauri.conf.json")).identifier, "com.oclabs.openchat");
    assert.equal(config.version, PRIVATE_APK_VERSION);
    assert.equal(config.productName, "OpenChat Private");
    assert.deepEqual(config.plugins["deep-link"].mobile, []);
    assert.doesNotMatch(JSON.stringify(config), /local-browser-auth|oc\.app/);
});

test("production markers and transport assets carry only public metadata", async () => {
    const marker = productionApkBundleMarker("aaaaa-aa", "ABCD");
    assert.equal(marker.applicationId, PRIVATE_APK_ID);
    assert.equal(marker.androidRpId, PRIVATE_APK_RP_ID);
    assert.equal(marker.appDirectoryUrl, PRIVATE_APP_DIRECTORY);
    assert.equal(Object.hasOwn(marker, "digitalAssetLinksVerified"), false);
    assert.doesNotMatch(JSON.stringify(marker), /PASSWORD|KEYSTORE|synthetic-/);
    for (const [plugin, transport] of [[localNativeAppSetupBuildPlugin, "private-app-setup-v1"], [localNativeAppHandoffBuildPlugin, "private-app-code-v1"]]) {
        const assets = [];
        await plugin({ enabled: true, applicationId: PRIVATE_APK_ID }).generateBundle.call({ emitFile: (asset) => assets.push(asset) });
        assert.deepEqual(JSON.parse(assets.at(-1).source), { version: 1, applicationId: PRIVATE_APK_ID, transport });
        assert.throws(() => plugin({ enabled: true, applicationId: "com.oclabs.openchat" }));
    }
});

test("real Rollup environment normalization retains production endpoints and signing without requiring upstream telemetry keys", () => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import { initEnv } from ${JSON.stringify(new URL("../frontend/app/rollup.extras.mjs", import.meta.url).href)};
        import { productionApkParentRpId } from ${JSON.stringify(new URL("../frontend/unofficialProductionApkProfile.mjs", import.meta.url).href)};
        const result = initEnv();
        productionApkParentRpId(process.env);
        if (!result.production || result.development || process.env.OC_ANDROID_KEYSTORE_PASSWORD !== "synthetic-OC_ANDROID_KEYSTORE_PASSWORD") throw new Error("profile changed");
        console.log("production-profile-ok");
    `], { env: { ...process.env, ...env() }, encoding: "utf8", shell: false, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /production-profile-ok/);
    assert.doesNotMatch(result.stdout, /synthetic-OC_ANDROID/);
});

test("native release gates require isolated package, pinned RP, encrypted signer and exact fork allowlists", () => {
    const gradle = read("frontend/src-tauri/gen/android/app/build.gradle.kts");
    assert.match(gradle, /require\(!\(unofficialLocalTest && unofficialProduction\)\)/);
    assert.match(gradle, /if \(!unofficialNative\) apply\(plugin = "com.google.gms.google-services"\)/);
    assert.match(gradle, /if \(unofficialProduction\)[\s\S]*?OC_ANDROID_REQUIRE_RELEASE_SIGNING"\) == "true"/);
    assert.match(gradle, /private-apk-profile.json/);
    assert.match(gradle, /else if \(unofficialProduction\) privateApplicationId else "com.oclabs.openchat"/);
    assert.match(gradle, /buildConfigField\("boolean", "UNOFFICIAL_LOCAL_TEST", unofficialNative.toString\(\)\)/);
    const native = read("frontend/tauri-plugin-oc/android/src/main/java/LocalTestPolicy.kt");
    assert.match(native, /"io.github.ktimam.openchatprivate" -> "openchat_private"/);
    assert.match(native, /else -> return false/);
    for (const file of ["local_app_setup.rs", "local_app_handoff.rs"])
        assert.match(read(`frontend/tauri-plugin-oc/src/${file}`), /matches!\(profile.application_id.as_str\(\), "dev.openchatfork.localtest" \| "io.github.ktimam.openchatprivate"\)/);
    assert.doesNotMatch(read("frontend/tauri-plugin-oc/src/local_browser_auth.rs"), /io.github.ktimam.openchatprivate/);
});
