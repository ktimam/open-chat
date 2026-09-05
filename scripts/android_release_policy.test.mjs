import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
    assertSigningConfigured,
    nativeVersion,
    releasePolicy,
    signingFingerprint,
    tauriVersionConfig,
    verifyApkMetadata,
} from "./android_release_policy.mjs";

const certificate = "ab".repeat(32);
const signing = {
    ANDROID_KEYSTORE_BASE64: "fixture-not-a-key",
    ANDROID_KEYSTORE_PASSWORD: "fixture-placeholder",
    ANDROID_KEY_ALIAS: "fixture-alias",
    ANDROID_KEY_PASSWORD: "fixture-placeholder",
    ANDROID_RELEASE_CERT_SHA256: certificate,
};

for (const tag of ["model-integration-checkpoint-2026-09-05", "v2.4.6-website", "v2.4.6", "android", "v2.4.6-android-extra"]) {
    test(`non-Android release is ineligible: ${tag}`, () => {
        assert.deepEqual(releasePolicy({ eventName: "release", tag }), { eligible: false });
    });
}

test("only explicit Android stable release tags produce build outputs", () => {
    assert.deepEqual(releasePolicy({ eventName: "release", tag: "v2.4.6-android", releaseVersionCode: "2004006" }), {
        eligible: true, version: "2.4.6", versionCode: 2_004_006,
    });
});

for (const tag of ["2.4.6-android", "v02.4.6-android", "v2.4.6-rc1-android", "v2.4.6+meta-android", "v2.4.6\nnext=value-android"]) {
    test(`invalid Android tag fails closed: ${JSON.stringify(tag)}`, () => {
        assert.throws(() => releasePolicy({ eventName: "release", tag, releaseVersionCode: "2004006" }));
    });
}

test("manual build requires an explicit native-compatible version", () => {
    assert.deepEqual(releasePolicy({ eventName: "workflow_dispatch", manualVersion: "2.4.6", manualVersionCode: "2004006" }), {
        eligible: true, version: "2.4.6", versionCode: 2_004_006,
    });
    assert.throws(() => releasePolicy({ eventName: "workflow_dispatch" }));
    assert.deepEqual(releasePolicy({ eventName: "push", tag: "v2.4.6-android" }), { eligible: false });
});

for (const version of ["999999999999999999999.0.0", "1.2", "1.2.3 ", "v1.2.3", "1.2.3\n", "1.2.3\nnext=value"]) {
    test(`invalid native version is rejected: ${JSON.stringify(version)}`, () => {
        assert.throws(() => nativeVersion(version, "2004006"));
    });
}

test("explicit version codes support existing Android patch numbering without a guessed mapping", () => {
    for (const version of ["2.0.2040", "2.0.2047", "2.0.2050"]) {
        assert.deepEqual(releasePolicy({ eventName: "release", tag: `v${version}-android`, releaseVersionCode: "42001" }), {
            eligible: true, version, versionCode: 42001,
        });
        assert.equal(tauriVersionConfig(version, "42001").bundle.android.versionCode, 42001);
    }
    assert.equal(nativeVersion("2.0.2050", "1").versionCode, 1);
    assert.equal(nativeVersion("2.0.2050", "2100000000").versionCode, 2_100_000_000);
    assert.deepEqual(tauriVersionConfig("2.4.6", "2004006"), {
        version: "2.4.6",
        bundle: { android: { versionCode: 2_004_006, autoIncrementVersionCode: false } },
    });
});

for (const code of [undefined, "", "0", "-1", "1.5", "1e6", "01", "2100000001", "999999999999999999999", "42001\n"]) {
    test(`invalid or missing explicit native code fails closed: ${JSON.stringify(code)}`, () => {
        assert.throws(() => nativeVersion("2.0.2050", code));
        assert.throws(() => releasePolicy({ eventName: "release", tag: "v2.0.2050-android", releaseVersionCode: code }));
        assert.throws(() => releasePolicy({ eventName: "workflow_dispatch", manualVersion: "2.0.2050", manualVersionCode: code }));
    });
}

