import { beforeEach, describe, expect, it, vi } from "vitest";

// These specs pin the MANUAL-extraction gate: the manual path (no on-device runtime — the caller
// supplies the extraction) must run the SAME deterministic pass as the model path (rules post-pass +
// schema conformance + required-fields check) before a card is built. Previously it built the card
// straight from the caller-supplied object, so a degenerate value (e.g. amount 0 against a schema
// requiring amount > 0) posted a confirm card the consumer app then rejected as an invalid draft.

// aiActionRunner imports the on-device inference facade at module level; stub it so importing the
// module never touches the Tauri bridge (the manual path performs no inference at all).
vi.mock("./onDeviceInference", () => ({
    inferOnDevice: vi.fn(async () => ({ kind: "unavailable", reason: "not in tests" })),
}));

import type { AiActionDefinition } from "openchat-shared";
import { buildManualCard, manualExtractEnabled, imageUnsupportedReason} from "./aiActionRunner";

const RECIPIENT = "-----BEGIN PUBLIC KEY-----\nABC\n-----END PUBLIC KEY-----\n";

const DEF: AiActionDefinition = {
    name: "demo.expense.add",
    description: "Log expense",
    promptTemplate: "extract the transaction as JSON",
    responseSchema: {
        type: "object",
        properties: {
            kind: { type: "string", enum: ["expense", "settlement"] },
            amount: { type: "number", exclusiveMinimum: 0 },
            currency: { type: "string" },
        },
        required: ["amount"],
    },
    card: {
        title: "Log expense",
        rows: [
            { label: "Amount", valueKey: "amount" },
            { label: "Currency", valueKey: "currency" },
        ],
        confirmLabel: "Add",
        cancelLabel: "Dismiss",
    },
};

describe("buildManualCard (manual-extraction gate)", () => {
    it("gates a degenerate manual extraction (required amount 0) to no_extraction — no card", () => {
        const manual = { kind: "settlement", amount: 0, currency: "USD" };
        const r = buildManualCard(DEF, manual, RECIPIENT);
        expect(r.kind).toBe("no_extraction");
        if (r.kind === "no_extraction") {
            // raw carries the ORIGINAL manual extraction for the caller to surface/debug.
            expect(JSON.parse(r.raw)).toEqual(manual);
        }
    });

    it("builds a ready card from a valid manual extraction, post-passed like the model path", () => {
        const r = buildManualCard(
            DEF,
            { kind: "settlement", amount: 350, currency: "USD", extra: 1 },
            RECIPIENT,
        );
        expect(r.kind).toBe("ready");
        if (r.kind === "ready") {
            // Undeclared keys are dropped by the same conformance pass the model path runs.
            expect(r.extracted).toEqual({ kind: "settlement", amount: 350, currency: "USD" });
            expect(r.card.rows).toEqual([
                { label: "Amount", value: "350" },
                { label: "Currency", value: "USD" },
            ]);
            expect(r.card.recipientPublicKey).toBe(RECIPIENT);
        }
    });

    it("runs declared normalize rules over the manual extraction ('350 usd' -> 350)", () => {
        const def: AiActionDefinition = {
            ...DEF,
            rules: [{ kind: "normalize", field: "amount", ops: ["k_m_suffix"] }],
        };
        const r = buildManualCard(def, { amount: "350 usd" }, RECIPIENT);
        expect(r.kind).toBe("ready");
        if (r.kind === "ready") {
            expect(r.extracted.amount).toBe(350);
        }
    });

    it("no schema: the manual extraction passes through and builds a card", () => {
        const def: AiActionDefinition = { ...DEF, responseSchema: undefined };
        const r = buildManualCard(def, { amount: 0 }, RECIPIENT);
        expect(r.kind).toBe("ready");
    });

    it("threads the inbox + fan-out keys onto the card", () => {
        const r = buildManualCard(DEF, { amount: 5 }, RECIPIENT, "aaaaa-aa", ["OTHER_KEY_PEM"]);
        expect(r.kind).toBe("ready");
        if (r.kind === "ready") {
            expect(r.card.inboxCanisterId).toBe("aaaaa-aa");
            expect(r.card.recipientPublicKeys).toEqual(["OTHER_KEY_PEM"]);
        }
    });

    it("an ARRAY of two valid entries builds ONE multi card with an array confirmPayload", () => {
        const r = buildManualCard(
            DEF,
            [
                { kind: "expense", amount: 20, currency: "USD" },
                { kind: "expense", amount: 30, currency: "EUR" },
            ],
            RECIPIENT,
        );
        expect(r.kind).toBe("ready_multi");
        if (r.kind === "ready_multi") {
            expect(JSON.parse(new TextDecoder().decode(r.card.confirmPayload!))).toEqual([
                { kind: "expense", amount: 20, currency: "USD" },
                { kind: "expense", amount: 30, currency: "EUR" },
            ]);
            // One visible summary row per entry; the multi card also appends a hidden "__oc_" sentinel
            // row carrying the exact entry array to the app-rendered card, so filter it out here.
            expect(r.card.rows.filter((row) => !row.label.startsWith("__oc_")).length).toBe(2);
            expect(r.card.title).toContain("2");
        }
    });

    it("an ARRAY with one valid + one degenerate element drops the bad one → single OBJECT card", () => {
        const r = buildManualCard(
            DEF,
            [
                { kind: "expense", amount: 0, currency: "USD" },
                { kind: "expense", amount: 30, currency: "EUR" },
            ],
            RECIPIENT,
        );
        expect(r.kind).toBe("ready");
        if (r.kind === "ready") {
            const payload = JSON.parse(new TextDecoder().decode(r.card.confirmPayload!)) as unknown;
            expect(Array.isArray(payload)).toBe(false);
            expect(payload).toEqual({ kind: "expense", amount: 30, currency: "EUR" });
        }
    });

    it("an all-invalid ARRAY yields no_extraction — no card", () => {
        const arr = [
            { kind: "expense", amount: 0, currency: "USD" },
            { kind: "expense", currency: "EUR" },
        ];
        const r = buildManualCard(DEF, arr, RECIPIENT);
        expect(r.kind).toBe("no_extraction");
        if (r.kind === "no_extraction") {
            expect(JSON.parse(r.raw)).toEqual(arr);
        }
    });
});

