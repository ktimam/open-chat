import type { AiActionDefinition, AiActionRule } from "@shared";
import { describe, expect, it, vi } from "vitest";
import { buildManualCard } from "./aiActionRunner";
import {
    extractLocalAction,
    extractLocalActionForPrivateVerification,
    localActionExtractorSupports,
} from "./localActionExtractor";

const schema = {
    type: "object",
    "x-openchat-source-grounded-transactions": {
        version: 1,
        amountField: "amount",
        currencyField: "currency",
        kindField: "kind",
        directionField: "direction",
        dateField: "date",
        noteField: "note",
        sourceField: "message",
        fallbackKind: "iou",
        ocrDefaultDirection: "credit",
        maximumItems: 16,
        authoritativeAmountLabels: ["amount due", "total", "transfer amount"],
        dateLabels: ["due date", "date"],
        noteLabels: ["note", "description", "memo"],
        ignoredLineLabels: ["reference"],
        titleLineKeywords: [
            "receipt",
            "request",
            "transaction successful",
            "transaction was successful",
            "powered by",
        ],
        relationshipLabelPrefixes: ["status", "direction"],
    },
    properties: {
        kind: { enum: ["settlement", "iou"] },
        amount: { type: "number", minimum: 0.005 },
        currency: { type: "string", minLength: 3, maxLength: 3 },
        direction: { type: "string", enum: ["credit", "debt"], default: "debt" },
        date: {
            type: "string",
            format: "date",
            "x-openchat-normalize-date": true,
            "x-openchat-date-from-text": true,
        },
        note: { type: "string", maxLength: 4_096 },
        message: { type: "string", minLength: 1, maxLength: 200 },
    },
    required: ["amount", "kind", "direction"],
};

const rules: AiActionRule[] = [
    {
        kind: "keyword_map",
        field: "kind",
        mode: "override",
        map: [
            { value: "iou", keywords: ["owed", "owe", "due"] },
            {
                value: "settlement",
                keywords: [
                    "paid",
                    "sent",
                    "transaction successful",
                    "transaction was successful",
                    "payment successful",
                    "payment was successful",
                    "transfer successful",
                    "transfer was successful",
                    "تمت العملية",
                    "تمت العملية بنجاح",
                    "تمت المعاملة بنجاح",
                    "تم التحويل بنجاح",
                    "تم الدفع بنجاح",
                ],
            },
        ],
    },
    {
        kind: "keyword_map",
        field: "direction",
        mode: "override",
        map: [
            { value: "credit", keywords: ["owed to you", "you owe", "owe me"] },
            { value: "debt", keywords: ["i owe", "owe you", "owe"] },
        ],
    },
    {
        kind: "keyword_map",
        field: "currency",
        mode: "hint",
        map: [{ value: "EGP", keywords: ["E£", "Egyptian pound", "cp", "ecp", "tcp"] }],
    },
];

const action: AiActionDefinition = {
    name: "iou.entry.import",
    description: "Import IOU entries",
    promptTemplate: "unused by the local extractor",
    responseSchema: schema,
    rules,
    card: {
        title: "Review IOU entry",
        rows: [
            { label: "Amount", valueKey: "amount" },
            { label: "Currency", valueKey: "currency" },
            { label: "Type", valueKey: "kind" },
            { label: "Direction", valueKey: "direction" },
            { label: "Date", valueKey: "date" },
            { label: "Note", valueKey: "note" },
        ],
        confirmLabel: "Add",
        cancelLabel: "Cancel",
    },
};

const recipientKey = "-----BEGIN PUBLIC KEY-----\nTEST\n-----END PUBLIC KEY-----\n";

