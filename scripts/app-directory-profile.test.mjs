import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createUnofficialLocalEnvironment,
  UNOFFICIAL_LOCAL_CANISTERS,
  parseAppDirectoryUrl,
} from "../frontend/unofficialLocalProfile.mjs";
import { createUnofficialLocalApkEnvironment } from "../frontend/unofficialLocalApkProfile.mjs";
import {
  parseUnofficialLocalArgs,
  unofficialLocalLaunchPlan,
} from "./start-unofficial-local.mjs";
import {
  parseBuildArgs,
  localWebBuildPlan,
} from "./build-unofficial-local-web.mjs";
import {
  localApkBuildPlan,
  parseLocalApkArgs,
} from "./build-unofficial-local-apk.mjs";
import { localNativeAppSetupBuildPlugin } from "../frontend/app/localNativeAppSetupBuild.mjs";
const canisters = Object.fromEntries(
  Object.values(UNOFFICIAL_LOCAL_CANISTERS).map((name) => [
    name,
    { ic: "aaaaa-aa" },
  ]),
);
const directory = "https://publisher.example/apps-v1.json";
const rpId = "fork-test.tail000000.ts.net";
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const initEnvUrl = new URL("../frontend/app/rollup.extras.mjs", import.meta.url)
  .href;
const officialCanisters = JSON.parse(
  readFileSync(new URL("../canister_ids.json", import.meta.url), "utf8"),
);

function actualInitEnv(environment) {
  const script = `
        import { initEnv } from ${JSON.stringify(initEnvUrl)};
        const snapshot = () => Object.fromEntries([
            "OC_APP_DIRECTORY_URL", "OC_UNOFFICIAL_CLIENT", "OC_UNOFFICIAL_WEB_BUILD",
            "OC_UNOFFICIAL_LOCAL_APK", "OC_MOBILE_LAYOUT", "OC_APP_TYPE", "OC_OTA_UPDATES",
            "OC_IC_URL", "OC_USER_INDEX_CANISTER", "OC_TRANSFORMERS_WEBGPU_ASSET_DELIVERY",
            "OC_BASE_ORIGIN", "OC_WEBSITE_VERSION", "OC_UNOFFICIAL_APK_RP_ID",
            "OC_ANDROID_RP_ID", "OC_WEBAUTHN_ORIGIN"
        ].map(key => [key, process.env[key] ?? null]));
        try {
            initEnv({ websiteVersion: "0.0.0-directory-test" });
            const first = snapshot();
            initEnv({ websiteVersion: "0.0.0-directory-test" });
            console.log("DIRECTORY_INIT_ENV_RESULT=" + JSON.stringify({ first, second: snapshot() }));
        } catch (error) {
            console.error(error instanceof Error ? error.message : "Environment normalization failed");
            process.exitCode = 1;
        }
    `;
  return spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      cwd: path.join(repositoryRoot, "frontend/app"),
      env: { ...environment },
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      shell: false,
    },
  );
}