test("complete signing configuration is required without exposing values", () => {
    assert.doesNotThrow(() => assertSigningConfigured(signing));
    for (const name of Object.keys(signing)) {
        for (const absent of [undefined, "", " "]) {
            assert.throws(() => assertSigningConfigured({ ...signing, [name]: absent }), (error) => {
                assert.doesNotMatch(error.message, /fixture-placeholder|fixture-not-a-key/u);
                return true;
            });
        }
    }
    assert.equal(signingFingerprint("AB:".repeat(31) + "AB"), certificate);
    assert.throws(() => signingFingerprint("not-approved"));
    assert.throws(() => signingFingerprint(certificate + "\n"));
});

const apk = {
    badging: "package: name='com.oc.app' versionCode='2004006' versionName='2.4.6' platformBuildVersionName='36'\n",
    certificates: `Verifies\nSigner #1 certificate SHA-256 digest: ${certificate}\n`,
    version: "2.4.6",
    versionCode: "2004006",
    certificateSha256: certificate,
};

test("artifact must match both native version and approved signing identity", () => {
    assert.doesNotThrow(() => verifyApkMetadata(apk));
    assert.doesNotThrow(() => verifyApkMetadata({ ...apk, certificates: apk.certificates.replaceAll("\n", "\r\n") }));
    for (const [before, after] of [["com.oc.app", "other.app"], ["2004006", "1"], ["2.4.6", "0.1.0"]]) {
        assert.throws(() => verifyApkMetadata({ ...apk, badging: apk.badging.replace(before, after) }));
    }
    assert.throws(() => verifyApkMetadata({ ...apk, certificates: "" }));
    assert.throws(() => verifyApkMetadata({ ...apk, certificateSha256: "cd".repeat(32) }));
    assert.throws(() => verifyApkMetadata({ ...apk, certificates: apk.certificates + `Signer #2 certificate SHA-256 digest: ${certificate}\n` }));
});

test("workflow gates every build/upload behind the policy and verifies both artifacts", () => {
    const workflow = readFileSync(new URL("../.github/workflows/android_release.yaml", import.meta.url), "utf8");
    assert.match(workflow, /build-android:\s+needs: release-policy\s+if: needs\.release-policy\.outputs\.eligible == 'true'/u);
    assert.match(workflow, /node --test scripts\/android_release_policy\.test\.mjs/u);
    assert.match(workflow, /ANDROID_REQUIRE_RELEASE_SIGNING: "true"/u);
    assert.match(workflow, /node \.\.\/scripts\/android_release_policy\.mjs signing/u);
    assert.doesNotMatch(workflow, /keytool -genkey|debug\.keystore|manual-build-\$/u);
    assert.equal((workflow.match(/--config "\$ANDROID_TAURI_RELEASE_CONFIG"/gu) ?? []).length, 2);
    assert.equal((workflow.match(/android_release_policy\.mjs verify-apk/gu) ?? []).length, 2);
    assert.ok(workflow.indexOf("verify-apk \"./openchat_${VERSION}_store.apk\"") < workflow.indexOf("- name: Upload APKs"));
    assert.match(workflow, /- name: Upload APKs to Release\s+if: github\.event_name == 'release'/u);
    assert.doesNotMatch(workflow, /--features[^\n]*transformers-webgpu-android|OC_TRANSFORMERS_WEBGPU_ENABLED/u);
});

test("Gradle requires configured release signing when CI requests it", () => {
    const gradle = readFileSync(new URL("../frontend/src-tauri/gen/android/app/build.gradle.kts", import.meta.url), "utf8");
    assert.match(gradle, /require\(!requireReleaseSigning \|\| hasReleaseSigning\)/u);
    assert.match(gradle, /getByName\(if \(hasReleaseSigning\) "configuredRelease" else "debugRelease"\)/u);
    for (const name of ["ANDROID_KEY_STORE_FILE", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD"]) {
        assert.ok(gradle.includes(`"${name}"`));
    }
});
