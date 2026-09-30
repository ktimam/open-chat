import { randomBytes } from "node:crypto";
import { createUnofficialLocalEnvironment } from "./unofficialLocalProfile.mjs";

export const UNOFFICIAL_LOCAL_APK_ID = "dev.openchatfork.localtest";
export const UNOFFICIAL_LOCAL_APK_LABEL = "OpenChat Fork · Local Test";

export function createUnofficialLocalApkEnvironment(
    canisters,
    { inherited = {}, buildId, appDirectoryUrl } = {},
) {
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
        OC_APP_TYPE: "android",
        OC_MOBILE_LAYOUT: "v2",
        OC_APP_STORE: "false",
        OC_BASE_ORIGIN: "http://tauri.localhost",
        OC_II_DERIVATION_ORIGIN: "",
        // Restore OpenChat's original native RP identifier, not a claim that this
        // fork's package/signature is authorized by oc.app Digital Asset Links.
        // The selected provider must support the app's own package/signature trust.
        OC_WEBAUTHN_ORIGIN: "oc.app",
        OC_ANDROID_RP_ID: "oc.app",
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

export function localApkBundleMarker(identityCanister, identityTargetHex) {
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
        androidRpId: "oc.app",
        identityCanister,
        identityTargetHex,
    });
}
