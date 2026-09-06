#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
export const ANDROID_RELEASE_BUILD_TOOLS_VERSION = "35.0.0";

export function releaseBuildToolsDirectory(androidHome, version) {
    if (typeof androidHome !== "string" || !androidHome.trim()) throw new Error("ANDROID_HOME is required for APK verification.");
    if (version !== ANDROID_RELEASE_BUILD_TOOLS_VERSION) {
        throw new Error(`ANDROID_BUILD_TOOLS_VERSION must explicitly select the reviewed ${ANDROID_RELEASE_BUILD_TOOLS_VERSION} tools.`);
    }
    return resolve(androidHome, "build-tools", version);
}

export function nativeVersion(version, code) {
    const match = typeof version === "string" && semver.exec(version);
    if (!match || match[0] !== version) throw new Error("Android version must be exactly X.Y.Z (no prefix or prerelease).");
    if (!match.slice(1).every((part) => Number.isSafeInteger(Number(part)))) {
        throw new Error("Android semver components must be safe integers.");
    }
    // OpenChat uses patch numbers above 999. A semver-derived formula can collide,
    // so require an explicit store-compatible code rather than guessing a new scheme.
    const versionCode = Number(code);
    if (typeof code !== "string" || !/^[1-9]\d*$/u.test(code) || code !== code.trim() ||
        !Number.isSafeInteger(versionCode) || versionCode > 2_100_000_000) {
        throw new Error("Android versionCode must be explicitly configured as an integer from 1 to 2100000000.");
    }
    return { version, versionCode };
}

export function releasePolicy({ eventName, tag = "", manualVersion = "", releaseVersionCode, manualVersionCode }) {
    if (eventName === "release") {
        // Non-Android checkpoint/website releases must never enter the Android build job.
        if (!tag.endsWith("-android")) return { eligible: false };
        if (!tag.startsWith("v")) throw new Error("Android release tags must be vX.Y.Z-android.");
        return { eligible: true, ...nativeVersion(tag.slice(1, -8), releaseVersionCode) };
    }
    if (eventName === "workflow_dispatch") {
        return { eligible: true, ...nativeVersion(manualVersion, manualVersionCode) };
    }
    return { eligible: false };
}

export function tauriVersionConfig(version, code) {
    const parsed = nativeVersion(version, code);
    return {
        version: parsed.version,
        bundle: { android: { versionCode: parsed.versionCode, autoIncrementVersionCode: false } },
    };
}

export function signingFingerprint(value) {
    if (typeof value !== "string" || value !== value.trim() ||
        !/^(?:[a-fA-F0-9]{64}|(?:[a-fA-F0-9]{2}:){31}[a-fA-F0-9]{2})$/u.test(value)) {
        throw new Error("ANDROID_RELEASE_CERT_SHA256 must pin the approved release certificate.");
    }
    return value.replaceAll(":", "").toLowerCase();
}

export function assertSigningConfigured(environment) {
    for (const name of ["ANDROID_KEYSTORE_BASE64", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD"]) {
        if (typeof environment[name] !== "string" || !environment[name].trim()) {
            throw new Error(`Required release signing configuration is missing: ${name}`);
        }
    }
    signingFingerprint(environment.ANDROID_RELEASE_CERT_SHA256);
}

export function verifyApkMetadata({ badging, certificates, version, versionCode, certificateSha256 }) {
    const expected = nativeVersion(version, versionCode);
    const packageLine = badging.split(/\r?\n/u).find((line) => line.startsWith("package: "));
    const field = (name) => packageLine?.match(new RegExp(`(?:^| )${name}='([^']*)'`, "u"))?.[1];
    if (field("name") !== "com.oc.app" || field("versionName") !== expected.version ||
        field("versionCode") !== String(expected.versionCode)) {
        throw new Error("Built APK application ID or native version does not match the release policy.");
    }
    const signers = [...certificates.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]+)\r?$/gmu)];
    if (signers.length !== 1 || signingFingerprint(signers[0][1]) !== signingFingerprint(certificateSha256)) {
        throw new Error("Built APK must have exactly the approved release signing certificate.");
    }
}

function verifyApk(apk, environment) {
    if (!apk || !environment.ANDROID_HOME) throw new Error("APK path and ANDROID_HOME are required.");
    const toolDirectory = releaseBuildToolsDirectory(environment.ANDROID_HOME, environment.ANDROID_BUILD_TOOLS_VERSION);
    if (!existsSync(toolDirectory)) throw new Error("The reviewed Android build-tools installation is missing; install it before APK verification.");
    const run = (name, args) => {
        const result = spawnSync(resolve(toolDirectory, name), args, { encoding: "utf8" });
        if (result.error || result.status !== 0) throw new Error(`APK verification failed: ${name}`);
        return result.stdout;
    };
    verifyApkMetadata({
        badging: run("aapt", ["dump", "badging", apk]),
        certificates: run("apksigner", ["verify", "--print-certs", apk]),
        version: environment.VERSION,
        versionCode: environment.VERSION_CODE,
        certificateSha256: environment.ANDROID_RELEASE_CERT_SHA256,
    });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const command = process.argv[2];
        if (command === "plan") {
            const policy = releasePolicy({
                eventName: process.env.GITHUB_EVENT_NAME,
                tag: process.env.ANDROID_RELEASE_TAG,
                manualVersion: process.env.ANDROID_MANUAL_VERSION,
                releaseVersionCode: process.env.ANDROID_RELEASE_VERSION_CODE,
                manualVersionCode: process.env.ANDROID_MANUAL_VERSION_CODE,
            });
            if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required.");
            appendFileSync(process.env.GITHUB_OUTPUT, `eligible=${policy.eligible}\n`);
            if (policy.eligible) {
                appendFileSync(process.env.GITHUB_OUTPUT, `version=${policy.version}\nversion_code=${policy.versionCode}\ntauri_config=${JSON.stringify(tauriVersionConfig(policy.version, String(policy.versionCode)))}\n`);
            }
            console.log(policy.eligible ? `Validated Android ${policy.version} (${policy.versionCode}).` : "Not an Android release; APK build and upload are skipped.");
        } else if (command === "signing") {
            assertSigningConfigured(process.env);
            console.log("Required release signing configuration is present; APK identity will be verified before upload.");
        } else if (command === "verify-apk") {
            verifyApk(process.argv[3], process.env);
            console.log("APK native version, application ID, and release signing certificate verified.");
        } else {
            throw new Error("Usage: android_release_policy.mjs plan|signing|verify-apk <path>");
        }
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
