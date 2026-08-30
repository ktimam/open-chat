import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const frontendRoot = resolve(appRoot, "..");

const assets = [
    [
        "node_modules/tesseract.js/dist/worker.min.js",
        "576b7df7e3393e137e51849357c9adb53fe7ac1bb69bfa06cf3d61520f182c6d",
    ],
    [
        "node_modules/tesseract.js/dist/worker.min.js.LICENSE.txt",
        "45f54171aeaa1d10c0c1a66f374b7bba1f02472b1487fbe892eec04f840002ac",
    ],
    [
        "node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js",
        "861a536cf9ef8e63cb644d57bab39c388f37f7d6b6f60024b741c5f6b39a59b3",
    ],
    [
        "node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js",
        "c58b46a4c796c0b8afccf77591d5b875b6896b45d402bbce8caa6f5362447b38",
    ],
    [
        "node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js",
        "eef5f8b2f8e20e150680b20adaec4a60babafee3adbe8a94583c81fee46e8680",
    ],
    [
        "node_modules/@tesseract.js-data/ara/4.0.0_best_int/ara.traineddata.gz",
        "f4746c44b02342dd5b3d4f0198000f47d7c49f1a229e63e0f436c0592dcd9639",
    ],
    [
        "node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz",
        "45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91",
    ],
] as const;

describe("browser OCR assets", () => {
    it("pins exact runtime and Arabic/English language bytes", () => {
        const packageJson = JSON.parse(
            readFileSync(resolve(frontendRoot, "package.json"), "utf8"),
        ) as { dependencies: Record<string, string> };
        expect(packageJson.dependencies["tesseract.js"]).toBe("7.0.0");
        expect(packageJson.dependencies["tesseract.js-core"]).toBe("7.0.0");
        expect(packageJson.dependencies["@tesseract.js-data/ara"]).toBe("1.0.0");
        expect(packageJson.dependencies["@tesseract.js-data/eng"]).toBe("1.0.0");

        for (const [relative, expected] of assets) {
            const bytes = readFileSync(resolve(frontendRoot, relative));
            expect(createHash("sha256").update(bytes).digest("hex"), relative).toBe(expected);
        }
    });

    it("serves and builds the same versioned same-origin paths", () => {
        const vite = readFileSync(resolve(appRoot, "vite.config.ts"), "utf8");
        const rollup = readFileSync(resolve(appRoot, "rollup.config.mjs"), "utf8");
        const runtime = readFileSync(resolve(appRoot, "src/utils/browserOcr.ts"), "utf8");

        for (const source of [vite, rollup, runtime]) {
            expect(source).toContain("assets/local-extractor/v7.0.0");
        }
        expect(vite).toContain("localExtractorAssetsPlugin()");
        expect(vite).toContain("worker.min.js.LICENSE.txt");
        expect(rollup).toContain("eng.traineddata.gz");
        expect(rollup).toContain("ara.traineddata.gz");
        expect(rollup).toContain("tesseract-core-relaxedsimd-lstm.wasm.js");
        expect(rollup).toContain("THIRD_PARTY_NOTICES.md");
        expect(rollup).toContain("ieee754-BSD-3-Clause.txt");
        expect(rollup).toContain("localExtractorCopyTargets");
        expect(runtime).toContain('cacheMethod: "write"');
        expect(runtime).toContain('BROWSER_OCR_LANGUAGES = "eng"');
        expect(runtime).toContain('BROWSER_OCR_SEMANTIC_LANGUAGES = "ara+eng"');
        expect(runtime).toContain("rotateAuto: true");
    });

    it("redistributes the exact package-declared licenses and attributions", () => {
        const declarations = [
            ["tesseract.js", "7.0.0", "Apache-2.0"],
            ["tesseract.js-core", "7.0.0", "Apache-2.0"],
            ["@tesseract.js-data/ara", "1.0.0", "MIT"],
            ["@tesseract.js-data/eng", "1.0.0", "MIT"],
        ] as const;
        const notices = readFileSync(
            resolve(frontendRoot, "src-tauri/THIRD_PARTY_NOTICES.md"),
            "utf8",
        );

        for (const [packageName, expectedVersion, expectedLicense] of declarations) {
            const metadata = JSON.parse(
                readFileSync(
                    resolve(frontendRoot, "node_modules", packageName, "package.json"),
                    "utf8",
                ),
            ) as { version: string; license: string };
            expect(metadata.version, packageName).toBe(expectedVersion);
            expect(metadata.license, packageName).toBe(expectedLicense);
            expect(notices).toContain(`\`${packageName}\``);
            expect(notices).toContain(expectedVersion);
            expect(notices).toContain(expectedLicense);
        }

        expect(notices).toContain("worker.min.js.LICENSE.txt");
        const ieee754Metadata = JSON.parse(
            readFileSync(resolve(frontendRoot, "node_modules/ieee754/package.json"), "utf8"),
        ) as { version: string; license: string };
        expect(ieee754Metadata).toMatchObject({ version: "1.2.1", license: "BSD-3-Clause" });
        const ieee754License = readFileSync(resolve(frontendRoot, "node_modules/ieee754/LICENSE"));
        expect(createHash("sha256").update(ieee754License).digest("hex")).toBe(
            "18d45466ba3253deae04667e267a91ea8de8548f18c1125264d1c9db28194cc1",
        );
        expect(notices).toContain("ieee754-BSD-3-Clause.txt");
        expect(notices).not.toContain("introduces no WebAssembly");
    });

    it("packages OCR only for web and explicit all-WebGPU Android bundles", () => {
        const rollup = readFileSync(resolve(appRoot, "rollup.config.mjs"), "utf8");
        const androidBundle = readFileSync(
            resolve(appRoot, "rollup-plugin-android-bundle.mjs"),
            "utf8",
        );

        expect(rollup).toContain(
            "!isNativeApp || (isNativeAndroid && transformersWebGpuSpikeEnabled)",
        );
        expect(rollup).toContain("const localExtractorCopyTargets = localExtractorEnabled");
        expect(rollup).toContain("includeLocalExtractor: transformersWebGpuSpikeEnabled");
        expect(androidBundle).toContain("includeLocalExtractor = false");
        expect(androidBundle).toContain("if (!includeLocalExtractor)");
        expect(androidBundle).toContain(
            'fs.remove(path.join(distBundleDir, "assets", "local-extractor"))',
        );
    });
});
