import type { ModelCatalogEntry } from "openchat-shared";
import { describe, expect, it } from "vitest";
import { defaultModelCatalog, mergeCatalogs, webEligibleModels } from "./modelCatalog";

// These specs pin the catalog-merge contract the browser chooser relies on: the remote (on-chain)
// catalog is a per-id OVERLAY on the built-in default, never a wholesale replacement — so a stale or
// partial remote catalog can never shrink the chooser below the builtin floor. They also pin the
// browser-eligibility filter (single GGUF ≤ 2 GB) that both ModelManager trees share.

const TWO_GB = 2_147_483_648;

const BUILTIN_IDS = defaultModelCatalog.models.map((m) => m.id);
const BUILTIN_WEB_IDS = ["gemma-3-1b-it-q4", "qwen2.5-1.5b-instruct-q4", "qwen2.5-0.5b-instruct-q4"];

function entry(id: string, overrides: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
    return {
        id,
        name: id,
        modalities: ["text"],
        runtime: "llama-cpp",
        files: [{ url: `https://host/models/${id}.gguf`, sha256: "00", bytes: 1_000_000 }],
        license: "Apache 2.0",
        sizeBytes: 1_000_000,
        ...overrides,
    };
}

// A large 2-file (model + mmproj) entry, like the original gemma-4-e2b catalog entry — native-only.
function nativeOnlyEntry(id: string): ModelCatalogEntry {
    return entry(id, {
        modalities: ["text", "image"],
        files: [
            { url: `https://host/models/${id}.gguf`, sha256: "00", bytes: 3_106_736_256 },
            { url: `https://host/models/${id}-mmproj.gguf`, sha256: "01", bytes: 985_654_080 },
        ],
        sizeBytes: 4_092_390_336,
    });
}

describe("mergeCatalogs", () => {
    it("empty remote returns the builtin catalog unchanged, in builtin order (Gemma 3 1B first)", () => {
        const merged = mergeCatalogs([], defaultModelCatalog.models);
        expect(merged).toEqual(defaultModelCatalog.models);
        expect(merged[0].id).toBe("gemma-3-1b-it-q4");
    });

    it("a stale remote seeded with only the old gemma-4-e2b entry cannot shrink the chooser", () => {
        // The literal collapse scenario: an operator seeds ONLY the old 2-file 4.09 GB entry.
        const remote = [nativeOnlyEntry("gemma-4-e2b")];
        const merged = mergeCatalogs(remote, defaultModelCatalog.models);
        expect(merged.map((m) => m.id)).toEqual(["gemma-4-e2b", ...BUILTIN_IDS]);
        // The browser chooser still offers the 3 builtin browser-capable models.
        expect(webEligibleModels(merged).map((m) => m.id)).toEqual(BUILTIN_WEB_IDS);
    });

    it("remote wins per-id: a same-id remote entry overrides the builtin without duplicating it", () => {
        const pinned = entry("gemma-3-1b-it-q4", {
            name: "Gemma 3 1B (pinned)",
            files: [{ url: "https://cdn.example/gemma-pinned.gguf", sha256: "ff", bytes: 806_058_240 }],
            sizeBytes: 806_058_240,
        });
        const merged = mergeCatalogs([pinned], defaultModelCatalog.models);
        expect(merged.length).toBe(defaultModelCatalog.models.length);
        const ids = merged.map((m) => m.id);
        expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
        expect(merged[0].name).toBe("Gemma 3 1B (pinned)"); // remote version, ranked first
        expect(merged[0].files[0].url).toBe("https://cdn.example/gemma-pinned.gguf");
        // Every builtin id is still present.
        for (const id of BUILTIN_IDS) {
            expect(ids).toContain(id);
        }
    });

    it("remote entries rank first, in remote order; builtin leftovers keep builtin order", () => {
        const merged = mergeCatalogs(
            [entry("z-new"), entry("a-new")],
            defaultModelCatalog.models,
        );
        expect(merged.map((m) => m.id)).toEqual(["z-new", "a-new", ...BUILTIN_IDS]);
    });

    it("duplicate ids within remote keep the first occurrence", () => {
        const merged = mergeCatalogs(
            [entry("dup", { name: "first" }), entry("dup", { name: "second" })],
            [],
        );
        expect(merged.length).toBe(1);
        expect(merged[0].name).toBe("first");
    });
});

describe("webEligibleModels", () => {
    it("includes a single-file model at exactly 2 GB and excludes one a byte over", () => {
        const atLimit = entry("at-limit", {
            files: [{ url: "https://host/a.gguf", sha256: "00", bytes: TWO_GB }],
            sizeBytes: TWO_GB,
        });
        const overLimit = entry("over-limit", {
            files: [{ url: "https://host/b.gguf", sha256: "00", bytes: TWO_GB + 1 }],
            sizeBytes: TWO_GB + 1,
        });
        expect(webEligibleModels([atLimit, overLimit]).map((m) => m.id)).toEqual(["at-limit"]);
    });

    it("excludes a 2-file entry regardless of size (mmproj vision path is native-only)", () => {
        const small2File = entry("small-multimodal", {
            files: [
                { url: "https://host/m.gguf", sha256: "00", bytes: 400_000_000 },
                { url: "https://host/mmproj.gguf", sha256: "01", bytes: 100_000_000 },
            ],
            sizeBytes: 500_000_000,
        });
        expect(webEligibleModels([small2File])).toEqual([]);
    });

    it("a remote seeded with only native-size multi-file models still leaves all 3 builtin browser models", () => {
        // Worse than the report: remote would yield ZERO browser choices on its own.
        const remote = [nativeOnlyEntry("big-a"), nativeOnlyEntry("big-b")];
        const merged = mergeCatalogs(remote, defaultModelCatalog.models);
        expect(webEligibleModels(merged).map((m) => m.id)).toEqual(BUILTIN_WEB_IDS);
    });
});
