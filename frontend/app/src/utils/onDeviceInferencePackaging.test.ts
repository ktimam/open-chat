import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = resolve(__dirname, "../../../..");

function source(path: string): string {
    return readFileSync(resolve(REPOSITORY_ROOT, path), "utf8");
}

function workflowStep(workflow: string, name: string): string {
    const start = workflow.indexOf(`- name: ${name}`);
    expect(start, `workflow step ${name}`).toBeGreaterThanOrEqual(0);
    const next = workflow.indexOf("\n            - name:", start + 1);
    return workflow.slice(start, next === -1 ? undefined : next);
}

describe("on-device inference packaging", () => {
    it("builds both Android release variants with the inference runtime", () => {
        const workflow = source(".github/workflows/android_release.yaml");
        const full = workflowStep(workflow, "Build Android APK (Full)");
        const store = workflowStep(workflow, "Build Android APK (Store)");

        expect(full).toMatch(/cargo tauri android build[^\n]*--features inference(?:\s|$)/);
        expect(store).toMatch(
            /cargo tauri android build[^\n]*--features (?:inference,store|store,inference)(?:\s|$)/,
        );
    });

    it("compiles the actual app crate with both shipping feature sets in CI", () => {
        const workflow = source(".github/workflows/on_device_model_security.yaml");

        expect(workflow).toMatch(/cargo check -p open-chat --features inference(?:\s|$)/);
        expect(workflow).toMatch(
            /cargo check -p open-chat --features (?:inference,store|store,inference)(?:\s|$)/,
        );
    });

    it("runs the packaging contract through the repository's real frontend test command", () => {
        const workflow = source(".github/workflows/on_device_model_security.yaml");
        const contracts = workflowStep(workflow, "Run all local-model frontend contracts");

        expect(contracts).toContain("npm test --");
        expect(contracts).toContain("app/src/utils/onDeviceInferencePackaging.test.ts");
        expect(contracts).not.toContain("npm --workspace app");
    });

    it("forwards the app inference feature to the native plugin", () => {
        const manifest = source("frontend/src-tauri/Cargo.toml");

        expect(manifest).toMatch(/inference\s*=\s*\["tauri-plugin-oc\/inference"\]/);
    });
});