describe("local action extractor", () => {
    it("uses the generic schema opt-in rather than a model or app id", () => {
        expect(localActionExtractorSupports(schema)).toBe(true);
        expect(localActionExtractorSupports({ type: "object" })).toBe(false);
    });

    it("extracts an ordinary typed transaction without invoking OCR", async () => {
        const recognizeImage = vi.fn();
        await expect(
            extractLocalAction(
                schema,
                rules,
                { text: "You owe me 425 EGP for groceries." },
                { recognizeImage, now: new Date("2026-08-14T09:00:00Z") },
            ),
        ).resolves.toEqual({
            kind: "candidates",
            candidates: [
                {
                    amount: 425,
                    currency: "EGP",
                    kind: "iou",
                    direction: "credit",
                    note: "groceries",
                    message: "You owe me 425 EGP for groceries.",
                },
            ],
        });
        expect(recognizeImage).not.toHaveBeenCalled();
    });

    it("OCRs an image once and parses only the recognized text", async () => {
        const bytes = new Uint8Array([1, 2, 3]);
        const recognizeImage = vi.fn().mockResolvedValue({
            kind: "ok",
            confidence: 94,
            text: [
                "SERVICE RECEIPT",
                "04 JUL 2026",
                "CLEANING SERVICE",
                "TOTAL EGP 350.00",
                "STATUS: OWED TO YOU",
            ].join("\n"),
        });

        await expect(
            extractLocalAction(
                schema,
                rules,
                { image: bytes },
                {
                    recognizeImage,
                    imageDimensions: { width: 1200, height: 900 },
                    prepareImage: async (image) => image,
                },
            ),
        ).resolves.toEqual({
            kind: "candidates",
            candidates: [
                {
                    amount: 350,
                    currency: "EGP",
                    kind: "iou",
                    direction: "credit",
                    date: "2026-07-04",
                    note: "CLEANING SERVICE",
                },
            ],
        });
        expect(recognizeImage).toHaveBeenCalledOnce();
        expect(recognizeImage).toHaveBeenCalledWith(bytes);
    });

    it("routes a visible reservation cue through the shared image source path", async () => {
        const strictOcrSchema = {
            ...schema,
            "x-openchat-source-grounded-transactions": {
                ...schema["x-openchat-source-grounded-transactions"],
                requireOcrEvidenceFields: ["kind"],
            },
        };
        const reservationRules: AiActionRule[] = rules.map((rule) =>
            rule.kind === "keyword_map" && rule.field === "kind"
                ? {
                      ...rule,
                      map: rule.map.map((entry) =>
                          entry.value === "iou"
                              ? { ...entry, keywords: [...entry.keywords, "reservation"] }
                              : entry,
                      ),
                  }
                : rule,
        );

        await expect(
            extractLocalAction(
                strictOcrSchema,
                reservationRules,
                { image: new Uint8Array([4, 5, 6]) },
                {
                    imageDimensions: { width: 1_080, height: 1_920 },
                    prepareImage: async (image) => image,
                    recognizeImage: async () => ({
                        kind: "ok",
                        confidence: 96,
                        text: "RESERVATION\nTOTAL 12,900 EGP",
                    }),
                },
            ),
        ).resolves.toEqual({
            kind: "candidates",
            candidates: [
                {
                    amount: 12_900,
                    currency: "EGP",
                    kind: "iou",
                    direction: "credit",
                    note: "RESERVATION",
                },
            ],
        });
    });

    it("feeds source-grounded image output through the production card and payload path", async () => {
        const local = await extractLocalAction(
            schema,
            rules,
            { image: new Uint8Array([1, 2, 3]) },
            {
                imageDimensions: { width: 1200, height: 900 },
                prepareImage: async (image) => image,
                recognizeImage: async () => ({
                    kind: "ok",
                    confidence: 94,
                    text: [
                        "SERVICE RECEIPT",
                        "04 JUL 2026",
                        "CLEANING SERVICE 350.00",
                        "TOTAL EGP 350.00",
                        "STATUS: OWED TO YOU",
                    ].join("\n"),
                }),
            },
        );
        expect(local.kind).toBe("candidates");
        if (local.kind !== "candidates") return;

        const result = buildManualCard(
            action,
            local.candidates,
            recipientKey,
            undefined,
            undefined,
            1,
            2n,
            { modality: "image", rulesAlreadyResolved: true },
        );
        expect(result).toMatchObject({
            kind: "ready",
            extracted: {
                amount: 350,
                currency: "EGP",
                kind: "iou",
                direction: "credit",
                date: "2026-07-04",
                note: "CLEANING SERVICE",
            },
            card: {
                rows: [
                    { label: "Amount", value: "350" },
                    { label: "Currency", value: "EGP" },
                    { label: "Type", value: "iou" },
                    { label: "Direction", value: "credit" },
                    { label: "Date", value: "2026-07-04" },
                    { label: "Note", value: "CLEANING SERVICE" },
                ],
            },
        });
    });

    it("builds an editable credit card when OCR has no relationship evidence", async () => {
        const recognizeSemanticImage = vi.fn();
        const local = await extractLocalAction(
            schema,
            rules,
            { image: new Uint8Array([7, 8, 9]) },
            {
                imageDimensions: { width: 1080, height: 1920 },
                prepareImage: async (image) => image,
                recognizeImage: async () => ({
                    kind: "ok",
                    confidence: 91,
                    text: [
                        "Your transaction was successful",
                        "13,500 EGP",
                        "Transfer Amount",
                        "DATE: 13 AUG 2026",
                        "NOTE: LIVING EXPENSES",
                    ].join("\n"),
                }),
                recognizeSemanticImage,
            },
        );
        expect(recognizeSemanticImage).not.toHaveBeenCalled();
        expect(local).toMatchObject({
            kind: "candidates",
            candidates: [
                {
                    amount: 13_500,
                    currency: "EGP",
                    kind: "settlement",
                    direction: "credit",
                    note: "LIVING EXPENSES",
                },
            ],
        });
        if (local.kind !== "candidates") return;

        const result = buildManualCard(
            action,
            local.candidates,
            recipientKey,
            undefined,
            undefined,
            1,
            2n,
            { modality: "image", rulesAlreadyResolved: true },
        );
        expect(result).toMatchObject({
            kind: "ready",
            extracted: {
                amount: 13_500,
                currency: "EGP",
                kind: "settlement",
                direction: "credit",
                note: "LIVING EXPENSES",
            },
            card: {
                rows: [
                    { label: "Amount", value: "13500" },
                    { label: "Currency", value: "EGP" },
                    { label: "Type", value: "settlement" },
                    { label: "Direction", value: "credit" },
                    { label: "Date", value: "2026-08-13" },
                    { label: "Note", value: "LIVING EXPENSES" },
                ],
            },
        });
    });

    it("needs visible kind evidence, then accepts an Arabic success line with exact Latin money", async () => {
        const strictOcrSchema = {
            ...schema,
            "x-openchat-source-grounded-transactions": {
                ...schema["x-openchat-source-grounded-transactions"],
                requireOcrEvidenceFields: ["kind"],
            },
        };
        const recognizeImage = vi.fn().mockResolvedValue({
            kind: "ok",
            confidence: 67,
            text: "12,900 EGP\nTransfer Amount",
        });
        const recognizeSemanticImage = vi.fn().mockResolvedValue({
            kind: "ok",
            confidence: 76,
            // Supplemental money is deliberately different: it must never replace English evidence.
            text: "تمت العملية بنجاح\n1,000 USD",
        });
        const options = {
            imageDimensions: { width: 809, height: 1_280 },
            prepareImage: async (image: Uint8Array) => image,
            recognizeImage,
            recognizeSemanticImage,
        };

        await expect(
            extractLocalAction(strictOcrSchema, rules, { image: new Uint8Array([1]) }, options),
        ).resolves.toEqual({
            kind: "candidates",
            candidates: [
                {
                    amount: 12_900,
                    currency: "EGP",
                    kind: "settlement",
                    direction: "credit",
                },
            ],
        });
        expect(recognizeImage).toHaveBeenCalledOnce();
        expect(recognizeSemanticImage).toHaveBeenCalledOnce();
    });

    it("keeps an OCR-adjacent EGP alias and rejects an unlabelled identifier-like decoy", async () => {
        const strictOcrSchema = {
            ...schema,
            "x-openchat-source-grounded-transactions": {
                ...schema["x-openchat-source-grounded-transactions"],
                requireOcrEvidenceFields: ["kind"],
            },
        };

        await expect(
            extractLocalAction(
                strictOcrSchema,
                rules,
                { image: new Uint8Array([1]) },
                {
                    imageDimensions: { width: 909, height: 1_600 },
                    prepareImage: async (image) => image,
                    recognizeImage: async () => ({
                        kind: "ok",
                        confidence: 59,
                        text: "UNRELATED HEADING\n12,900 ecp\n987654321012 ALL\n14 Aug 2026",
                    }),
                    recognizeSemanticImage: async () => ({
                        kind: "ok",
                        confidence: 81,
                        text: "تمت العملية",
                    }),
                },
            ),
        ).resolves.toMatchObject({
            kind: "candidates",
            candidates: [
                {
                    amount: 12_900,
                    currency: "EGP",
                    kind: "settlement",
                    direction: "credit",
                    date: "2026-08-14",
                },
            ],
        });
        const result = await extractLocalAction(
            strictOcrSchema,
            rules,
            { image: new Uint8Array([1]) },
            {
                imageDimensions: { width: 909, height: 1_600 },
                prepareImage: async (image) => image,
                recognizeImage: async () => ({
                    kind: "ok",
                    confidence: 59,
                    text: "UNRELATED HEADING\n12,900 ecp\n987654321012 ALL\n14 Aug 2026",
                }),
                recognizeSemanticImage: async () => ({
                    kind: "ok",
                    confidence: 81,
                    text: "تمت العملية",
                }),
            },
        );
        expect(result.kind).toBe("candidates");
        if (result.kind === "candidates") {
            expect(result.candidates[0]).not.toHaveProperty("note");
        }
    });

    it("never fuzzy-repairs a mangled currency or turns an Arabic status into a note", async () => {
        await expect(
            extractLocalAction(
                schema,
                rules,
                { image: new Uint8Array([3]) },
                {
                    imageDimensions: { width: 809, height: 1_280 },
                    prepareImage: async (image) => image,
                    recognizeImage: async () => ({
                        kind: "ok",
                        confidence: 70,
                        text: "تم التحويل بنجاح\n12,900 xcp\nTransfer Amount",
                    }),
                },
            ),
        ).resolves.toEqual({
            kind: "candidates",
            candidates: [
                {
                    amount: 12_900,
                    kind: "settlement",
                    direction: "credit",
                },
            ],
        });
    });

    it("gives an attached image caption note precedence over the OCR Note row", async () => {
        await expect(
            extractLocalAction(
                schema,
                rules,
                {
                    image: new Uint8Array([1, 2, 3]),
                    text: "August living expenses",
                },
                {
                    imageDimensions: { width: 809, height: 1280 },
                    prepareImage: async (image) => image,
                    recognizeImage: async () => ({
                        kind: "ok",
                        confidence: 94,
                        text: [
                            "Transaction Successful",
                            "TOTAL EGP 13,500",
                            "DATE: 13 AUG 2026",
                            "NOTE: OCR description",
                        ].join("\n"),
                    }),
                },
            ),
        ).resolves.toEqual({
            kind: "candidates",
            candidates: [
                {
                    amount: 13_500,
                    currency: "EGP",
                    kind: "settlement",
                    direction: "credit",
                    date: "2026-08-13",
                    note: "August living expenses",
                },
            ],
        });
    });

    it("maps the observed immediate OCR-only cp token to the action-declared EGP target", async () => {
        const result = await extractLocalAction(
            schema,
            rules,
            { image: new Uint8Array([4, 5, 6]) },
            {
                imageDimensions: { width: 1080, height: 1748 },
                prepareImage: async (image) => image,
                recognizeImage: async () => ({
                    kind: "ok",
                    confidence: 76,
                    text: [
                        "Transaction Successful",
                        "9,757 cp",
                        "Transfer Amount",
                        "From",
                        "sender@instapay",
                        "To",
                        "recipient",
                        "Reference 614106299983",
                        "Date: 04 Jul 2026 03:19 PM",
                        "Note Bill Payments - M9-4A-01",
                        "POWERED BY",
                    ].join("\n"),
                }),
            },
        );

        expect(result).toEqual({
            kind: "candidates",
            candidates: [
                {
                    amount: 9_757,
                    currency: "EGP",
                    kind: "settlement",
                    direction: "credit",
                    date: "2026-07-04",
                    note: "Bill Payments - M9-4A-01",
                },
            ],
        });
    });

    it("rejects a kind cue behind an undeclared OCR label", async () => {
        const local = await extractLocalAction(
            schema,
            rules,
            { image: new Uint8Array([1, 2, 3]) },
            {
                imageDimensions: { width: 1200, height: 900 },
                prepareImage: async (image) => image,
                recognizeImage: async () => ({
                    kind: "ok",
                    confidence: 94,
                    text: [
                        "SERVICE RECEIPT",
                        "DETAILS: PAID CLEANING",
                        "TOTAL EGP 350.00",
                        "STATUS: OWED TO YOU",
                    ].join("\n"),
                }),
            },
        );
        expect(local).toEqual({
            kind: "ambiguous",
            reason: "untrusted_ocr_semantic_cue",
        });
    });

    it("rejects direction cues behind undeclared OCR labels before building a card", async () => {
        await expect(
            extractLocalAction(
                schema,
                rules,
                { image: new Uint8Array([1, 2, 3]) },
                {
                    imageDimensions: { width: 1200, height: 900 },
                    prepareImage: async (image) => image,
                    recognizeImage: async () => ({
                        kind: "ok",
                        confidence: 94,
                        text: "TOTAL EGP 350.00\nDETAILS: I OWE YOU",
                    }),
                },
            ),
        ).resolves.toEqual({
            kind: "ambiguous",
            reason: "untrusted_ocr_semantic_cue",
        });
    });

    it("rejects semantic cues in an authoritative amount remainder", async () => {
        await expect(
            extractLocalAction(
                schema,
                rules,
                { image: new Uint8Array([1, 2, 3]) },
                {
                    imageDimensions: { width: 1200, height: 900 },
                    prepareImage: async (image) => image,
                    recognizeImage: async () => ({
                        kind: "ok",
                        confidence: 94,
                        text: "TOTAL: PAID 350 EGP",
                    }),
                },
            ),
        ).resolves.toEqual({
            kind: "ambiguous",
            reason: "untrusted_ocr_semantic_cue",
        });
    });

    it("rejects semantic cues in an unknown OCR label prefix", async () => {
        await expect(
            extractLocalAction(
                schema,
                rules,
                { image: new Uint8Array([1, 2, 3]) },
                {
                    imageDimensions: { width: 1200, height: 900 },
                    prepareImage: async (image) => image,
                    recognizeImage: async () => ({
                        kind: "ok",
                        confidence: 94,
                        text: "I OWE YOU: 350 EGP",
                    }),
                },
            ),
        ).resolves.toEqual({
            kind: "ambiguous",
            reason: "untrusted_ocr_semantic_cue",
        });
    });

    it("preserves per-entry direction in a mixed source-grounded text extraction", async () => {
        const text = "You owe me 10 USD for tea; I owe you 20 USD for taxi";
        const local = await extractLocalAction(schema, rules, { text });
        expect(local).toMatchObject({
            kind: "candidates",
            candidates: [{ direction: "credit" }, { direction: "debt" }],
        });
        if (local.kind !== "candidates") return;

        const result = buildManualCard(
            action,
            local.candidates,
            recipientKey,
            undefined,
            undefined,
            1,
            2n,
            { modality: "text", text, rulesAlreadyResolved: true },
        );
        expect(result).toMatchObject({
            kind: "ready_multi",
            extracted: [{ direction: "credit" }, { direction: "debt" }],
        });
        if (result.kind !== "ready_multi") return;
        expect(JSON.parse(new TextDecoder().decode(result.card.confirmPayload))).toMatchObject([
            { direction: "credit" },
            { direction: "debt" },
        ]);
    });

    it("propagates bounded OCR failures and never falls through to a generative model", async () => {
        await expect(
            extractLocalAction(
                schema,
                rules,
                { image: new Uint8Array([1]) },
                {
                    recognizeImage: vi.fn().mockResolvedValue({
                        kind: "error",
                        error: "The local image reader did not finish this image in time.",
                    }),
                    prepareImage: async (image) => image,
                    imageDimensions: { width: 900, height: 700 },
                },
            ),
        ).resolves.toEqual({
            kind: "error",
            error: "The local image reader did not finish this image in time.",
        });
    });

    it("fails closed before OCR when safe image preparation fails", async () => {
        const recognizeImage = vi.fn();
        await expect(
            extractLocalAction(
                schema,
                rules,
                { image: new Uint8Array([1]) },
                {
                    imageDimensions: { width: 4032, height: 3024 },
                    prepareImage: vi.fn().mockRejectedValue(new Error("decode failed")),
                    recognizeImage,
                },
            ),
        ).resolves.toEqual({
            kind: "error",
            error: "The image could not be safely prepared for local reading. Try a smaller image.",
        });
        expect(recognizeImage).not.toHaveBeenCalled();
    });

    it("returns private primary OCR plus only categorical semantic evidence while the ordinary API strips both", async () => {
        const strictOcrSchema = {
            ...schema,
            "x-openchat-source-grounded-transactions": {
                ...schema["x-openchat-source-grounded-transactions"],
                requireOcrEvidenceFields: ["kind"],
            },
        };
        const primaryText = [
            "12,900 EGP",
            "Transfer Amount",
            "14 Aug 2026",
            "ACCOUNT_SENTINEL_987654321",
        ].join("\n");
        const semanticText = "TRANSACTION SUCCESSFUL\n1,000 USD\nSEMANTIC_SENTINEL";
        const options = {
            imageDimensions: { width: 909, height: 1_600 },
            prepareImage: async (image: Uint8Array) => image,
            recognizeImage: vi.fn().mockResolvedValue({
                kind: "ok" as const,
                confidence: 72,
                text: primaryText,
            }),
            recognizeSemanticImage: vi.fn().mockResolvedValue({
                kind: "ok" as const,
                confidence: 81,
                text: semanticText,
            }),
        };

        const privateResult = await extractLocalActionForPrivateVerification(
            strictOcrSchema,
            rules,
            { image: new Uint8Array([1]) },
            options,
        );

        expect(privateResult.result).toMatchObject({
            kind: "candidates",
            candidates: [
                {
                    amount: 12_900,
                    currency: "EGP",
                    kind: "settlement",
                    direction: "credit",
                    date: "2026-08-14",
                },
            ],
        });
        expect(privateResult.privateImageEvidence).toEqual({
            primaryText,
            semanticText: "kind: settlement\ndirection: credit",
        });
        expect(privateResult.privateImageEvidence?.semanticText).not.toContain("1,000");
        expect(privateResult.privateImageEvidence?.semanticText).not.toContain("USD");
        expect(privateResult.privateImageEvidence?.semanticText).not.toContain("SENTINEL");

        const ordinary = await extractLocalAction(
            strictOcrSchema,
            rules,
            { image: new Uint8Array([1]) },
            options,
        );
        expect(ordinary).toMatchObject(privateResult.result);
        expect(ordinary).not.toHaveProperty("privateImageEvidence");
        expect(JSON.stringify(ordinary)).not.toContain("ACCOUNT_SENTINEL");
        expect(JSON.stringify(ordinary)).not.toContain("SEMANTIC_SENTINEL");
    });
});
