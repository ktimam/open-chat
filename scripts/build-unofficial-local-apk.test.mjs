import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { UNOFFICIAL_LOCAL_CANISTERS } from "../frontend/unofficialLocalProfile.mjs";
import {
    createUnofficialLocalApkEnvironment,
    localApkBundleMarker,
    localApkParentRpId,
    parseLocalApkRpId,
} from "../frontend/unofficialLocalApkProfile.mjs";
import { localApkBuildPlan, parseLocalApkArgs } from "./build-unofficial-local-apk.mjs";
import { localNativeAppHandoffBuildPlugin } from "../frontend/app/localNativeAppHandoffBuild.mjs";

const canisters = Object.fromEntries(
    Object.values(UNOFFICIAL_LOCAL_CANISTERS).map((name) => [name, { ic: "aaaaa-aa" }]),
);
const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const rpId = "fork-test.tail000000.ts.net";
const officialKeyWiring =
    /localClientBuild\s*\?\s*\{\s*queryPublicKey:\s*queryOfficialUserIndexPublicKey\s*,/;
const nativeProfileWiring =
    /applicationId:\s*"dev\.openchatfork\.localtest"\s*,\s*transport:\s*"private-app-code-v1"\s*,/;

test("local APK pins official backend, distinct identity and no production updates/signing", () => {
    const env = createUnofficialLocalApkEnvironment(canisters, {
        rpId,
        inherited: {
            OC_BASE_ORIGIN: "https://oc.app",
            OC_ANDROID_APPLICATION_ID: "com.oclabs.openchat",
            OC_OTA_UPDATES: "major",
            OC_ANDROID_KEYSTORE_PASSWORD: "not-a-secret-synthetic",
            NODE_OPTIONS: "untrusted",
            OC_ANDROID_RP_ID: "unreviewed.example",
            OC_WEBAUTHN_ORIGIN: "localhost",
            OC_ANDROID_NATIVE_AUTH: "browser-bridge-v1",
            OC_ACCOUNT_LINKING_CODES_ENABLED: "false",
        },
    });
    assert.equal(env.OC_ANDROID_APPLICATION_ID, "dev.openchatfork.localtest");
    assert.equal(env.OC_BASE_ORIGIN, "http://tauri.localhost");
    assert.equal(env.OC_IC_URL, "https://icp-api.io");
    assert.equal(env.OC_DFX_NETWORK, "ic");
    assert.equal(env.OC_UNOFFICIAL_CLIENT, "true");
    assert.equal(env.OC_OTA_UPDATES, "none");
    assert.equal(env.OC_ANDROID_OTA_UPDATES, "none");
    assert.equal(env.OC_ANDROID_KEYSTORE_PASSWORD, "");
    assert.equal(env.NODE_OPTIONS, "");
    assert.equal(env.OC_ANDROID_RP_ID, rpId);
    assert.equal(env.OC_WEBAUTHN_ORIGIN, rpId);
    assert.equal(env.OC_UNOFFICIAL_APK_RP_ID, rpId);
    assert.equal(env.OC_ACCOUNT_LINKING_CODES_ENABLED, "true");
    assert.equal(env.OC_II_DERIVATION_ORIGIN, "");
    assert.equal(env.OC_ANDROID_NATIVE_AUTH, "android-credential-manager-v1");
    assert.equal(env.CARGO_NET_OFFLINE, "true");
});

test("optimized APK keeps development deployment policy and model/OCR feature", () => {
    const env = createUnofficialLocalApkEnvironment(canisters, { rpId });
    assert.equal(env.NODE_ENV, "production");
    assert.equal(env.OC_NODE_ENV, "development");
    assert.equal(env.OC_BUILD_ENV, "development");
    assert.equal(env.OC_TRANSFORMERS_WEBGPU_IMAGE_SPIKE, "true");
    assert.equal(env.OC_TRANSFORMERS_WEBGPU_ASSET_DELIVERY, "immutable-hub-v1");
    assert.equal(env.OC_MOBILE_LAYOUT, "v2");
});

test("rebuild cache key changes without changing pinned weight delivery", () => {
    const first = createUnofficialLocalApkEnvironment(canisters, { rpId });
    const second = createUnofficialLocalApkEnvironment(canisters, { rpId });
    assert.notEqual(first.OC_WEBSITE_VERSION, second.OC_WEBSITE_VERSION);
    assert.equal(
        first.OC_TRANSFORMERS_WEBGPU_ASSET_DELIVERY,
        second.OC_TRANSFORMERS_WEBGPU_ASSET_DELIVERY,
    );
    assert.equal(
        createUnofficialLocalApkEnvironment(canisters, {
            rpId,
            buildId: first.OC_UNOFFICIAL_APK_BUILD_ID,
        }).OC_WEBSITE_VERSION,
        first.OC_WEBSITE_VERSION,
    );
    for (const buildId of ["", "../../anything", "f".repeat(31), "G".repeat(32)])
        assert.throws(() => createUnofficialLocalApkEnvironment(canisters, { buildId, rpId }));
});

test("bundle marker selects original native authentication without claiming provider qualification", () => {
    const marker = localApkBundleMarker("aaaaa-aa", "ABCD", rpId);
    assert.equal(marker.applicationId, "dev.openchatfork.localtest");
    assert.equal(marker.label, "OpenChat Fork · Local Test");
    assert.equal(marker.ota, "none");
    assert.equal(marker.nativeAuthentication, "android-credential-manager-v1");
    assert.equal(marker.androidRpId, rpId);
    assert.equal(Object.hasOwn(marker, "digitalAssetLinksVerified"), false);
    assert.equal(Object.hasOwn(marker, "providerQualified"), false);
    assert.throws(() => localApkBundleMarker("https://oc.app", "ABCD", rpId));
    assert.throws(() => localApkBundleMarker("aaaaa-aa", "nothex", rpId));
    assert.throws(() => localApkBundleMarker("aaaaa-aa", "ABCD"));
    assert.throws(() => localApkBundleMarker("aaaaa-aa", "ABCD", "oc.app"));
});

test("explicit RP accepts separate Tailscale and certified ICP hosts, not URLs or official defaults", () => {
    for (const value of [rpId, "aaaaa-aa.icp0.io", "aaaaa-aa.icp.net", "aaaaa-aa.ic0.app", "login.example.com"]) {
        assert.equal(parseLocalApkRpId(value), value);
        assert.equal(parseLocalApkArgs(["--rp-id", value]).rpId, value);
    }
    assert.equal(parseLocalApkRpId(rpId.toUpperCase()), rpId);
    for (const value of [
        undefined, null, 123, "", "oc.app", "login.oc.app", "OC.APP",
        "https://login.example.com", "login.example.com:443", "user@login.example.com",
        "login.example.com/path", "login.example.com?x=1", "login.example.com#x",
        "localhost", "app.localhost", "app.local", "127.0.0.1", "127.1", "2130706433",
        "0x7f.0x1", "[::1]", "::1", "192.168.1.2", "10.0.2.2",
        ".example.com", "app..example.com", "app.example.com.", "-app.example.com",
        "app-.example.com", "a_b.example.com", "app.example.com\n", " app.example.com",
        "app.example.com ", "éxample.com", `${"a".repeat(64)}.example.com`,
        `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}.com`,
        ...["icp0.io", "icp.net", "ic0.app"].flatMap((gateway) => [gateway, `raw.${gateway}`, `aaaaa-aa.raw.${gateway}`]),
    ]) assert.throws(() => parseLocalApkRpId(value), undefined, String(value));
});

test("missing explicit RP fails despite ambient generic RP or stale APK environment", () => {
    const inherited = {
        OC_ANDROID_RP_ID: rpId,
        OC_WEBAUTHN_ORIGIN: rpId,
        OC_UNOFFICIAL_APK_RP_ID: rpId,
        oc_android_rp_id: "oc.app",
        oc_unofficial_apk_rp_id: "oc.app",
    };
    assert.throws(() => createUnofficialLocalApkEnvironment(canisters, { inherited }));
    assert.throws(() => localApkBuildPlan(".", canisters, parseLocalApkArgs([]), inherited));
    assert.throws(() => localApkBuildPlan(".", canisters, { frontendOnly: true }, inherited));
    const parent = createUnofficialLocalApkEnvironment(canisters, { inherited, rpId });
    assert.equal(parent.OC_ANDROID_RP_ID, rpId);
    assert.equal(parent.oc_android_rp_id, undefined);
    assert.equal(parent.oc_unofficial_apk_rp_id, undefined);
    assert.throws(() => localApkBuildPlan(".", canisters, {}, parent));
});

test("frontend continuation validates the complete parent RP binding and rejects retargeting", () => {
    const parent = createUnofficialLocalApkEnvironment(canisters, { rpId });
    assert.equal(localApkParentRpId(parent), rpId);
    for (const key of ["OC_UNOFFICIAL_APK_RP_ID", "OC_ANDROID_RP_ID", "OC_WEBAUTHN_ORIGIN",
        "OC_UNOFFICIAL_APK_BUILD_ID", "OC_UNOFFICIAL_CLIENT", "OC_ANDROID_APPLICATION_ID", "OC_ANDROID_NATIVE_AUTH"]) {
        for (const value of [undefined, "", "other.example.com"]) {
            const changed = { ...parent, [key]: value };
            assert.throws(() => localApkBuildPlan(".", canisters, { frontendOnly: true }, changed), undefined, key);
        }
    }
    assert.throws(() => localApkBuildPlan(".", canisters, { frontendOnly: true, rpId: "other.example.com" }, parent));
    const child = localApkBuildPlan(".", canisters, { frontendOnly: true }, parent);
    assert.equal(child.options.env.OC_ANDROID_RP_ID, rpId);
    assert.equal(child.options.env.OC_WEBAUTHN_ORIGIN, rpId);
    assert.equal(localApkParentRpId(child.options.env), rpId);
});

test("CLI only accepts bounded build targets and no device/data operations", () => {
    assert.equal(parseLocalApkArgs([]).target, "aarch64");
    assert.equal(parseLocalApkArgs(["--target", "x86_64"]).target, "x86_64");
    for (const args of [
        ["--install"],
        ["--target", "arm"],
        ["--target"],
        ["--target", "aarch64", "--target", "x86_64"],
        ["--config", "arbitrary"],
        ["--rp-id"],
        ["--rp-id", rpId, "--rp-id", rpId],
    ])
        assert.throws(() => parseLocalApkArgs(args));
});

test("build plan contains GPU and private-handoff features without browser auth; never invokes shell/install", () => {
    const repo = fileURLToPath(new URL("..", import.meta.url));
    const plan = localApkBuildPlan(repo, canisters, parseLocalApkArgs(["--rp-id", rpId]));
    assert.equal(plan.options.shell, false);
    assert.equal(plan.options.windowsHide, true);
    assert.ok(plan.args.includes("transformers-webgpu-android,local-test-app-handoff"));
    assert.ok(!plan.args.some((arg) => arg.includes("local-test-browser-auth")));
    assert.doesNotMatch(read("frontend/src-tauri/Cargo.toml"), /local-test-browser-auth/);
    assert.ok(plan.args.includes("--apk"));
    assert.ok(!plan.args.some((arg) => ["install", "uninstall", "dev", "run"].includes(arg)));
});

test("frontend child retains parent's unique build ID", () => {
    const parent = createUnofficialLocalApkEnvironment(canisters, { rpId });
    const child = localApkBuildPlan(".", canisters, parseLocalApkArgs(["--frontend-only"]), parent);
    assert.equal(child.options.env.OC_WEBSITE_VERSION, parent.OC_WEBSITE_VERSION);
});

test("separate manifest keeps original RP metadata but no official App Links or Firebase initializer", () => {
    const manifest = read("frontend/src-tauri/gen/android/app/src/localTest/AndroidManifest.xml");
    assert.doesNotMatch(
        manifest,
        /android:host=|android:scheme=|BROWSABLE|autoVerify|CREDENTIAL_MANAGER_SET_ORIGIN/,
    );
    assert.match(
        manifest,
        /android:name="asset_statements" android:resource="@string\/asset_statements"/,
    );
    assert.match(manifest, /FirebaseInitProvider" tools:node="remove"/);
    assert.match(manifest, /android.permission.RECORD_AUDIO/);
    assert.match(manifest, /android.permission.READ_MEDIA_IMAGES/);
    assert.match(manifest, /\$\{applicationId\}\.fileprovider/);
    assert.match(manifest, /@string\/local_test_app_name/);
});

function assertLocalAppServiceBoundary({
  overlay,
  pluginManifest,
  officialManifest,
  gradle,
}) {
  const xml = overlay.replace(/<!--[\s\S]*?-->/g, "");
  const services = [...xml.matchAll(/<service\s+([^>]+)\/>/g)];
  assert.equal(services.length, 1);
  const attributes = Object.fromEntries(
    [...services[0][1].matchAll(/([\w:]+)="([^"]*)"/g)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  assert.equal([...services[0][1].matchAll(/([\w:]+)="([^"]*)"/g)].length, 3);
  assert.deepEqual(attributes, {
    "android:name": "com.ocplugin.app.privateapps.LocalAppTransferService",
    "android:exported": "false",
    "android:foregroundServiceType": "dataSync",
  });
  assert.equal((xml.match(/<service\b/g) ?? []).length, 1);
  assert.doesNotMatch(
    xml,
    /<intent-filter|<receiver|<activity|android:process=|android:permission=/,
  );
  assert.deepEqual(
    [...xml.matchAll(/<uses-permission\s+android:name="([^"]+)"\s*\/>/g)].map(
      (match) => match[1],
    ),
    ["android.permission.FOREGROUND_SERVICE_DATA_SYNC"],
  );
  assert.equal((xml.match(/<uses-permission\b/g) ?? []).length, 1);
  assert.match(
    pluginManifest,
    /<uses-permission android:name="android.permission.FOREGROUND_SERVICE"\s*\/>/,
  );
  for (const manifest of [pluginManifest, officialManifest]) {
    assert.doesNotMatch(
      manifest,
      /LocalAppTransferService|FOREGROUND_SERVICE_DATA_SYNC|localAppTransport/,
    );
  }
  assert.match(
    gradle,
    /if \(System.getenv\("OC_UNOFFICIAL_LOCAL_APK"\) == "true"\) \{\s*sourceSets.getByName\("debug"\).manifest.srcFile\("src\/localAppTransport\/AndroidManifest.xml"\)\s*sourceSets.getByName\("release"\).manifest.srcFile\("src\/localAppTransport\/AndroidManifest.xml"\)\s*\}/,
  );
  assert.equal(
    (gradle.match(/src\/localAppTransport\/AndroidManifest.xml/g) ?? []).length,
    2,
  );
}

function localAppServiceBoundaryFixture() {
  return {
    overlay: read(
      "frontend/tauri-plugin-oc/android/src/localAppTransport/AndroidManifest.xml",
    ),
    pluginManifest: read(
      "frontend/tauri-plugin-oc/android/src/main/AndroidManifest.xml",
    ),
    officialManifest: read(
      "frontend/src-tauri/gen/android/app/src/main/AndroidManifest.xml",
    ),
    gradle: read("frontend/tauri-plugin-oc/android/build.gradle.kts"),
  };
}

test("private-app dataSync service is nonexported and registered only by the local APK overlay", () => {
  assertLocalAppServiceBoundary(localAppServiceBoundaryFixture());
  const officialTauri = read("frontend/src-tauri/tauri.conf.json");
  assert.doesNotMatch(
    officialTauri,
    /local-app-handoff|local-app-setup|localAppTransport/,
  );
});

test("local service boundary rejects export, authority expansion and official-build registration", () => {
  const fixture = localAppServiceBoundaryFixture();
  for (const [field, before, after] of [
    ["overlay", 'android:exported="false"', 'android:exported="true"'],
    [
      "overlay",
      'android:foregroundServiceType="dataSync"',
      'android:foregroundServiceType="dataSync|phoneCall"',
    ],
    [
      "overlay",
      "android.permission.FOREGROUND_SERVICE_DATA_SYNC",
      "android.permission.FOREGROUND_SERVICE_SPECIAL_USE",
    ],
    [
      "overlay",
      "</application>",
      '<receiver android:name="SyntheticReceiver" /></application>',
    ],
    [
      "gradle",
      'if (System.getenv("OC_UNOFFICIAL_LOCAL_APK") == "true")',
      "if (true)",
    ],
    [
      "officialManifest",
      "</application>",
      '<service android:name="com.ocplugin.app.privateapps.LocalAppTransferService" /></application>',
    ],
  ]) {
    const changed = {
      ...fixture,
      [field]: fixture[field].replace(before, after),
    };
    assert.notEqual(changed[field], fixture[field]);
    assert.throws(() => assertLocalAppServiceBoundary(changed));
  }
});

test("Gradle identity is separate; JNI namespace remains stable", () => {
    const gradle = read("frontend/src-tauri/gen/android/app/build.gradle.kts");
    assert.match(gradle, /applicationId = if \(unofficialLocalTest\) localTestApplicationId/);
    assert.match(gradle, /namespace = "com.oclabs.openchat"/);
    assert.match(gradle, /!unofficialLocalTest && propFile.exists\(\)/);
    assert.match(gradle, /src\/localTest\/AndroidManifest.xml/);
    assert.match(gradle, /openchat-fork-local-test.apk/);
    assert.match(gradle, /marker\["nativeAuthentication"\] == "android-credential-manager-v1"/);
    assert.match(gradle, /marker\["androidRpId"\] as\? String/);
    assert.match(gradle, /System.getenv\("OC_UNOFFICIAL_APK_RP_ID"\)/);
    assert.match(gradle, /System.getenv\("OC_ANDROID_RP_ID"\) == rpId/);
    assert.match(gradle, /System.getenv\("OC_WEBAUTHN_ORIGIN"\) == rpId/);
    assert.match(gradle, /bundledOpenChatRpIdFile.isFile && bundledOpenChatRpIdFile.readText\(\) == rpId/);
    assert.match(gradle, /localApkMarkerRpId == rpId/);
    assert.match(gradle, /explicitLocalApkRpId \?: environmentOpenChatRpId \?: bundledOpenChatRpId \?: "oc.app"/);
    assert.doesNotMatch(gradle, /require\(!unofficialLocalTest \|\| openChatRpId == "oc.app"\)/);
    assert.doesNotMatch(gradle, /openChatRpId = if \(unofficialLocalTest\) ""/);
    assert.doesNotMatch(gradle, /if \(unofficialLocalTest\) "\[\]" else/);
});

test("only private-app bridges remain in the local overlay; browser authentication has no capability", () => {
    const overlay = JSON.parse(read("frontend/src-tauri/tauri.localtest.conf.json"));
    assert.deepEqual(overlay.plugins["deep-link"].mobile, []);
    assert.doesNotMatch(JSON.stringify(overlay), /local-browser-auth/);
    const handoff = overlay.app.security.capabilities.find(
        (entry) => entry.identifier === "local-app-handoff",
    );
    assert.deepEqual(handoff.windows, ["main"]);
    assert.equal(handoff.local, true);
    assert.deepEqual(handoff.permissions, ["oc:allow-local-app-handoff"]);
    const permission = read("frontend/tauri-plugin-oc/permissions/local-app-handoff.toml");
    assert.match(
        permission,
        /begin_local_app_handoff.*poll_local_app_handoff.*cancel_local_app_handoff/,
    );
});

test("only the local-test APK permits exact loopback cleartext without changing trust anchors", () => {
    const gradle = read("frontend/src-tauri/gen/android/app/build.gradle.kts");
    const localManifest = read(
        "frontend/src-tauri/gen/android/app/src/localTest/AndroidManifest.xml",
    );
    const productionManifest = read(
        "frontend/src-tauri/gen/android/app/src/main/AndroidManifest.xml",
    );
    const policy = read(
        "frontend/src-tauri/gen/android/app/src/localTest/res/xml/local_test_network_security_config.xml",
    );
    const normalize = (text) => text.replace(/\s+/g, " ").trim();
    const expected =
        '<?xml version="1.0" encoding="utf-8"?> <network-security-config> <base-config cleartextTrafficPermitted="false" /> <domain-config cleartextTrafficPermitted="true"> <domain includeSubdomains="false">localhost</domain> <domain includeSubdomains="false">127.0.0.1</domain> </domain-config> </network-security-config>';
    assert.equal(normalize(policy), expected);
    assert.equal(
        (
            localManifest.match(
                /android:networkSecurityConfig="@xml\/local_test_network_security_config"/g,
            ) ?? []
        ).length,
        1,
    );
    assert.doesNotMatch(productionManifest, /local_test_network_security_config/);
    assert.match(
        gradle,
        /if \(unofficialLocalTest\) \{\s*sourceSets\.getByName\("main"\)\.manifest\.srcFile\("src\/localTest\/AndroidManifest.xml"\)\s*sourceSets\.getByName\("main"\)\.res\.srcDir\("src\/localTest\/res"\)\s*\}/,
    );
    assert.equal((gradle.match(/res\.srcDir\("src\/localTest\/res"\)/g) ?? []).length, 1);
    assert.match(
        gradle,
        /defaultConfig \{\s*manifestPlaceholders\["usesCleartextTraffic"\] = "false"/,
    );
    for (const changed of [
        policy.replace(
            'base-config cleartextTrafficPermitted="false"',
            'base-config cleartextTrafficPermitted="true"',
        ),
        policy.replace('includeSubdomains="false"', 'includeSubdomains="true"'),
        policy.replace(">localhost<", ">example.com<"),
        policy.replace(">127.0.0.1<", ">10.0.2.2<"),
        policy.replace(
            "</network-security-config>",
            '<debug-overrides><trust-anchors><certificates src="user" /></trust-anchors></debug-overrides></network-security-config>',
        ),
    ])
        assert.notEqual(normalize(changed), expected);
});

test("Rollup keeps local web/private-app modes but emits no browser authentication assets", () => {
    const rollup = read("frontend/app/rollup.config.mjs");
    assert.match(rollup, /localAppRelayPlugin\(\{\s*enabled: localWebBuild,\s*appDirectoryUrl: process\.env\.OC_APP_DIRECTORY_URL,\s*\}\)/);
    assert.match(rollup, /localApkBundleMarker\(\s*process\.env\.OC_IDENTITY_CANISTER,\s*Principal\.fromText\(process\.env\.OC_IDENTITY_CANISTER\)\.toHex\(\),\s*androidRpId,/);
    assert.match(rollup, /localTestApk\s*\? localApkParentRpId\(process\.env\)/);
    assert.doesNotMatch(rollup, /localBrowserAuthBuildPlugin|local-browser-auth\.(?:html|js)/);
    assert.match(rollup, /import.meta.env.OC_UNOFFICIAL_LOCAL_APK/);
    assert.match(rollup, officialKeyWiring);
    assert.match(rollup, /localNativeAppHandoffBuildPlugin\(\{ enabled: localTestApk \}\)/);
    const handoff = read("frontend/app/localNativeAppHandoffBuild.mjs");
    assert.match(handoff, /src="\/handoff.js"/);
    assert.match(handoff, /fileName: "local-native-app-handoff.js"/);
    assert.match(handoff, /fileName: "local-native-app-handoff-profile.json"/);
    assert.match(handoff, nativeProfileWiring);
});

test("formatted APK wiring checks still reject different flags, sources and destinations", () => {
    for (const [pattern, compact, changed] of [
        [
            officialKeyWiring,
            "localClientBuild ? { queryPublicKey: queryOfficialUserIndexPublicKey,",
            "localClientBuild ? { queryPublicKey: queryDifferentPublicKey,",
        ],
        [
            nativeProfileWiring,
            'applicationId: "dev.openchatfork.localtest", transport: "private-app-code-v1",',
            'applicationId: "com.oclabs.openchat", transport: "private-app-code-v1",',
        ],
    ]) {
        assert.match(compact, pattern);
        assert.match(compact.replaceAll(" ", "\n    "), pattern);
        assert.doesNotMatch(changed, pattern);
    }
});

test("RP source wiring rejects a constant marker or a substituted native resource", () => {
    const markerWiring = /localApkBundleMarker\(\s*process\.env\.OC_IDENTITY_CANISTER,\s*Principal\.fromText\(process\.env\.OC_IDENTITY_CANISTER\)\.toHex\(\),\s*androidRpId,/;
    const rollup = read("frontend/app/rollup.config.mjs");
    assert.match(rollup, markerWiring);
    assert.doesNotMatch(rollup.replace(/(\.toHex\(\),\s*)androidRpId,/, '$1"oc.app",'), markerWiring);
    const resourceWiring = /resValue\("string", "openchat_rp_id", openChatRpId\)/;
    const gradle = read("frontend/src-tauri/gen/android/app/build.gradle.kts");
    assert.match(gradle, resourceWiring);
    assert.doesNotMatch(gradle.replace('"openchat_rp_id", openChatRpId', '"openchat_rp_id", "oc.app"'), resourceWiring);
});

test("native auth uses original Credential Manager operations without privileged origins; Firebase stays disabled", () => {
    const passkey = read("frontend/tauri-plugin-oc/android/src/main/java/commands/PasskeyAuth.kt");
    assert.doesNotMatch(
        passkey,
        /isUnofficialLocalTest|Use browser sign-in|Use the explicit browser link/,
    );
    assert.match(passkey, /credentialManager by lazy/);
    assert.match(passkey, /DEFAULT_RP_ID = "oc.app"/);
    assert.match(passkey, /credentialManager\.createCredential\(/);
    assert.match(passkey, /credentialManager\.getCredential\(/);
    assert.equal((passkey.match(/put\("userVerification", "required"\)/g) ?? []).length, 2);
    assert.doesNotMatch(passkey, /setOrigin\(|CREDENTIAL_MANAGER_SET_ORIGIN|origin\s*=/);
    const plugin = read("frontend/tauri-plugin-oc/android/src/main/java/OpenChatPlugin.kt");
    assert.match(
        plugin,
        /if \(!isUnofficialLocalTest\(activity\)\) OCPluginCompanion.initFcmTokenCache/,
    );
    const opener = read("frontend/tauri-plugin-oc/android/src/main/java/commands/OpenUrl.kt");
    assert.match(opener, /isUnofficialLocalTest\(activity\) && uri.host == "localhost"/);
});

test("native profile documents provider-specific qualification rather than asserting Google DAL approval", () => {
    const builder = read("scripts/build-unofficial-local-apk.mjs");
    assert.match(builder, /no asserted Google Password Manager\/Digital Asset Links authorization/);
    assert.match(builder, /provider-specific app trust must be qualified separately/);
    assert.match(builder, /existsSync\(path\.join\(output, "local-browser-auth\.html"\)\)/);
    assert.match(builder, /existsSync\(path\.join\(output, "local-browser-auth\.js"\)\)/);
    // Source/build contracts do not substitute for a user's provider consent or
    // a successful emulator sign-in; no Google/domain verification is claimed.
});

test("private handoff plugin bundles the real browser entry and is inert outside local APK", async () => {
    const absent = [];
    await localNativeAppHandoffBuildPlugin().generateBundle.call({
        emitFile: (asset) => absent.push(asset),
    });
    assert.deepEqual(absent, []);
    const assets = [];
    await localNativeAppHandoffBuildPlugin({ enabled: true }).generateBundle.call({
        emitFile: (asset) => assets.push(asset),
    });
    assert.deepEqual(
        assets.map((asset) => asset.fileName),
        [
            "local-native-app-handoff.html",
            "local-native-app-handoff.js",
            "local-native-app-handoff-profile.json",
        ],
    );
    const script = new TextDecoder().decode(assets[1].source);
    assert.ok(script.length > 0 && script.length < 1024 * 1024);
    assert.doesNotThrow(() => new Function(script));
    assert.match(assets[0].source, /src="\/handoff.js"/);
    assert.deepEqual(JSON.parse(assets[2].source), {
        version: 1,
        applicationId: "dev.openchatfork.localtest",
        transport: "private-app-code-v1",
    });
});