describe("manualExtractEnabled", () => {
    beforeEach(() => {
        localStorage.clear();
        history.replaceState({}, "", "/");
    });
    it("is false when neither the flag nor the query param is set", () => {
        expect(manualExtractEnabled()).toBe(false);
    });
    it('is true when localStorage["oc:manualExtract"] === "1"', () => {
        localStorage.setItem("oc:manualExtract", "1");
        expect(manualExtractEnabled()).toBe(true);
    });
    it("is false for any other localStorage value", () => {
        localStorage.setItem("oc:manualExtract", "yes");
        expect(manualExtractEnabled()).toBe(false);
    });
    it("is true when the URL carries ?manualExtract=1", () => {
        history.replaceState({}, "", "/?manualExtract=1");
        expect(manualExtractEnabled()).toBe(true);
    });
});


// Proposing on an IMAGE used to do NOTHING in a browser: the bytes were shipped into a text-only
// runtime and the failure never surfaced. This gate is what turns that into an explanation, and it
// distinguishes the two fixes — switch CLIENT (browser) vs switch MODEL (native).
describe("imageUnsupportedReason", () => {
    it("allows an image when the selected model has the image modality", () => {
        expect(
            imageUnsupportedReason({ selectedModalities: ["text", "image"], selectedModelId: "gemma-4-e2b-it-q4" }, true),
        ).toBeUndefined();
    });

    it("blocks a browser text-only model and NAMES it (the message is about the model)", () => {
        const r = imageUnsupportedReason({ selectedModalities: ["text"], selectedModelId: "local.gguf" }, false);
        expect(r).toEqual({ kind: "image_unsupported", reason: "browser", modelId: "local.gguf" });
    });

    it("blocks a NATIVE client whose selected model is text-only, and names it", () => {
        const r = imageUnsupportedReason({ selectedModalities: ["text"], selectedModelId: "gemma-3-1b-it-q4" }, true);
        expect(r).toEqual({ kind: "image_unsupported", reason: "model", modelId: "gemma-3-1b-it-q4" });
    });

    it("blocks a native client with NO model selected (no modalities at all)", () => {
        const r = imageUnsupportedReason({ selectedModalities: [] }, true);
        expect(r).toEqual({ kind: "image_unsupported", reason: "model", modelId: undefined });
    });

    it("BROWSER vision is absent, not impossible: an image-capable browser model is allowed", () => {
        // webEligibleModels excludes the 2-FILE (mmproj) shape, not vision itself — a single-file
        // vision GGUF under the ~2 GB wasm32 ceiling already passes that filter. The day the browser
        // capability probe reports "image", this policy must let it through with no edit here.
        expect(
            imageUnsupportedReason({ selectedModalities: ["text", "image"], selectedModelId: "future-vlm.gguf" }, false),
        ).toBeUndefined();
    });

});
