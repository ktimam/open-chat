#!/usr/bin/env node
// Builds only the separate local package. No install, uninstall, launch, linking or data cleanup.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createUnofficialLocalApkEnvironment, UNOFFICIAL_LOCAL_APK_ID } from "../frontend/unofficialLocalApkProfile.mjs";

export function parseLocalApkArgs(args) {
    const options = { target: "aarch64", frontendOnly: false, help: false };
    const seen = new Set();
    for (let i = 0; i < args.length; i++) {
        const flag = args[i];
        if (seen.has(flag)) throw new Error("Repeated local APK option");
        seen.add(flag);
        if (flag === "--help" || flag === "-h") options.help = true;
        else if (flag === "--frontend-only") options.frontendOnly = true;
        else if (flag === "--target") {
            const target = args[++i];
            if (target !== "aarch64" && target !== "x86_64") throw new Error("Use --target aarch64 or x86_64");
            options.target = target;
        } else throw new Error("Only --target aarch64|x86_64 and --frontend-only are supported");
    }
    return options;
}

export function localApkBuildPlan(repository, canisters, options, inherited = {}) {
    const env = createUnofficialLocalApkEnvironment(canisters, {
        inherited,
        buildId: options.frontendOnly && inherited.OC_UNOFFICIAL_LOCAL_APK === "true"
            ? inherited.OC_UNOFFICIAL_APK_BUILD_ID : undefined,
    });
    const frontend = path.resolve(repository, "frontend");
    const args = options.frontendOnly
        ? [path.join(frontend, "node_modules/rollup/dist/bin/rollup"), "-c"]
        : [path.join(frontend, "node_modules/@tauri-apps/cli/tauri.js"), "android", "build", "--apk", "--ci", "--target", options.target,
            "--config", path.join(frontend, "src-tauri/tauri.localtest.conf.json"), "--features", "transformers-webgpu-android,local-test-browser-auth"];
    return Object.freeze({ command: process.execPath, args: Object.freeze(args), options: Object.freeze({
        cwd: options.frontendOnly ? path.join(frontend, "app") : frontend,
        env, shell: false, windowsHide: true, stdio: "inherit",
    }) });
}

export function main(args = process.argv.slice(2)) {
    const options = parseLocalApkArgs(args);
    if (options.help) {
        console.log("Usage: node scripts/build-unofficial-local-apk.mjs [--target aarch64|x86_64]");
        console.log("Builds a separate local APK; does not install or access a device/account. Rust dependencies must already be cached.");
        return;
    }
    const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const canisters = JSON.parse(readFileSync(path.join(repository, "canister_ids.json"), "utf8"));
    const plan = localApkBuildPlan(repository, canisters, options, process.env);
    if (!existsSync(plan.args[0])) throw new Error("Reviewed frontend dependencies must be installed before building");
    console.log(`Local test APK: ${UNOFFICIAL_LOCAL_APK_ID}; browser-mediated five-minute sign-in; OTA disabled; old APK/data untouched.`);
    const result = spawnSync(plan.command, [...plan.args], plan.options);
    if (result.error) throw new Error("Local APK build process could not start");
    process.exitCode = result.status ?? 1;
    if (result.status === 0 && options.frontendOnly) {
        const output = path.join(repository, "frontend/app/build");
        const marker = JSON.parse(readFileSync(path.join(output, "local-apk-profile.json"), "utf8"));
        const ota = JSON.parse(readFileSync(path.join(output, "ota-policy.json"), "utf8"));
        if (marker.applicationId !== UNOFFICIAL_LOCAL_APK_ID || marker.nativeAuthentication !== "browser-bridge-v1" || ota.strategy !== "none" ||
            !existsSync(path.join(output, "local-browser-auth.html")) || !existsSync(path.join(output, "local-browser-auth.js"))) {
            throw new Error("Local APK policy or browser-sign-in assets are incomplete");
        }
    }
    return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    try { main(); } catch (error) { console.error(error instanceof Error ? error.message : "Local APK build failed"); process.exitCode = 1; }
}
