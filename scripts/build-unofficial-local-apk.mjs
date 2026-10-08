#!/usr/bin/env node
// Builds only the separate local package. No install, uninstall, launch, linking or data cleanup.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    createUnofficialLocalApkEnvironment,
    localApkParentRpId,
    parseLocalApkRpId,
    UNOFFICIAL_LOCAL_APK_ID,
} from "../frontend/unofficialLocalApkProfile.mjs";
import { parseAppDirectoryUrl } from "../frontend/unofficialLocalProfile.mjs";

export function parseLocalApkArgs(args) {
    const options = { target: "aarch64", frontendOnly: false, help: false };
    const seen = new Set();
    for (let i = 0; i < args.length; i++) {
        const flag = args[i];
        if (seen.has(flag)) throw new Error("Repeated local APK option");
        seen.add(flag);
        if (flag === "--help" || flag === "-h") options.help = true;
        else if (flag === "--frontend-only") options.frontendOnly = true;
        else if (flag === "--rp-id") {
            options.rpId = parseLocalApkRpId(args[++i]);
        } else if (flag === "--app-directory") {
            const value = args[++i];
            if (!value) throw new Error("--app-directory requires a URL");
            options.appDirectoryUrl = parseAppDirectoryUrl(value);
        } else if (flag === "--target") {
            const target = args[++i];
            if (target !== "aarch64" && target !== "x86_64")
                throw new Error("Use --target aarch64 or x86_64");
            options.target = target;
        } else
            throw new Error(
                "Use --rp-id <HTTPS hostname>, --target aarch64|x86_64, --frontend-only, or --app-directory <public URL>",
            );
    }
    return options;
}

export function localApkBuildPlan(repository, canisters, options, inherited = {}) {
    const parentRpId =
        options.frontendOnly && inherited.OC_UNOFFICIAL_LOCAL_APK === "true"
            ? localApkParentRpId(inherited)
            : undefined;
    const rpId = options.rpId === undefined ? parentRpId : parseLocalApkRpId(options.rpId);
    if (parentRpId !== undefined && rpId !== parentRpId)
        throw new Error("Local APK frontend RP differs from its explicit parent profile");
    const env = createUnofficialLocalApkEnvironment(canisters, {
        inherited,
        rpId,
        // The Tauri child retains only this explicit parent setting, like its build ID.
        appDirectoryUrl:
            options.appDirectoryUrl ??
            (options.frontendOnly && inherited.OC_UNOFFICIAL_LOCAL_APK === "true"
                ? inherited.OC_APP_DIRECTORY_URL
                : undefined),
        buildId:
            options.frontendOnly && inherited.OC_UNOFFICIAL_LOCAL_APK === "true"
                ? inherited.OC_UNOFFICIAL_APK_BUILD_ID
                : undefined,
    });
    const frontend = path.resolve(repository, "frontend");
    const args = options.frontendOnly
        ? [path.join(frontend, "node_modules/rollup/dist/bin/rollup"), "-c"]
        : [
              path.join(frontend, "node_modules/@tauri-apps/cli/tauri.js"),
              "android",
              "build",
              "--apk",
              "--ci",
              "--target",
              options.target,
              "--config",
              path.join(frontend, "src-tauri/tauri.localtest.conf.json"),
              "--features",
              "transformers-webgpu-android,local-test-app-handoff",
          ];
    return Object.freeze({
        command: process.execPath,
        args: Object.freeze(args),
        options: Object.freeze({
            cwd: options.frontendOnly ? path.join(frontend, "app") : frontend,
            env,
            shell: false,
            windowsHide: true,
            stdio: "inherit",
        }),
    });
}

export function main(args = process.argv.slice(2)) {
    const options = parseLocalApkArgs(args);
    if (options.help) {
        console.log(
            "Usage: node scripts/build-unofficial-local-apk.mjs --rp-id <HTTPS hostname> [--target aarch64|x86_64] [--app-directory <public URL>]",
        );
        console.log(
            "Builds a separate local APK; does not install or access a device/account. Rust dependencies must already be cached.",
        );
        return;
    }
    const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const canisters = JSON.parse(readFileSync(path.join(repository, "canister_ids.json"), "utf8"));
    const plan = localApkBuildPlan(repository, canisters, options, process.env);
    if (!existsSync(plan.args[0]))
        throw new Error("Reviewed frontend dependencies must be installed before building");
    console.log(
        `Local test APK: ${UNOFFICIAL_LOCAL_APK_ID}; original native Credential Manager sign-in; OTA disabled; old APK/data untouched.`,
    );
    console.log(
        `Native RP is ${plan.options.env.OC_ANDROID_RP_ID}. This separate package/signature has no asserted Google Password Manager/Digital Asset Links authorization; provider-specific app trust must be qualified separately.`,
    );
    const result = spawnSync(plan.command, [...plan.args], plan.options);
    if (result.error) throw new Error("Local APK build process could not start");
    process.exitCode = result.status ?? 1;
    if (result.status === 0 && options.frontendOnly) {
        const output = path.join(repository, "frontend/app/build");
        const marker = JSON.parse(
            readFileSync(path.join(output, "local-apk-profile.json"), "utf8"),
        );
        const ota = JSON.parse(readFileSync(path.join(output, "ota-policy.json"), "utf8"));
        if (
            marker.applicationId !== UNOFFICIAL_LOCAL_APK_ID ||
            marker.nativeAuthentication !== "android-credential-manager-v1" ||
            marker.androidRpId !== plan.options.env.OC_ANDROID_RP_ID ||
            readFileSync(path.join(output, "android-rp-id"), "utf8") !==
                plan.options.env.OC_ANDROID_RP_ID ||
            ota.strategy !== "none" ||
            existsSync(path.join(output, "local-browser-auth.html")) ||
            existsSync(path.join(output, "local-browser-auth.js")) ||
            !existsSync(path.join(output, "local-native-app-handoff.html")) ||
            !existsSync(path.join(output, "local-native-app-handoff.js")) ||
            !existsSync(path.join(output, "local-native-app-handoff-profile.json")) ||
            !existsSync(path.join(output, "local-native-app-setup.html")) ||
            !existsSync(path.join(output, "local-native-app-setup.js")) ||
            !existsSync(path.join(output, "local-native-app-setup-profile.json"))
        ) {
            throw new Error(
                "Local APK native-auth policy or private-app assets are invalid; browser authentication assets must be absent",
            );
        }
    }
    return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    try {
        main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : "Local APK build failed");
        process.exitCode = 1;
    }
}
