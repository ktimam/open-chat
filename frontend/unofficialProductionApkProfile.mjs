import { createUnofficialLocalApkEnvironment, localApkBundleMarker } from "./unofficialLocalApkProfile.mjs";

// This release owns only these independent services; all chat canisters remain upstream.
export const PRIVATE_APK_ID = "io.github.ktimam.openchatprivate";
export const PRIVATE_APK_LABEL = "OpenChat Private";
export const PRIVATE_APK_VERSION = "0.1.0";
export const PRIVATE_APK_RP_ID = "o2xzk-ayaaa-aaaag-azelq-cai.icp0.io";
export const PRIVATE_APP_DIRECTORY = "https://o5w76-naaaa-aaaag-azela-cai.icp0.io/apps-v2.json";
export const PRIVATE_SIGNING_KEYS = Object.freeze([
    "OC_ANDROID_KEYSTORE_PATH", "OC_ANDROID_KEYSTORE_PASSWORD",
    "OC_ANDROID_KEY_ALIAS", "OC_ANDROID_KEY_PASSWORD",
]);

/** Secrets stay in the build process environment, never in generated frontend assets. */
export function productionApkSigning(environment) {
    const signing = {};
    for (const name of PRIVATE_SIGNING_KEYS) {
        if (typeof environment[name] !== "string" || environment[name].trim() === "")
            throw new Error(`OpenChat Private requires ${name}; debug signing is not permitted`);
        signing[name] = environment[name];
    }
    return signing;
}

export function createUnofficialProductionApkEnvironment(canisters, { inherited = {}, buildId } = {}) {
    const base = createUnofficialLocalApkEnvironment(canisters, {
        inherited, buildId, rpId: PRIVATE_APK_RP_ID, appDirectoryUrl: PRIVATE_APP_DIRECTORY,
    });
    return Object.freeze({
        ...base,
        ...productionApkSigning(inherited),
        OC_UNOFFICIAL_LOCAL_APK: "false",
        OC_UNOFFICIAL_PRODUCTION_APK: "true",
        OC_BUILD_ENV: "production",
        OC_NODE_ENV: "production",
        OC_ANDROID_APPLICATION_ID: PRIVATE_APK_ID,
        OC_ANDROID_VERSION_NAME: PRIVATE_APK_VERSION,
        OC_WEBSITE_VERSION: `${PRIVATE_APK_VERSION}-private.${base.OC_UNOFFICIAL_APK_BUILD_ID}`,
        OC_ANDROID_REQUIRE_RELEASE_SIGNING: "true",
        OC_DEV_PORT: "",
    });
}

/** A child cannot substitute an official/local package, destination, version or debug signer. */
export function productionApkParentRpId(environment) {
    const expected = {
        OC_UNOFFICIAL_PRODUCTION_APK: "true", OC_UNOFFICIAL_LOCAL_APK: "false",
        OC_UNOFFICIAL_CLIENT: "true", OC_ANDROID_APPLICATION_ID: PRIVATE_APK_ID,
        OC_ANDROID_VERSION_NAME: PRIVATE_APK_VERSION,
        OC_UNOFFICIAL_APK_RP_ID: PRIVATE_APK_RP_ID, OC_ANDROID_RP_ID: PRIVATE_APK_RP_ID,
        OC_WEBAUTHN_ORIGIN: PRIVATE_APK_RP_ID, OC_APP_DIRECTORY_URL: PRIVATE_APP_DIRECTORY,
        OC_ANDROID_NATIVE_AUTH: "android-credential-manager-v1",
        OC_ANDROID_REQUIRE_RELEASE_SIGNING: "true", OC_OTA_UPDATES: "none",
        OC_ANDROID_OTA_UPDATES: "none", OC_BUILD_ENV: "production", OC_NODE_ENV: "production",
        OC_DFX_NETWORK: "ic",
    };
    if (Object.entries(expected).some(([key, value]) => environment[key] !== value) ||
        !/^[a-f0-9]{32}$/.test(environment.OC_UNOFFICIAL_APK_BUILD_ID ?? "") ||
        environment.OC_UNOFFICIAL_WEB_BUILD === "true") {
        throw new Error("OpenChat Private child requires the complete production parent profile");
    }
    productionApkSigning(environment);
    return PRIVATE_APK_RP_ID;
}

export function productionApkBundleMarker(identityCanister, identityTargetHex) {
    return Object.freeze({
        ...localApkBundleMarker(identityCanister, identityTargetHex, PRIVATE_APK_RP_ID),
        applicationId: PRIVATE_APK_ID, label: PRIVATE_APK_LABEL,
        releaseVersion: PRIVATE_APK_VERSION, appDirectoryUrl: PRIVATE_APP_DIRECTORY,
    });
}
