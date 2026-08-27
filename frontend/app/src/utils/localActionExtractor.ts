import {
    isValidPrivateImageEvidence,
    parseSourceGroundedTransactions,
    supportsSourceGroundedTransactions,
    type AiActionRule,
    type PrivateImageEvidence,
} from "@shared";
import {
    recognizeBrowserImage,
    recognizeBrowserSemanticImage,
    type BrowserOcrResult,
} from "./browserOcr";
import { prepareImageForBrowserOcr, type OcrImageDimensions } from "./ocrImage";

export type LocalActionExtractorResult =
    | { kind: "unsupported" }
    | { kind: "candidates"; candidates: Record<string, unknown>[] }
    | { kind: "none"; reason: string }
    | { kind: "ambiguous"; reason: string }
    | Extract<BrowserOcrResult, { kind: "unavailable" | "error" }>;

export interface PrivateVerificationExtraction {
    result: LocalActionExtractorResult;
    // Present only after a successful image OCR pass and only while the caller holds this return
    // value in memory. Ordinary extraction deliberately strips this property.
    privateImageEvidence?: PrivateImageEvidence;
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
    recognizeImage?: (image: Uint8Array) => Promise<BrowserOcrResult>;
    recognizeSemanticImage?: (image: Uint8Array) => Promise<BrowserOcrResult>;
}

export function localActionExtractorSupports(responseSchema: object | undefined): boolean {
    return supportsSourceGroundedTransactions(responseSchema);
}

// Run the schema-opted deterministic extractor. Typed messages are parsed directly; images first
// pass through the bounded local OCR worker. Neither branch calls a generative model, and OCR text
// is kept ephemeral rather than returned in errors or status stores.
export async function extractLocalAction(
    responseSchema: object | undefined,
    rules: readonly AiActionRule[],
    input: LocalActionExtractorInput,
    options: LocalActionExtractorOptions = {},
): Promise<LocalActionExtractorResult> {
    return (await extractLocalActionForPrivateVerification(responseSchema, rules, input, options))
        .result;
}

const PRIVATE_SEMANTIC_VALUE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function categoricalSemanticEvidence(result: LocalActionExtractorResult): string | undefined {
    if (result.kind !== "candidates") return undefined;
    const lines: string[] = [];
    for (const field of ["kind", "direction"] as const) {
        const values = [
            ...new Set(
                result.candidates
                    .map((candidate) => candidate[field])
                    .filter(
                        (value): value is string =>
                            typeof value === "string" && PRIVATE_SEMANTIC_VALUE.test(value),
                    ),
            ),
        ];
        if (values.length > 0) lines.push(`${field}: ${values.join(", ")}`);
    }
    return lines.length > 0 ? lines.join("\n") : undefined;
}

function privateEvidence(
    primaryText: string,
    semanticResult?: LocalActionExtractorResult,
): PrivateImageEvidence | undefined {
    const semanticText =
        semanticResult === undefined ? undefined : categoricalSemanticEvidence(semanticResult);
    const evidence: PrivateImageEvidence = {
        primaryText,
        ...(semanticText === undefined ? {} : { semanticText }),
    };
    return isValidPrivateImageEvidence(evidence) ? evidence : undefined;
}

// Verification mode gets the same deterministic result plus an ephemeral OCR-to-text-model bridge.
// The primary transcript remains exact; a second OCR transcript is never forwarded raw. Instead it
// is reduced to the already-validated categorical kind/direction values, so decoy money cannot
// compete with the authoritative primary amount/currency/date evidence.
export async function extractLocalActionForPrivateVerification(
    responseSchema: object | undefined,
    rules: readonly AiActionRule[],
    input: LocalActionExtractorInput,
    options: LocalActionExtractorOptions = {},
): Promise<PrivateVerificationExtraction> {
    if (!localActionExtractorSupports(responseSchema)) {
        return { result: { kind: "unsupported" } };
    }

    let source: "text" | "ocr";
    let text: string;
    let preparedImage: Uint8Array | undefined;
    if (input.image !== undefined) {
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
        const recognized = await (options.recognizeImage ?? recognizeBrowserImage)(preparedImage);
        if (recognized.kind !== "ok") return { result: recognized };
        source = "ocr";
        text = recognized.text;
    } else {
        source = "text";
        text = input.text ?? "";
    }

    const parse = (ocrSemanticText?: string) =>
        parseSourceGroundedTransactions(responseSchema, rules, {
            source,
            text,
            // Keep the chat caption separate from OCR: it is intentional note/semantic evidence, not
            // a second document whose digits may compete with the visible transfer amount.
            ...(source === "ocr" && input.text !== undefined ? { messageText: input.text } : {}),
            ...(ocrSemanticText === undefined ? {} : { ocrSemanticText }),
            now: options.now ?? new Date(),
        });
    const primary = parse();
    const needsSemanticFallback =
        source === "ocr" &&
        ((primary.kind === "none" && primary.reason === "missing_transaction_semantics") ||
            (primary.kind === "ambiguous" && primary.reason === "missing_ocr_direction"));
    if (!needsSemanticFallback || preparedImage === undefined) {
        return {
            result: primary,
            ...(source === "ocr" ? { privateImageEvidence: privateEvidence(text) } : {}),
        };
    }

    // The English pass remains the sole authority for money/date/note. Only when its deterministic
    // parser identifies missing required semantics do we pay for a separate Arabic recognition;
    // the shared parser consumes that transcript exclusively as kind/direction evidence.
    const semantic = await (options.recognizeSemanticImage ?? recognizeBrowserSemanticImage)(
        preparedImage,
    );
    const result = semantic.kind === "ok" ? parse(semantic.text) : primary;
    return {
        result,
        privateImageEvidence: privateEvidence(text, semantic.kind === "ok" ? result : undefined),
    };
}
