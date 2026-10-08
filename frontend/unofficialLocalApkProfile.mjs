import { randomBytes } from "node:crypto";
import { createUnofficialLocalEnvironment } from "./unofficialLocalProfile.mjs";

export const UNOFFICIAL_LOCAL_APK_ID = "dev.openchatfork.localtest";
export const UNOFFICIAL_LOCAL_APK_LABEL = "OpenChat Fork · Local Test";

/** Explicit operator input, not a URL or a claim of provider/domain authorization. */
export function parseLocalApkRpId(value) {
    if (typeof value !== "string" || value.length > 253 || value.trim() !== value)
        throw new Error("Local APK requires explicit --rp-id <HTTPS hostname>");
    const hostname = value.toLowerCase();
    const labels = hostname.split(".");
    if (
        labels.length < 2 ||
        labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
        !/^[a-z]/.test(labels.at(-1)) ||
        hostname === "oc.app" ||
        hostname.endsWith(".oc.app") ||
        hostname.endsWith(".localhost") ||
        hostname.endsWith(".local") ||
        ["icp0.io", "icp.net", "ic0.app"].includes(hostname) ||
        /(?:^|\.)raw\.(?:icp0\.io|icp\.net|ic0\.app)$/.test(hostname)
    ) {
        throw new Error(
            "Local APK RP must be an explicit non-loopback HTTPS hostname, not oc.app or an uncertified raw host",
        );
    }
    return hostname;
}

/** Only the matching, explicit parent APK profile may continue through Tauri/Rollup. */
export function localApkParentRpId(environment) {
    const rpId = parseLocalApkRpId(environment.OC_UNOFFICIAL_APK_RP_ID);
    if (
        environment.OC_UNOFFICIAL_LOCAL_APK !== "true" ||
        environment.OC_UNOFFICIAL_CLIENT !== "true" ||
        environment.OC_ANDROID_APPLICATION_ID !== UNOFFICIAL_LOCAL_APK_ID ||
        environment.OC_ANDROID_NATIVE_AUTH !== "android-credential-manager-v1" ||
        !/^[a-f0-9]{32}$/.test(environment.OC_UNOFFICIAL_APK_BUILD_ID ?? "") ||
        environment.OC_UNOFFICIAL_APK_RP_ID !== rpId ||
        environment.OC_ANDROID_RP_ID !== rpId ||
        environment.OC_WEBAUTHN_ORIGIN !== rpId
    ) {
        throw new Error("Local APK child requires a matching explicit parent RP profile");
    }
    return rpId;
}

export function createUnofficialLocalApkEnvironment(
    canisters,
    { inherited = {}, buildId, appDirectoryUrl, rpId: suppliedRpId } = {},
) {
    const rpId = parseLocalApkRpId(suppliedRpId);
    const id = buildId ?? randomBytes(16).toString("hex");
    if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id))
        throw new Error("Invalid local APK build identifier");
    return Object.freeze({
        ...createUnofficialLocalEnvironment(canisters, {
            inherited,
            layout: "v2",
            appDirectoryUrl,
        }),
        NODE_ENV: "production",
        OC_NODE_ENV: "development",
        OC_BUILD_ENV: "development",
        OC_UNOFFICIAL_LOCAL_APK: "true",
        OC_UNOFFICIAL_APK_BUILD_ID: id,
        OC_UNOFFICIAL_APK_RP_ID: rpId,
        OC_APP_TYPE: "android",
        OC_MOBILE_LAYOUT: "v2",
        OC_APP_STORE: "false",
        OC_BASE_ORIGIN: "http://tauri.localhost",
        OC_II_DERIVATION_ORIGIN: "",
        // The operator must separately publish this package/signer's association
        // at the selected host and qualify it with the actual credential provider.
        OC_WEBAUTHN_ORIGIN: rpId,
        OC_ANDROID_RP_ID: rpId,
        OC_ACCOUNT_LINKING_CODES_ENABLED: "true",
        OC_ANDROID_NATIVE_AUTH: "android-credential-manager-v1",
        OC_ANDROID_APPLICATION_ID: UNOFFICIAL_LOCAL_APK_ID,
        OC_ANDROID_VERSION_NAME: "0.0.1",
        OC_WEBSITE_VERSION: `2.0.0-localtest.${id}`,
        OC_OTA_UPDATES: "none",
        OC_ANDROID_OTA_UPDATES: "none",
        OC_ANDROID_REQUIRE_RELEASE_SIGNING: "false",
        OC_ANDROID_KEYSTORE_PATH: "",
        OC_ANDROID_KEYSTORE_PASSWORD: "",
        OC_ANDROID_KEY_ALIAS: "",
        OC_ANDROID_KEY_PASSWORD: "",
        OC_DEVTOOLS: "0",
        // Missing cached Rust packages are a clear stop, never an implicit new download.
        CARGO_NET_OFFLINE: "true",
    });
}

export function localApkBundleMarker(identityCanister, identityTargetHex, rpId) {
    if (
        typeof identityCanister !== "string" ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(identityCanister) ||
        typeof identityTargetHex !== "string" ||
        !/^(?:[0-9A-F]{2}){1,29}$/.test(identityTargetHex)
    ) {
        throw new Error("Local APK requires the checked-in official identity canister");
    }
    return Object.freeze({
        version: 1,
        applicationId: UNOFFICIAL_LOCAL_APK_ID,
        label: UNOFFICIAL_LOCAL_APK_LABEL,
        ota: "none",
        nativeAuthentication: "android-credential-manager-v1",
        androidRpId: parseLocalApkRpId(rpId),
        identityCanister,
        identityTargetHex,
    });
}
