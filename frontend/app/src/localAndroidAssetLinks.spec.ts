import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    localAndroidAssetLinksDocument,
    resolveLocalAndroidAssetLinksConfig,
} from "../localAndroidAssetLinks";

describe("local Android passkey association", () => {
    it("is absent unless explicitly configured", () => {
        expect(resolveLocalAndroidAssetLinksConfig({})).toBeUndefined();
    });

    it("normalizes a configured certificate without embedding a host identity", () => {
        const config = resolveLocalAndroidAssetLinksConfig({
            OC_ANDROID_LINK_PACKAGE: "com.example.local",
            OC_ANDROID_LINK_CERT_SHA256: "aa".repeat(32),
        });
        expect(config).toEqual({
            packageName: "com.example.local",
            certificateSha256: Array(32).fill("AA").join(":"),
        });
        expect(JSON.parse(localAndroidAssetLinksDocument(config!))).toEqual([
            {
                relation: [
                    "delegate_permission/common.get_login_creds",
                    "delegate_permission/common.handle_all_urls",
                ],
                target: {
                    namespace: "android_app",
                    package_name: "com.example.local",
                    sha256_cert_fingerprints: [Array(32).fill("AA").join(":")],
                },
            },
        ]);
    });

    it("rejects partial or malformed association settings", () => {
        expect(() =>
            resolveLocalAndroidAssetLinksConfig({ OC_ANDROID_LINK_PACKAGE: "com.example.local" }),
        ).toThrow(/CERT_SHA256/);
        expect(() =>
            resolveLocalAndroidAssetLinksConfig({
                OC_ANDROID_LINK_PACKAGE: "bad package",
                OC_ANDROID_LINK_CERT_SHA256: "aa".repeat(32),
            }),
        ).toThrow(/package name/);
        expect(() =>
            resolveLocalAndroidAssetLinksConfig({
                OC_ANDROID_LINK_PACKAGE: "com.example.local",
                OC_ANDROID_LINK_CERT_SHA256: "not-a-fingerprint",
            }),
        ).toThrow(/SHA-256/);
    });

    it("binds the native RP-ID and stored WebAuthn origin to the build setting", () => {
        const frontend = resolve(import.meta.dirname, "../..");
        const app = resolve(frontend, "app");
        const kotlin = readFileSync(
            resolve(
                frontend,
                "tauri-plugin-oc/android/src/main/java/commands/PasskeyAuth.kt",
            ),
            "utf8",
        );
        const gradle = readFileSync(
            resolve(frontend, "src-tauri/gen/android/app/build.gradle.kts"),
            "utf8",
        );
        const manifest = readFileSync(
            resolve(frontend, "src-tauri/gen/android/app/src/main/AndroidManifest.xml"),
            "utf8",
        );
        const webAuthn = readFileSync(
            resolve(frontend, "openchat-client/src/utils/androidWebAuthn.ts"),
            "utf8",
        );
        const rollup = readFileSync(resolve(app, "rollup.config.mjs"), "utf8");

        expect(kotlin).toContain('"openchat_rp_id"');
        expect(kotlin).not.toContain('const val RP_ID = "oc.app"');
        expect(gradle).toContain('System.getenv("OC_ANDROID_RP_ID")');
        expect(gradle).toContain('app/build/android-rp-id');
        expect(gradle).toContain("environmentOpenChatRpId == bundledOpenChatRpId");
        expect(gradle).toContain('resValue("string", "openchat_rp_id", openChatRpId)');
        expect(manifest).toContain('android:name="asset_statements"');
        expect(webAuthn).toContain('import.meta.env.OC_ANDROID_RP_ID ?? "oc.app"');
        expect(rollup).toContain(
            '"import.meta.env.OC_ANDROID_RP_ID": JSON.stringify(androidRpId)',
        );
        expect(rollup).toContain('fs.writeFileSync("build/android-rp-id", androidRpId)');
    });
});
