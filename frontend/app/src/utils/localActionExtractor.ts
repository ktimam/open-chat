import {
    isValidPrivateImageEvidence,
    MAX_PRIVATE_IMAGE_EVIDENCE_BYTES,
    privateImageVerifierConfig,
    type AiActionPrivateImageOcrProfile,
    type AiActionPrivateImageVerifierConfig,
    type AiActionRule,
    type PrivateImageEvidence,
} from "@shared";
import { disposeBrowserOcr, recognizeBrowserImage, type BrowserOcrResult } from "./browserOcr";
import { prepareImageForBrowserOcr, type OcrImageDimensions } from "./ocrImage";
import { appLocalProcessorSupports } from "./appLocalProcessor";

export type LocalActionExtractorResult =
    | { kind: "unsupported" }
    | { kind: "candidates"; candidates: Record<string, unknown>[] }
    | { kind: "none"; reason: string }
    | { kind: "ambiguous"; reason: string }
    | Extract<BrowserOcrResult, { kind: "unavailable" | "error" }>;

export interface PrivateVerificationExtraction {
    result: LocalActionExtractorResult;
    // Present only after successful app-declared image OCR and only while the caller holds this
    // value in memory. It is never added to chat text, cards, logs, or persisted state.
    privateImageEvidence?: PrivateImageEvidence;
    // The same bounded profile text is also available to the app's isolated deterministic reader.
    // Profile metadata describes the OCR engine only; it does not assign meaning to any text.
    ocrTranscripts?: { profile: AiActionPrivateImageOcrProfile; text: string }[];
}

interface LocalActionExtractorInput {
    text?: string;
    image?: Uint8Array;
}

interface LocalActionExtractorOptions {
    now?: Date;
    imageDimensions?: OcrImageDimensions;
    prepareImage?: (
        image: Uint8Array,
        dimensions: OcrImageDimensions | undefined,
    ) => Promise<Uint8Array>;
    recognizeImage?: (
        image: Uint8Array,
        profile: AiActionPrivateImageOcrProfile,
    ) => Promise<BrowserOcrResult>;
    disposeOcr?: () => Promise<void>;
}

/** App-owned local processing is independent of the optional image evidence collector. */
export function localActionExtractorSupports(responseSchema: object | undefined): boolean {
    return appLocalProcessorSupports(responseSchema);
}

/** An image can enter a local-reader mode only when its app declares the complete verifier. */
export function localImageEvidenceExtractorSupports(responseSchema: object | undefined): boolean {
    return privateImageVerifierConfig(responseSchema) !== undefined;
}

// This module collects evidence only. The isolated app document interprets text and local results.
export async function extractLocalAction(
    responseSchema: object | undefined,
    rules: readonly AiActionRule[],
    input: LocalActionExtractorInput,
    options: LocalActionExtractorOptions = {},
): Promise<LocalActionExtractorResult> {
    return (await extractLocalActionForPrivateVerification(responseSchema, rules, input, options))
        .result;
}

function privateEvidence(
    primaryText: string,
    verifier: AiActionPrivateImageVerifierConfig,
): PrivateImageEvidence | undefined {
    const evidence: PrivateImageEvidence = { primaryText };
    return isValidPrivateImageEvidence(evidence, verifier.semanticFields) ? evidence : undefined;
}

const PROFILE_SEPARATOR = "\n\n";
const EVIDENCE_OMISSION_MARKER = "\n…\n";

function utf8Bytes(value: string): number {
    return new TextEncoder().encode(value).byteLength;
}

