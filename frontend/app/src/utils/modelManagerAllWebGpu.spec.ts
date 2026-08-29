import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SURFACES = [
    "../components/home/profile/ModelManager.svelte",
    "../components_mobile/home/user_profile/ModelManager.svelte",
] as const;

describe("browser Model Manager all-WebGPU parity", () => {
    for (const [index, relative] of SURFACES.entries()) {
        it(`${relative} owns preload, cancellation, progress, settings, retry, and the curated allow-list`, () => {
            const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

            expect(source).toContain("TRANSFORMERS_WEBGPU_MODEL_SPECS");
            expect(source).toContain("transformersWebGpuSelectionCanHandle(spec.id)");
            expect(source).toContain("spec.artifactBytes");
            expect(source).toContain("useWebModelFromUrl");
            expect(source).toContain("cancelWebModelDownload");
            expect(source).toContain("Cancel download");
            expect(source).toContain("Retry download");
            expect(source).toContain("webChoiceGeneration");
            expect(source).toContain('$webModelStatus.status === "downloading"');
            expect(source).toContain('$webModelStatus.status === "verifying"');
            expect(source).toContain("$webModelStatus.progress.received");
            expect(source).toContain("<WebInferenceRuntimeSettings");
            expect(source).toContain("voice add-on optional");
            expect(source).toContain(`context="${index === 0 ? "desktop" : "phone"}"`);
            expect(source).toContain("const nativeClient = isNativeClient();");
            expect(source).toMatch(
                /\{#if !nativeClient\}\s*<BrowserImageActionModeSettings \/>\s*\{\/if\}/,
            );
            expect(source).toContain("cancelWebModelDownload();");
            expect(source).not.toContain("webEligibleModels(");
            expect(source).not.toContain('accept=".gguf"');
            expect(source).not.toContain("pickWebModelFromDisk");
            expect(source).not.toContain("setWebModelFile");
        });
    }

    it("forces the native all-WebGPU route to model-only even with a stale OCR preference", () => {
        const relative = "../utils/aiActionRunner.ts";
        const source = readFileSync(
            fileURLToPath(new URL(relative, import.meta.url)),
            "utf8",
        );

        expect(source).toContain(
            "const browserLocalReaderModesAllowed = webInference && !isNativeClient();",
        );
        expect(source).toMatch(
            /webInference\s*&&\s*input\.image !== undefined\s*&&\s*\(!browserLocalReaderModesAllowed \|\| browserUsesModelOnly\(\)\)/,
        );
    });

    it("keeps Gemma voice support as a separately managed optional add-on", () => {
        const source = readFileSync(
            resolve(
                dirname(fileURLToPath(import.meta.url)),
                "../components_shared/WebInferenceRuntimeSettings.svelte",
            ),
            "utf8",
        );

        expect(source).toContain("Voice-message support (optional)");
        expect(source).toContain("Gemma text and image inference works without it.");
        expect(source).toContain("preloadTransformersWebGpuAudio(modelId");
        expect(source).toContain("transformersWebGpuAudioDownloaded(modelId)");
        expect(source).toContain("deleteTransformersWebGpuAudio(modelId)");
        expect(source).toContain("Install voice support");
        expect(source).toContain("Remove voice support");
    });
});
