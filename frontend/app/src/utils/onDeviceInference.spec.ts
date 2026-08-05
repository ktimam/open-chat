import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { onDeviceInferenceCapability } from "./onDeviceInference";
import { clearWebModel, useWebModelFromUrl, webInfer } from "./webInference";

// The browser half of the capability probe. `imageUnsupportedReason` (aiActionRunner) reads NOTHING
// but `selectedModalities`, so what this function reports is exactly what decides whether proposing
// on an image is offered at all. It used to be hardcoded to ["text"] in the browser branch, which is
// what made browser vision look like a platform limit rather than a line of our own code.

const wl = vi.hoisted(() => ({ imageSupported: true }));

vi.mock("@wllama/wllama", () => {
    class Wllama {
        async loadModel() {}
        supportInputModality(modality: string): boolean {
            return modality === "image" ? wl.imageSupported : false;
        }
        async createChatCompletion() {
            return { choices: [{ message: { content: "ok" } }] };
        }
        async exit() {}
    }
    class ModelManager {
        async getModelOrDownload(source: { url: string; mmprojUrl?: string }) {
            const urls = [
                source.url,
                ...(source.mmprojUrl === undefined ? [] : [source.mmprojUrl]),
            ];
            const bytes = [
                new Uint8Array([1, 2, 3, 4]),
                ...(source.mmprojUrl === undefined ? [] : [new Uint8Array([5, 6, 7])]),
            ];
            return {
                files: urls.map((url) => ({ metadata: { originalURL: url } })),
                open: async () =>
                    bytes.map((value) => ({
                        arrayBuffer: async () => value.slice().buffer as ArrayBuffer,
                    })),
                remove: async () => {},
                source,
            };
        }
    }
    return { Wllama, ModelManager };
});

// No Tauri bridge in a browser build; the plugin is imported for its types + native calls only.
vi.mock("tauri-plugin-oc-api", () => ({
    infer: vi.fn(),
    listLocalModels: vi.fn(async () => []),
}));

const WEIGHTS_URL = "https://host/models/smolvlm.gguf";
const PROJ_URL = "https://host/models/mmproj-smolvlm.gguf";
const WEIGHTS_SHA = "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a";
const PROJ_SHA = "3774fed6f81e6d77fb664109f8ac3e35088e89722c6c8747166afe631cfcf43a";

vi.stubGlobal("crypto", webcrypto);
if (Blob.prototype.arrayBuffer === undefined) {
    Blob.prototype.arrayBuffer = function (this: Blob): Promise<ArrayBuffer> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as ArrayBuffer);
            reader.onerror = () => reject(reader.error);
            reader.readAsArrayBuffer(this);
        });
    };
}

function attachVision(modalities: ("text" | "image")[]) {
    return useWebModelFromUrl({
        id: "smolvlm-256m-instruct-q8",
        name: "SmolVLM 256M (vision)",
        files: [
            { url: WEIGHTS_URL, sha256: WEIGHTS_SHA, bytes: 4 },
            { url: PROJ_URL, sha256: PROJ_SHA, bytes: 3 },
        ],
        sizeBytes: 7,
        modalities,
    });
}

describe("onDeviceInferenceCapability in a BROWSER", () => {
    beforeEach(async () => {
        await clearWebModel();
        localStorage.clear();
        wl.imageSupported = true;
    });

    it("reports unavailable with no model attached — unchanged", () => {
        const cap = onDeviceInferenceCapability();
        expect(cap.available).toBe(false);
        expect(cap.selectedModalities).toEqual([]);
    });

    it("reports IMAGE for an attached vision model, which is what unblocks propose-on-an-image", async () => {
        await attachVision(["text", "image"]);
        const cap = onDeviceInferenceCapability();
        expect(cap.available).toBe(true);
        expect(cap.selectedModalities).toEqual(["text", "image"]);
        expect(cap.selectedModelId).toBe("SmolVLM 256M (vision)");
    });

    it("still reports text-only for a text model — the fix is not a blanket 'yes'", async () => {
        await useWebModelFromUrl({
            id: "qwen2.5-0.5b-instruct-q4",
            name: "Qwen2.5 0.5B (instruct)",
            files: [{ url: "https://host/models/qwen.gguf", sha256: WEIGHTS_SHA, bytes: 4 }],
            sizeBytes: 4,
            modalities: ["text"],
        });
        expect(onDeviceInferenceCapability().selectedModalities).toEqual(["text"]);
    });

    it("once loaded, the model's own answer supersedes the catalog's claim", async () => {
        wl.imageSupported = false; // the entry claims vision; the weights disagree
        await attachVision(["text", "image"]);
        expect(onDeviceInferenceCapability().selectedModalities).toEqual(["text", "image"]);
        await webInfer({ prompt: "hi" }); // first inference loads and measures
        expect(onDeviceInferenceCapability().selectedModalities).toEqual(["text"]);
    });
});