function boundedBeginningAndEnd(value: string, maximumBytes: number): string {
    if (utf8Bytes(value) <= maximumBytes) return value;
    const markerBytes = utf8Bytes(EVIDENCE_OMISSION_MARKER);
    const contentBudget = Math.max(0, maximumBytes - markerBytes);
    const beginningBudget = Math.floor(contentBudget / 2);
    const endBudget = contentBudget - beginningBudget;
    let beginning = "";
    let beginningBytes = 0;
    for (const character of value) {
        const bytes = utf8Bytes(character);
        if (beginningBytes + bytes > beginningBudget) break;
        beginning += character;
        beginningBytes += bytes;
    }
    let end = "";
    let endBytes = 0;
    for (const character of [...value].reverse()) {
        const bytes = utf8Bytes(character);
        if (endBytes + bytes > endBudget) break;
        end = character + end;
        endBytes += bytes;
    }
    return beginning + EVIDENCE_OMISSION_MARKER + end;
}

function boundedProfileTranscript(
    profile: AiActionPrivateImageOcrProfile,
    text: string,
    maximumBytes: number,
): { profile: AiActionPrivateImageOcrProfile; text: string } {
    const header = `--- OCR PROFILE ${profile} ---\n`;
    return {
        profile,
        text: boundedBeginningAndEnd(text, Math.max(0, maximumBytes - utf8Bytes(header))),
    };
}

// Image OCR is a generic, ephemeral evidence collector. Profile selection comes from the app's
// bounded verifier declaration; OpenChat neither parses the transcript nor assigns field meanings.
// Workers are disposed before this function returns so OCR WASM memory cannot coexist with WebGPU
// model inference on constrained phones.
export async function extractLocalActionForPrivateVerification(
    responseSchema: object | undefined,
    _rules: readonly AiActionRule[],
    input: LocalActionExtractorInput,
    options: LocalActionExtractorOptions = {},
): Promise<PrivateVerificationExtraction> {
    if (input.image === undefined) {
        return { result: { kind: "unsupported" } };
    }

    const verifier = privateImageVerifierConfig(responseSchema);
    if (verifier === undefined) return { result: { kind: "unsupported" } };

    let preparedImage: Uint8Array;
    try {
        preparedImage = await (options.prepareImage ?? prepareImageForBrowserOcr)(
            input.image,
            options.imageDimensions,
        );
    } catch {
        return {
            result: {
                kind: "error",
                error: "The image could not be safely prepared for local reading. Try a smaller image.",
            },
        };
    }

    const recognizedTranscripts: { profile: AiActionPrivateImageOcrProfile; text: string }[] = [];
    try {
        for (const profile of verifier.ocrProfiles) {
            const recognized = await (options.recognizeImage ?? recognizeBrowserImage)(
                preparedImage,
                profile,
            );
            // Every declared profile is part of the app's evidence contract. A partial profile set
            // could silently change field interpretation, so one failed requested read fails closed.
            if (recognized.kind !== "ok") return { result: recognized };
            recognizedTranscripts.push({ profile, text: recognized.text });
        }
    } finally {
        await (options.disposeOcr ?? disposeBrowserOcr)();
    }

    if (recognizedTranscripts.every(({ text }) => text.trim().length === 0)) {
        return { result: { kind: "none", reason: "empty_or_oversized_image_text" } };
    }

    const separatorBytes = utf8Bytes(PROFILE_SEPARATOR);
    const transcriptBudget =
        recognizedTranscripts.length === 0
            ? 0
            : Math.floor(
                  (MAX_PRIVATE_IMAGE_EVIDENCE_BYTES -
                      separatorBytes * (recognizedTranscripts.length - 1)) /
                      recognizedTranscripts.length,
              );
    const ocrTranscripts = recognizedTranscripts.map(({ profile, text }) =>
        boundedProfileTranscript(profile, text, transcriptBudget),
    );
    const primaryText = ocrTranscripts
        .map(({ profile, text }) => `--- OCR PROFILE ${profile} ---\n${text}`)
        .join(PROFILE_SEPARATOR);
    const evidence = privateEvidence(primaryText, verifier);
    if (evidence === undefined) {
        return {
            result: {
                kind: "none",
                reason: "empty_or_oversized_image_text",
            },
        };
    }
    return {
        // The app interprets this evidence through its own parser or its declared model prompt.
        result: { kind: "unsupported" },
        privateImageEvidence: evidence,
        ocrTranscripts,
    };
}
