#!/usr/bin/env node
// Build only: never installs, publishes, creates keys, or changes an account/device.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    createUnofficialProductionApkEnvironment, productionApkParentRpId,
    PRIVATE_APK_ID, PRIVATE_APK_VERSION, PRIVATE_APK_RP_ID, PRIVATE_APP_DIRECTORY,
} from "../frontend/unofficialProductionApkProfile.mjs";

export function parseProductionApkArgs(args) {
    const options = { target: "aarch64", frontendOnly: false, help: false };
    const seen = new Set();
    for (let i = 0; i < args.length; i++) {
        const flag = args[i];
        if (seen.has(flag)) throw new Error("Repeated production APK option");
        seen.add(flag);
        if (flag === "--help" || flag === "-h") options.help = true;
        else if (flag === "--frontend-only") options.frontendOnly = true;
        else if (flag === "--target" && ["aarch64", "x86_64"].includes(args[i + 1]))
            options.target = args[++i];
        else throw new Error("Use --target aarch64|x86_64 or --frontend-only; release endpoints/package are pinned");
    }
    return options;
}

export function productionApkBuildPlan(repository, canisters, options, inherited = {}) {
    if (options.frontendOnly) productionApkParentRpId(inherited);
    const env = createUnofficialProductionApkEnvironment(canisters, {
        inherited, buildId: options.frontendOnly ? inherited.OC_UNOFFICIAL_APK_BUILD_ID : undefined,
    });
    const frontend = path.resolve(repository, "frontend");
    return Object.freeze({
        command: process.execPath,
        args: Object.freeze(options.frontendOnly
            ? [path.join(frontend, "node_modules/rollup/dist/bin/rollup"), "-c"]
            : [path.join(frontend, "node_modules/@tauri-apps/cli/tauri.js"), "android", "build",
                "--apk", "--ci", "--target", options.target, "--config",
                path.join(frontend, "src-tauri/tauri.private.conf.json"), "--features",
                "transformers-webgpu-android,local-test-app-handoff"]),
        options: Object.freeze({ cwd: options.frontendOnly ? path.join(frontend, "app") : frontend,
            env, shell: false, windowsHide: true, stdio: "inherit" }),
    });
}

export function verifyProductionApkFrontend(output) {
    const json = (name) => JSON.parse(readFileSync(path.join(output, name), "utf8"));
    const marker = json("private-apk-profile.json");
    if (marker.applicationId !== PRIVATE_APK_ID || marker.releaseVersion !== PRIVATE_APK_VERSION ||
        marker.androidRpId !== PRIVATE_APK_RP_ID || marker.appDirectoryUrl !== PRIVATE_APP_DIRECTORY ||
        marker.nativeAuthentication !== "android-credential-manager-v1" || marker.ota !== "none" ||
        readFileSync(path.join(output, "android-rp-id"), "utf8") !== PRIVATE_APK_RP_ID ||
        json("ota-policy.json").strategy !== "none" ||
        ["local-apk-profile.json", "local-browser-auth.html", "local-browser-auth.js"].some((name) => existsSync(path.join(output, name))))
        throw new Error("OpenChat Private frontend profile/authentication policy mismatch");
    for (const [stem, transport] of [["handoff", "private-app-code-v1"], ["setup", "private-app-setup-v1"]]) {
        const profile = json(`local-native-app-${stem}-profile.json`);
        if (profile.applicationId !== PRIVATE_APK_ID || profile.transport !== transport ||
            !existsSync(path.join(output, `local-native-app-${stem}.html`)) ||
            !existsSync(path.join(output, `local-native-app-${stem}.js`)))
            throw new Error("OpenChat Private native app transport mismatch");
    }
}

export function main(args = process.argv.slice(2)) {
    const options = parseProductionApkArgs(args);
    if (options.help) {
        console.log("Usage: node scripts/build-unofficial-production-apk.mjs [--target aarch64|x86_64]");
        console.log("Requires the four OC_ANDROID signing variables. Does not create/read keys, install, deploy or publish.");
        return;
    }
    const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const canisters = JSON.parse(readFileSync(path.join(repository, "canister_ids.json"), "utf8"));
    const plan = productionApkBuildPlan(repository, canisters, options, process.env);
    if (!existsSync(plan.args[0])) throw new Error("Reviewed frontend dependencies must be installed first");
    if (!existsSync(plan.options.env.OC_ANDROID_KEYSTORE_PATH)) throw new Error("Configured release keystore is missing");
    console.log(`Building ${PRIVATE_APK_ID} ${PRIVATE_APK_VERSION}; official chat backend; native passkeys; OTA disabled.`);
    const result = spawnSync(plan.command, [...plan.args], plan.options);
    if (result.error) throw new Error("Production APK build process could not start");
    process.exitCode = result.status ?? 1;
    if (result.status === 0) verifyProductionApkFrontend(path.join(repository, "frontend/app/build"));
    return result;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    try { main(); } catch (error) {
        console.error(error instanceof Error ? error.message : "Production APK build failed");
        process.exitCode = 1;
    }
}
