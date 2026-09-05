import { MAX_PRIVATE_IMAGE_EVIDENCE_BYTES, type AiActionRule } from "@shared";
import { describe, expect, it, vi } from "vitest";
import {
    extractLocalAction,
    extractLocalActionForPrivateVerification,
    localActionExtractorSupports,
    localImageEvidenceExtractorSupports,
} from "./localActionExtractor";

const verifierPrompt =
    "Read the app's instrument fields from PRIMARY={{PRIMARY_IMAGE_EVIDENCE_JSON}}\n" +
    "Semantic hints={{SEMANTIC_IMAGE_VALUES_JSON}}";

const measurementSchema = {
    type: "object",
    "x-openchat-private-image-verifier": {
        version: 2,
        promptTemplate: verifierPrompt,
        requiredFields: ["reading", "unit_code", "classification"],
        optionalFields: ["observed_on"],
        semanticFields: ["classification"],
        ocrProfiles: ["eng", "ara+eng"],
    },
    properties: {
        reading: { type: "number" },
        unit_code: { type: "string" },
        classification: { enum: ["nominal", "warning"] },
        observed_on: { type: "string" },
    },
    required: ["reading", "unit_code", "classification"],
};

const noRules: AiActionRule[] = [];

describe("generic local image evidence", () => {
    it("is enabled by the app verifier alone and does not enable the legacy typed parser", () => {
        expect(localImageEvidenceExtractorSupports(measurementSchema)).toBe(true);
        expect(localActionExtractorSupports(measurementSchema)).toBe(false);
    });

    it("collects only app-selected profiles, labels them neutrally, and disposes before returning", async () => {
        const events: string[] = [];
        const recognizeImage = vi.fn(async (_image: Uint8Array, profile: string) => {
            events.push(`read:${profile}`);
            return {
                kind: "ok" as const,
                confidence: 90,
                text:
                    profile === "eng"
                        ? "METER 42 ZX\nOBSERVED 2026-09-04"
                        : "العداد ٤٢\nNOMINAL",
            };
        });
        const disposeOcr = vi.fn(async () => {
            events.push("dispose");
        });

        const result = await extractLocalActionForPrivateVerification(
            measurementSchema,
            noRules,
            { image: new Uint8Array([1, 2, 3]) },
            {
                imageDimensions: { width: 640, height: 480 },
                prepareImage: async (image) => image,
                recognizeImage,
                disposeOcr,
            },
        );

        expect(events).toEqual(["read:eng", "read:ara+eng", "dispose"]);
        expect(result).toEqual({
            result: { kind: "unsupported" },
            privateImageEvidence: {
                primaryText:
                    "--- OCR PROFILE eng ---\nMETER 42 ZX\nOBSERVED 2026-09-04\n\n" +
                    "--- OCR PROFILE ara+eng ---\nالعداد ٤٢\nNOMINAL",
            },
            ocrTranscripts: [
                { profile: "eng", text: "METER 42 ZX\nOBSERVED 2026-09-04" },
                { profile: "ara+eng", text: "العداد ٤٢\nNOMINAL" },
            ],
        });
        expect(JSON.stringify(result)).not.toMatch(/amount|currency|debt|credit|transaction/i);
    });

    it("keeps private OCR out of the ordinary extractor result", async () => {
        const result = await extractLocalAction(
            measurementSchema,
            noRules,
            { image: new Uint8Array([1]) },
            {
                prepareImage: async (image) => image,
                recognizeImage: async (_image, profile) => ({
                    kind: "ok",
                    confidence: 99,
                    text: `${profile} PRIVATE_SENTINEL`,
                }),
                disposeOcr: async () => undefined,
            },
        );
        expect(result).toEqual({ kind: "unsupported" });
        expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
    });

    it("preserves a successfully empty profile for app interpretation and rejects entirely empty reads", async () => {
        const read = (primaryText: string) => extractLocalActionForPrivateVerification(
            measurementSchema,
            noRules,
            { image: new Uint8Array([1]) },
            {
                prepareImage: async (image) => image,
                recognizeImage: async (_image, profile) => ({
                    kind: "ok", confidence: 90, text: profile === "eng" ? primaryText : "",
                }),
                disposeOcr: async () => undefined,
            },
        );
        expect((await read("METER 42")).ocrTranscripts).toEqual([
            { profile: "eng", text: "METER 42" },
            { profile: "ara+eng", text: "" },
        ]);
        expect(await read(" \n\t")).toEqual({
            result: { kind: "none", reason: "empty_or_oversized_image_text" },
        });
    });

    it("bounds oversized multilingual evidence while preserving each beginning and end", async () => {
        const result = await extractLocalActionForPrivateVerification(
            measurementSchema,
            noRules,
            { image: new Uint8Array([1]) },
            {
                prepareImage: async (image) => image,
                recognizeImage: async (_image, profile) => ({
                    kind: "ok",
                    confidence: 80,
                    text:
                        profile === "eng"
                            ? `EN_BEGIN_${"A".repeat(20_000)}_EN_END`
                            : `AR_BEGIN_${"ب".repeat(20_000)}_AR_END`,
                }),
                disposeOcr: async () => undefined,
            },
        );
        const text = result.privateImageEvidence?.primaryText;
        expect(text).toBeDefined();
        expect(new TextEncoder().encode(text!).byteLength).toBeLessThanOrEqual(
            MAX_PRIVATE_IMAGE_EVIDENCE_BYTES,
        );
        expect(text).toContain("EN_BEGIN_");
        expect(text).toContain("_EN_END");
        expect(text).toContain("AR_BEGIN_");
        expect(text).toContain("_AR_END");
        expect(text).toContain("\n…\n");
        expect(result.ocrTranscripts?.map(({ profile }) => profile)).toEqual(["eng", "ara+eng"]);
        expect(result.ocrTranscripts?.reduce((total, transcript) =>
            total + new TextEncoder().encode(transcript.text).byteLength, 0),
        ).toBeLessThanOrEqual(MAX_PRIVATE_IMAGE_EVIDENCE_BYTES);
        expect(result.ocrTranscripts?.map(({ profile, text: transcript }) =>
            `--- OCR PROFILE ${profile} ---\n${transcript}`).join("\n\n"),
        ).toBe(text);
        expect(result.ocrTranscripts?.every(({ text: transcript }) =>
            !transcript.includes("\ufffd")),
        ).toBe(true);
    });

    it("fails closed and releases workers when any app-requested profile fails", async () => {
        const disposeOcr = vi.fn(async () => undefined);
        const result = await extractLocalActionForPrivateVerification(
            measurementSchema,
            noRules,
            { image: new Uint8Array([1]) },
            {
                prepareImage: async (image) => image,
                recognizeImage: async (_image, profile) =>
                    profile === "eng"
                        ? { kind: "ok", confidence: 80, text: "METER 42" }
                        : { kind: "error", error: "profile read failed" },
                disposeOcr,
            },
        );
        expect(result).toEqual({ result: { kind: "error", error: "profile read failed" } });
        expect(disposeOcr).toHaveBeenCalledOnce();
    });
});
