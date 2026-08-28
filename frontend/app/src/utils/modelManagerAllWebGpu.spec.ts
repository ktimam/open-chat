import { readFileSync } from "node:fs";
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

            expect(source).toContain("allWebGpuCatalogModelSupported(entry.id)");
            expect(source).toContain("useWebModelFromUrl");
            expect(source).toContain("cancelWebModelDownload");
            expect(source).toContain("Cancel download");
            expect(source).toContain("Retry download");
            expect(source).toContain("webChoiceGeneration");
            expect(source).toContain('$webModelStatus.status === "downloading"');
            expect(source).toContain('$webModelStatus.status === "verifying"');
            expect(source).toContain("$webModelStatus.progress.received");
            expect(source).toContain("<WebInferenceRuntimeSettings");
            expect(source).toContain(`context="${index === 0 ? "desktop" : "phone"}"`);
            expect(source).toContain("cancelWebModelDownload();");
            expect(source).not.toContain("webEligibleModels(");
            expect(source).not.toContain('accept=".gguf"');
            expect(source).not.toContain("pickWebModelFromDisk");
            expect(source).not.toContain("setWebModelFile");
        });
    }
});