for (const mode of [
  "dev-v1",
  "dev-v2",
  "optimized-v1",
  "optimized-v2",
  "apk",
]) {
  test(`actual initEnv retains the explicit directory for ${mode} and rejects invalid re-normalization`, (context) => {
    // This directory contains no build output: the real optimized profile only verifies it
    // is empty. OC_TEST_TEMP_ROOT lets local callers keep all fixtures in project temp.
    const output = mkdtempSync(
      path.join(
        process.env.OC_TEST_TEMP_ROOT ?? tmpdir(),
        "openchat-directory-env-",
      ),
    );
    context.after(() => rmSync(output, { recursive: true, force: true }));
    const layout = mode.endsWith("v1") ? "v1" : "v2";
    const options = {
      port: 5190,
      layout,
      output,
      appDirectoryUrl: directory,
      buildId: "a".repeat(32),
    };
    const plan =
      mode === "apk"
        ? localApkBuildPlan(
            repositoryRoot,
            officialCanisters,
            { appDirectoryUrl: directory, rpId },
            {},
          )
        : mode.startsWith("optimized")
          ? localWebBuildPlan(repositoryRoot, officialCanisters, options)
          : unofficialLocalLaunchPlan(
              repositoryRoot,
              officialCanisters,
              options,
            );
    assert.equal(
      plan.options.env.OC_APP_DIRECTORY_URL,
      directory,
      "first-stage operator configuration",
    );
    const child = actualInitEnv(plan.options.env);
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    const line = child.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("DIRECTORY_INIT_ENV_RESULT="));
    assert.ok(
      line,
      "the actual shared Rollup/Vite initializer returned its final environment",
    );
    const result = JSON.parse(line.slice("DIRECTORY_INIT_ENV_RESULT=".length));
    assert.deepEqual(
      result.first,
      result.second,
      "repeated normalization must be stable",
    );
    assert.equal(result.second.OC_APP_DIRECTORY_URL, directory);
    if (mode === "apk") {
      assert.equal(result.second.OC_UNOFFICIAL_APK_RP_ID, rpId);
      assert.equal(result.second.OC_ANDROID_RP_ID, rpId);
      assert.equal(result.second.OC_WEBAUTHN_ORIGIN, rpId);
      for (const key of ["OC_UNOFFICIAL_APK_RP_ID", "OC_ANDROID_RP_ID", "OC_WEBAUTHN_ORIGIN"]) {
        const changed = actualInitEnv({ ...plan.options.env, [key]: "other.example.com" });
        assert.equal(changed.status, 1, key);
        assert.match(changed.stderr, /matching explicit parent RP profile/);
      }
    }
    assert.equal(result.second.OC_UNOFFICIAL_CLIENT, "true");
    assert.equal(result.second.OC_MOBILE_LAYOUT, layout);
    assert.equal(result.second.OC_APP_TYPE, mode === "apk" ? "android" : "web");
    assert.equal(
      result.second.OC_UNOFFICIAL_LOCAL_APK,
      mode === "apk" ? "true" : null,
    );
    assert.equal(
      result.second.OC_UNOFFICIAL_WEB_BUILD,
      mode.startsWith("optimized") ? "true" : null,
    );
    assert.equal(result.second.OC_OTA_UPDATES, "none");
    assert.equal(result.second.OC_IC_URL, "https://icp-api.io");
    assert.equal(
      result.second.OC_USER_INDEX_CANISTER,
      officialCanisters.user_index.ic,
    );
    assert.equal(
      result.second.OC_TRANSFORMERS_WEBGPU_ASSET_DELIVERY,
      "immutable-hub-v1",
    );
    assert.equal(
      result.second.OC_BASE_ORIGIN,
      mode === "apk" ? "http://tauri.localhost" : "http://localhost:5190",
    );
    const invalid = actualInitEnv({
      ...plan.options.env,
      OC_APP_DIRECTORY_URL: "https://publisher.example/apps.json?secret=no",
    });
    assert.equal(invalid.status, 1);
    assert.match(
      invalid.stderr,
      /App directory requires HTTPS or explicit loopback HTTP/,
    );
    assert.doesNotMatch(invalid.stdout, /DIRECTORY_INIT_ENV_RESULT=/);
  });
}
test("operator config, not inherited environment, selects generic app directory", () => {
  assert.equal(
    createUnofficialLocalEnvironment(canisters, {
      inherited: { OC_APP_DIRECTORY_URL: directory },
    }).OC_APP_DIRECTORY_URL,
    "",
  );
  assert.equal(
    createUnofficialLocalEnvironment(canisters, { appDirectoryUrl: directory })
      .OC_APP_DIRECTORY_URL,
    directory,
  );
  assert.equal(
    createUnofficialLocalApkEnvironment(canisters, {
      appDirectoryUrl: directory,
      rpId,
    }).OC_APP_DIRECTORY_URL,
    directory,
  );
  for (const value of [
    "http://remote.example/apps.json",
    "https://u:p@publisher.example/apps.json",
    "https://publisher.example/a?token=x",
    "https://publisher.example/a#x",
    "javascript:alert(1)",
  ])
    assert.throws(() => parseAppDirectoryUrl(value));
});
test("all local build entrypoints accept explicit app directory; child retains it", () => {
  assert.equal(
    parseUnofficialLocalArgs(["--app-directory", directory]).appDirectoryUrl,
    directory,
  );
  assert.equal(
    parseBuildArgs(["--output", "/unused", "--app-directory", directory])
      .appDirectoryUrl,
    directory,
  );
  assert.equal(
    parseLocalApkArgs(["--app-directory", directory]).appDirectoryUrl,
    directory,
  );
  const parent = createUnofficialLocalApkEnvironment(canisters, {
    appDirectoryUrl: directory,
    rpId,
  });
  const child = localApkBuildPlan(
    ".",
    canisters,
    { frontendOnly: true },
    parent,
  );
  assert.equal(child.options.env.OC_APP_DIRECTORY_URL, directory);
});
test("setup bridge assets are bundled only for explicit local builds", async () => {
  const assets = [];
  await localNativeAppSetupBuildPlugin().generateBundle.call({
    emitFile: (asset) => assets.push(asset),
  });
  assert.equal(assets.length, 0);
  await localNativeAppSetupBuildPlugin({ enabled: true }).generateBundle.call({
    emitFile: (asset) => assets.push(asset),
  });
  assert.deepEqual(
    assets.map((asset) => asset.fileName),
    [
      "local-native-app-setup.html",
      "local-native-app-setup.js",
      "local-native-app-setup-profile.json",
    ],
  );
  assert.match(assets[0].source, /src="\/setup.js"/);
  assert.doesNotThrow(
    () => new Function(new TextDecoder().decode(assets[1].source)),
  );
  assert.equal(JSON.parse(assets[2].source).transport, "private-app-setup-v1");
  const overlay = JSON.parse(
    readFileSync(
      new URL(
        "../frontend/src-tauri/tauri.localtest.conf.json",
        import.meta.url,
      ),
    ),
  );
  const capability = overlay.app.security.capabilities.find(
    (entry) => entry.identifier === "local-app-setup",
  );
  assert.deepEqual(capability.permissions, ["oc:allow-local-app-setup"]);
  assert.deepEqual(capability.windows, ["main"]);
  assert.equal(capability.local, true);
});
