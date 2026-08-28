import { describe, expect, it } from "vitest";
import {
    browserImageStrategy,
    parseSourceGroundedTransactions,
    supportsSourceGroundedTransactions,
} from "./sourceGroundedActionParser";

const SCHEMA = {
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
    "x-openchat-browser-image-strategy": {
        version: 1,
        primary: "selected_model",
        requireAcceleration: true,
        fallback: "source_grounded",
    },
    "x-openchat-text-sequence": {
        numberField: "amount",
        labelField: "note",
        minimumItems: 2,
        anchors: ["owe me", "owe"],
        unanchoredMode: "whole_message",
        unanchoredLabels: ["food", "uber", "shopping"],
    },
    properties: {
        kind: { enum: ["settlement", "iou"] },
        amount: { type: "number", minimum: 0.005, maximum: 90_071_992_547_409.9 },
        currency: {
            type: "string",
            minLength: 3,
            maxLength: 3,
            format: "ascii-uppercase",
        },
        direction: { type: "string", enum: ["credit", "debt"], default: "debt" },
        date: {
            type: "string",
            minLength: 10,
            maxLength: 10,
            format: "date",
            "x-openchat-normalize-date": true,
            "x-openchat-date-from-text": true,
        },
        note: { type: "string", maxLength: 4_096, format: "utf8-no-nul" },
        message: { type: "string", minLength: 1, maxLength: 200, format: "utf8-no-nul" },
    },
    required: ["amount", "kind", "direction"],
};

const RULES = [
    {
        kind: "keyword_map",
        field: "kind",
        mode: "override",
        map: [
            { value: "iou", keywords: ["due", "owed", "owes", "owe"] },
            {
                value: "settlement",
                keywords: [
                    "paid",
                    "sent",
                    "transferred",
                    "settled",
                    "received",
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
            {
                value: "credit",
                keywords: ["owed to you", "you are owed", "due to you", "you owe", "owe me"],
            },
            {
                value: "debt",
                keywords: ["i owe", "we owe", "owe you", "owed by you", "due from you", "owe"],
            },
        ],
    },
    {
        kind: "keyword_map",
        field: "currency",
        mode: "hint",
        map: [
            { value: "USD", keywords: ["$", "dollar", "dollars"] },
            { value: "GBP", keywords: ["£", "pound sterling", "pounds sterling"] },
            { value: "EUR", keywords: ["€", "euro", "euros"] },
            {
                value: "EGP",
                keywords: ["E£", "Egyptian pound", "Egyptian pounds", "cp", "ecp", "tcp"],
            },
        ],
    },
] as const;

function parseText(text: string, now?: Date) {
    return parseSourceGroundedTransactions(SCHEMA, RULES, { source: "text", text, now });
}

function parseOcr(text: string, messageText?: string) {
    return parseSourceGroundedTransactions(SCHEMA, RULES, { source: "ocr", text, messageText });
}

describe("source-grounded transaction schema opt-in", () => {
    it("accepts only a complete, bounded declaration", () => {
        expect(supportsSourceGroundedTransactions(SCHEMA)).toBe(true);
        expect(supportsSourceGroundedTransactions({ type: "object" })).toBe(false);
        expect(
            supportsSourceGroundedTransactions({
                ...SCHEMA,
                "x-openchat-source-grounded-transactions": {
                    ...SCHEMA["x-openchat-source-grounded-transactions"],
                    surprise: true,
                },
            }),
        ).toBe(false);
        expect(
            supportsSourceGroundedTransactions({
                ...SCHEMA,
                required: ["amount", "kind"],
            }),
        ).toBe(false);
        expect(
            parseSourceGroundedTransactions({ type: "object" }, RULES, {
                source: "text",
                text: "You owe me 20 USD for lunch",
            }),
        ).toEqual({ kind: "none", reason: "schema_not_opted_in" });
    });

    it("derives currency and enum/default policy from ordinary schema and rules", () => {
        const narrowed = structuredClone(SCHEMA);
        (narrowed.properties.currency as Record<string, unknown>).enum = ["EUR"];
        expect(supportsSourceGroundedTransactions(narrowed)).toBe(true);
        expect(
            parseSourceGroundedTransactions(narrowed, RULES, {
                source: "text",
                text: "I owe you 12 USD for lunch",
            }),
        ).toMatchObject({ kind: "none" });
        expect(
            parseSourceGroundedTransactions(narrowed, RULES, {
                source: "text",
                text: "reservation 50 EUR",
            }),
        ).toEqual({
            kind: "candidates",
            candidates: [
                {
                    amount: 50,
                    currency: "EUR",
                    kind: "iou",
                    direction: "debt",
                    note: "reservation",
                    message: "reservation 50 EUR",
                },
            ],
        });
    });

    it("accepts only an app-declared OCR default that belongs to the direction enum", () => {
        const invalid = structuredClone(SCHEMA);
        invalid["x-openchat-source-grounded-transactions"].ocrDefaultDirection = "sideways";
        expect(supportsSourceGroundedTransactions(invalid)).toBe(false);
    });

    it("accepts only the exact bounded model-first browser image strategy", () => {
        expect(browserImageStrategy(SCHEMA)).toEqual({
            version: 1,
            primary: "selected_model",
            requireAcceleration: true,
            fallback: "source_grounded",
        });

        for (const replacement of [
            undefined,
            {
                version: 2,
                primary: "selected_model",
                requireAcceleration: true,
                fallback: "source_grounded",
            },
            {
                version: 1,
                primary: "any_model",
                requireAcceleration: true,
                fallback: "source_grounded",
            },
            {
                version: 1,
                primary: "selected_model",
                requireAcceleration: false,
                fallback: "source_grounded",
            },
            { version: 1, primary: "selected_model", requireAcceleration: true, fallback: "none" },
            {
                version: 1,
                primary: "selected_model",
                requireAcceleration: true,
                fallback: "source_grounded",
                surprise: true,
            },
        ]) {
            const candidate = structuredClone(SCHEMA) as Record<string, unknown>;
            if (replacement === undefined) {
                delete candidate["x-openchat-browser-image-strategy"];
            } else {
                candidate["x-openchat-browser-image-strategy"] = replacement;
            }
            expect(browserImageStrategy(candidate)).toBeUndefined();
        }

        const noFallbackParser = structuredClone(SCHEMA) as Record<string, unknown>;
        delete noFallbackParser["x-openchat-source-grounded-transactions"];
        expect(browserImageStrategy(noFallbackParser)).toBeUndefined();
    });
});

describe("typed source parsing", () => {
    it("parses only a complete alternating amount/label message without an anchor", () => {
        const source = "300 food 400 Uber\n\n250 shopping";
        expect(parseText(source)).toEqual({
            kind: "candidates",
            candidates: [
                {
                    amount: 300,
                    note: "food",
                    kind: "iou",
                    direction: "debt",
                    message: source,
                },
                {
                    amount: 400,
                    note: "Uber",
                    kind: "iou",
                    direction: "debt",
                    message: source,
                },
                {
                    amount: 250,
                    note: "shopping",
                    kind: "iou",
                    direction: "debt",
                    message: source,
                },
            ],
        });

        for (const rejected of [
            "please add 300 food 400 Uber",
            "300 food 400 Uber please remember this transaction later",
            "300 food ref 99 400 Uber",
            "300 food 400 Uber 250",
            "300 food",
            "3 pizzas 2 books",
            "300 pizzas 400 books",
            "300 units 400 tickets",
        ]) {
            expect(parseText(rejected).kind).not.toBe("candidates");
        }
    });

    it("keeps anchored sequences available and requires an explicit whole-message opt-in", () => {
        expect(parseText("owe me 300 food 400 Uber")).toMatchObject({
            kind: "candidates",
            candidates: [
                { amount: 300, note: "food", kind: "iou", direction: "credit" },
                { amount: 400, note: "Uber", kind: "iou", direction: "credit" },
            ],
        });

        const anchorOnly = structuredClone(SCHEMA);
        delete anchorOnly["x-openchat-text-sequence"].unanchoredMode;
        delete anchorOnly["x-openchat-text-sequence"].unanchoredLabels;
        expect(
            parseSourceGroundedTransactions(anchorOnly, RULES, {
                source: "text",
                text: "300 food 400 Uber",
            }),
        ).toMatchObject({ kind: "none" });
        expect(
            parseSourceGroundedTransactions(anchorOnly, RULES, {
                source: "text",
                text: "owe me 300 food 400 Uber",
            }),
        ).toMatchObject({
            kind: "candidates",
            candidates: [
                { amount: 300, note: "food", direction: "credit" },
                { amount: 400, note: "Uber", direction: "credit" },
            ],
        });
    });

    it("deduplicates repeated keyword declarations and bounds relationship-hit work", () => {
        const noisySchema = structuredClone(SCHEMA);
        (noisySchema.properties.message as Record<string, unknown>).maxLength = 4_096;
        const noisyRules = structuredClone(RULES);
        const directionRule = noisyRules.find(
            (rule) => rule.kind === "keyword_map" && rule.field === "direction",
        );
        expect(directionRule).toBeDefined();
        directionRule!.map[0].keywords = Array.from({ length: 64 }, () => "owe me");
        const source = `You owe me 425 EGP for groceries. ${"owe me ".repeat(500)}`.trim();
        const started = performance.now();
        const result = parseSourceGroundedTransactions(noisySchema, noisyRules, {
            source: "text",
            text: source,
        });

        expect(performance.now() - started).toBeLessThan(500);
        expect(result).toMatchObject({
            kind: "candidates",
            candidates: [{ amount: 425, currency: "EGP", direction: "credit" }],
        });
    });

    it("does not reinterpret lowercase prose as an ISO currency or borrow currency globally", () => {
        for (const source of [
            "You owe me 20 for all groceries",
            "I owe you 50, try booking again",
            "I owe you 60 for top shelf",
        ]) {
            const result = parseText(source);
            expect(result.kind).toBe("candidates");
            if (result.kind !== "candidates") continue;
            expect(result.candidates).toHaveLength(1);
            expect(result.candidates[0]).not.toHaveProperty("currency");
        }

        expect(parseText("You owe me 20 EGP for groceries")).toMatchObject({
            kind: "candidates",
            candidates: [{ amount: 20, currency: "EGP" }],
        });
        expect(parseText("You owe me $20 for groceries")).toMatchObject({
            kind: "candidates",
            candidates: [{ amount: 20, currency: "USD" }],
        });

        const ocr = parseOcr(
            ["SERVICE RECEIPT", "KEEP ALL RECEIPTS", "TOTAL 350", "STATUS: OWED TO YOU"].join("\n"),
        );
        expect(ocr.kind).toBe("candidates");
        if (ocr.kind === "candidates") expect(ocr.candidates[0]).not.toHaveProperty("currency");
    });

    it("passes the ordinary, type/date, delimited and natural multi-entry acceptance inputs", () => {
        const ordinary = parseText("You owe me 425 EGP for groceries.");
        expect(ordinary).toEqual({
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

        const reservation = parseText(
            "reservation 3-8 august 7777 gbp",
            new Date("2026-08-14T09:00:00Z"),
        );
        expect(reservation).toEqual({
            kind: "candidates",
            candidates: [
                {
                    amount: 7777,
                    currency: "GBP",
                    kind: "iou",
                    direction: "debt",
                    date: "2026-08-03",
                    note: "reservation 3-8 august",
                    message: "reservation 3-8 august 7777 gbp",
                },
            ],
        });

        const delimitedSource =
            "Outstanding items owed to you: taxi 310 EGP; lunch 145 EGP; tickets 620 EGP.";
        const delimited = parseText(delimitedSource);
        expect(delimited.kind).toBe("candidates");
        if (delimited.kind === "candidates") {
            expect(delimited.candidates).toEqual([
                {
                    amount: 310,
                    currency: "EGP",
                    kind: "iou",
                    direction: "credit",
                    note: "taxi",
                    message: delimitedSource,
                },
                {
                    amount: 145,
                    currency: "EGP",
                    kind: "iou",
                    direction: "credit",
                    note: "lunch",
                    message: delimitedSource,
                },
                {
                    amount: 620,
                    currency: "EGP",
                    kind: "iou",
                    direction: "credit",
                    note: "tickets",
                    message: delimitedSource,
                },
            ]);
        }

        const multiSource =
            "You owe me 310 EGP for taxi. You also owe me 145 EGP for lunch. You also owe me 620 EGP for tickets.";
        const multi = parseText(multiSource);
        expect(multi.kind).toBe("candidates");
        if (multi.kind === "candidates") {
            expect(
                multi.candidates.map(({ amount, note, message }) => ({ amount, note, message })),
            ).toEqual([
                { amount: 310, note: "taxi", message: multiSource },
                { amount: 145, note: "lunch", message: multiSource },
                { amount: 620, note: "tickets", message: multiSource },
            ]);
            expect(multi.candidates.every(({ kind }) => kind === "iou")).toBe(true);
            expect(multi.candidates.every(({ direction }) => direction === "credit")).toBe(true);
        }
    });

    it("handles other currencies, exact relative dates, settlements and mixed-direction clauses", () => {
        expect(
            parseText("I owe you €12.50 for lunch tomorrow", new Date("2026-08-14T12:00:00Z")),
        ).toEqual({
            kind: "candidates",
            candidates: [
                {
                    amount: 12.5,
                    currency: "EUR",
                    kind: "iou",
                    direction: "debt",
                    date: "2026-08-15",
                    note: "lunch",
                    message: "I owe you €12.50 for lunch tomorrow",
                },
            ],
        });
        expect(parseText("sent 19.95 USD for coffee")).toMatchObject({
            kind: "candidates",
            candidates: [{ amount: 19.95, currency: "USD", kind: "settlement", note: "coffee" }],
        });
        expect(parseText("You owe me 80 E£ for supplies")).toMatchObject({
            kind: "candidates",
            candidates: [{ amount: 80, currency: "EGP", note: "supplies" }],
        });
        const mixed = parseText("I owe you 10 USD for tea, but you owe me 20 USD for taxi");
        expect(mixed).toMatchObject({
            kind: "candidates",
            candidates: [
                { amount: 10, direction: "debt", note: "tea" },
                { amount: 20, direction: "credit", note: "taxi" },
            ],
        });
    });

    it("keeps a reservation duration in the note while using its start as the date", () => {
        expect(
            parseText("Reservation 1-10 August 700 USD", new Date("2026-08-16T09:00:00Z")),
        ).toEqual({
            kind: "candidates",
            candidates: [
                {
                    amount: 700,
                    currency: "USD",
                    kind: "iou",
                    direction: "debt",
                    date: "2026-08-01",
                    note: "Reservation 1-10 August",
                    message: "Reservation 1-10 August 700 USD",
                },
            ],
        });
    });

    it("rejects no-action, unsupported, contradictory and ambiguous numeric sources", () => {
        expect(parseText("See you at 3 pm by gate 4")).toMatchObject({ kind: "none" });
        expect(parseText("You owe me USD for lunch")).toEqual({
            kind: "none",
            reason: "no_amount",
        });
        expect(parseText("paid or owe 20 USD for lunch")).toEqual({
            kind: "ambiguous",
            reason: "conflicting_transaction_semantics",
        });
        expect(parseText("You owe me 20 USD or EUR for lunch")).toEqual({
            kind: "ambiguous",
            reason: "amount_has_ambiguous_currency",
        });
        // Quantity 3 is not silently promoted to a second amount.
        const quantity = parseText("You owe me 20 USD for 3 tickets");
        expect(quantity).toMatchObject({ kind: "candidates", candidates: [{ amount: 20 }] });
        if (quantity.kind === "candidates") expect(quantity.candidates).toHaveLength(1);
        // Numeric slash dates are locale-ambiguous and never guessed.
        const ambiguousDate = parseText("You owe me 20 USD on 04/07/2026 for lunch");
        expect(ambiguousDate).toMatchObject({ kind: "candidates", candidates: [{ amount: 20 }] });
        if (ambiguousDate.kind === "candidates") {
            expect(ambiguousDate.candidates[0]).not.toHaveProperty("date");
        }
    });

    it("fails closed instead of tail-parsing unsupported numeric tokens", () => {
        for (const source of [
            "I owe you 12,50 EUR for lunch",
            "I owe you .50 USD for lunch",
            "I owe you 12.345 USD for lunch",
            "I owe you 0.005 USD for lunch",
            "I owe you 1,23,456 INR for rent",
            "I owe you 1 234 USD for rent",
        ]) {
            expect(parseText(source).kind).not.toBe("candidates");
        }
        expect(parseOcr("LUNCH\nTOTAL EUR 12,50\nSTATUS: I OWE YOU").kind).not.toBe("candidates");
    });

    it("does not promote explicit identifiers, quantities or exchange rates to money", () => {
        for (const source of [
            "I owe you invoice #12345",
            "I owe you reservation ID 7777",
            "You owe me order 88421",
            "I owe you 3 tickets",
            "I owe you 3 pizzas",
            "I owe you 4 books",
            "I owe 3 pizzas",
            "owe 2 books",
            "owe 4 apples",
            "You owe 5 laptops",
            "we owe 6 bottles",
            "owe 200 uber",
            "I owe you version 2026",
            "Exchange rate 1 USD = 50 EGP",
            "USD 1 buys 50 EGP",
        ]) {
            expect(parseText(source).kind).not.toBe("candidates");
        }
        expect(parseText("I owe you 50 USD for 3 tickets, reference 98765")).toMatchObject({
            kind: "candidates",
            candidates: [{ amount: 50, currency: "USD" }],
        });
    });

    it("does not reinterpret lowercase ISO-shaped prose beside an amount as currency", () => {
        for (const word of ["all", "try", "top", "pen", "cup", "mad", "gel", "rub"]) {
            const result = parseText(`I owe you 20 ${word} expenses`);
            expect(result.kind).not.toBe("candidates");
        }
        expect(parseText("I owe you 20 usd for lunch")).toMatchObject({
            kind: "candidates",
            candidates: [{ amount: 20, currency: "USD" }],
        });
        expect(parseText("reservation 3-8 august 7777 gbp", new Date("2026-08-14"))).toMatchObject({
            kind: "candidates",
            candidates: [{ amount: 7777, currency: "GBP", date: "2026-08-03" }],
        });
    });

    it("fails closed on negated cues and explicit unsupported settlement viewpoints", () => {
        for (const source of [
            "You do not owe me 20 USD",
            "You do not in any way owe me 20 USD",
            "You do not, in any way, owe me 20 USD",
            "I have not paid you 20 USD yet",
            "You owe me 20 USD, not 30 USD",
            "You owe me 20 USD and not 30 USD",
            "You owe me not more than 20 USD",
            "You owe me not less than 20 USD",
            "You sent me 20 USD for lunch",
            "You paid me 20 USD for lunch",
            "You have just paid me 20 USD for lunch",
            "Alex sent me 20 USD for lunch",
            "They paid me 20 USD for lunch",
            "I received 20 USD from you for lunch",
            "Payment received from Alex: 20 USD",
        ]) {
            expect(parseText(source).kind).not.toBe("candidates");
        }
        expect(parseText("sent 19.95 USD for coffee")).toMatchObject({
            kind: "candidates",
            candidates: [{ amount: 19.95, kind: "settlement", direction: "debt" }],
        });
        expect(parseOcr("TOTAL USD 20\nSTATUS: NOT OWED TO YOU").kind).not.toBe("candidates");
        expect(parseOcr("TOTAL USD 20\nSTATUS: NOT IN ANY WAY OWED TO YOU").kind).not.toBe(
            "candidates",
        );
    });

    it("fails closed on numeric alternatives, ranges, ratios and slash dates", () => {
        for (const source of [
            "I owe you 20/30 USD",
            "I owe you 20 / 30 USD",
            "I owe you 20 to 30 USD",
            "I owe you 20-30 USD",
            "I owe you 1:2 USD",
            "I owe you 04/07/2026 USD",
            "I owe you 20 or 30 USD",
            "I owe you either 20 USD or 30 USD",
            "I owe you between 20 and 30 USD",
            "I owe you up to 20 USD",
            "I owe you at most 20 USD",
            "I owe you at least 20 USD",
            "I owe you more than 20 USD",
            "I owe you less than 20 USD",
            "I owe you under 20 USD",
            "I owe you over 20 USD",
            "I owe you around 20 USD",
            "I owe you approximately 20 USD",
            "I owe you roughly 20 USD",
            "I owe you circa 20 USD",
            "I owe you nearly 20 USD",
            "I owe you almost 20 USD",
            "I owe you minimum 20 USD",
            "I owe you maximum 20 USD",
            "I owe you 20+ USD",
            "I owe you 20-ish USD",
            "I owe you 20 or so USD",
            "I owe you -$20",
            "I owe you -USD 20",
            "I owe you ($20)",
            "I owe you (USD 20)",
            "I owe you (20)",
        ]) {
            expect(parseText(source).kind).not.toBe("candidates");
        }
        expect(parseOcr("TOTAL USD 20-30\nSTATUS: I OWE YOU").kind).not.toBe("candidates");
    });

    it("bounds and deduplicates adversarial currency rule/span work", () => {
        const duplicateRules = [
            ...RULES,
            ...Array.from({ length: 8 }, () => ({
                kind: "keyword_map",
                field: "currency",
                mode: "hint",
                map: Array.from({ length: 64 }, () => ({
                    value: "USD",
                    keywords: Array.from({ length: 64 }, () => "$"),
                })),
            })),
        ];
        const duplicateStarted = performance.now();
        expect(
            parseSourceGroundedTransactions(SCHEMA, duplicateRules, {
                source: "text",
                text: "You owe me $20 for lunch",
            }),
        ).toMatchObject({ kind: "candidates", candidates: [{ amount: 20, currency: "USD" }] });
        expect(performance.now() - duplicateStarted).toBeLessThan(250);

        const overflowRules = [
            ...RULES,
            {
                kind: "keyword_map",
                field: "currency",
                mode: "hint",
                map: Array.from({ length: 64 }, (_, entry) => ({
                    value: "USD",
                    keywords: Array.from(
                        { length: 64 },
                        (_, keyword) => `currency-token-${entry}-${keyword}`,
                    ),
                })),
            },
        ];
        expect(
            parseSourceGroundedTransactions(SCHEMA, overflowRules, {
                source: "text",
                text: "You owe me 20 USD for lunch",
            }).kind,
        ).not.toBe("candidates");

        const longSchema = structuredClone(SCHEMA);
        (longSchema.properties.message as Record<string, unknown>).maxLength = 16_384;
        const repeatedCodes = `${"USD ".repeat(4_000)}20`;
        const spansStarted = performance.now();
        const repeated = parseSourceGroundedTransactions(longSchema, RULES, {
            source: "text",
            text: repeatedCodes,
        });
        expect(performance.now() - spansStarted).toBeLessThan(500);
        expect(repeated.kind).not.toBe("candidates");
    });

    it("splits every bounded numeric conjunction and rejects source-wide date conflicts", () => {
        const source =
            "You owe me 10 USD for tea and I owe you 20 EUR for lunch and you owe me 30 GBP for taxi";
        expect(parseText(source)).toMatchObject({
            kind: "candidates",
            candidates: [
                { amount: 10, direction: "credit", note: "tea" },
                { amount: 20, direction: "debt", note: "lunch" },
                { amount: 30, direction: "credit", note: "taxi" },
            ],
        });
        expect(parseText("reservation 3 August and 4 August 77 GBP").kind).not.toBe("candidates");
    });

    it("does not truncate the exact source field or exceed the configured cardinality", () => {
        expect(parseText(`You owe me 20 USD for ${"x".repeat(181)}`)).toEqual({
            kind: "ambiguous",
            reason: "exact_source_does_not_fit_schema",
        });
        const constrained = structuredClone(SCHEMA);
        constrained["x-openchat-source-grounded-transactions"].maximumItems = 1;
        expect(
            parseSourceGroundedTransactions(constrained, RULES, {
                source: "text",
                text: "You owe me 10 USD for tea; 20 USD for taxi",
            }),
        ).toEqual({ kind: "ambiguous", reason: "too_many_transactions" });
    });
});

describe("OCR source parsing", () => {
    it("uses separate Arabic OCR only as semantic evidence for English money", () => {
        const evidenceRequired = structuredClone(SCHEMA);
        evidenceRequired["x-openchat-source-grounded-transactions"].requireOcrEvidenceFields = [
            "kind",
        ];
        expect(
            parseSourceGroundedTransactions(evidenceRequired, RULES, {
                source: "ocr",
                text: "TOTAL 12,900 EGP\nDATE: 13 AUG 2026",
                ocrSemanticText: "تمت العملية بنجاح\n1,000 USD\nNOTE: invented",
            }),
        ).toEqual({
            kind: "candidates",
            candidates: [
                {
                    amount: 12_900,
                    currency: "EGP",
                    kind: "settlement",
                    direction: "credit",
                    date: "2026-08-13",
                },
            ],
        });
    });

    it("maps only an immediate, OCR-only exact alias declared for one currency", () => {
        for (const alias of ["cp", "ecp", "tcp"]) {
            expect(
                parseOcr(`Transaction Successful\n9,757 ${alias}\nTransfer Amount`),
            ).toMatchObject({
                kind: "candidates",
                candidates: [{ amount: 9_757, currency: "EGP" }],
            });
            expect(
                parseOcr(`Transaction Successful\n9,757 total ${alias}\nTransfer Amount`),
            ).toMatchObject({
                kind: "candidates",
                candidates: [{ amount: 9_757 }],
            });
            expect(parseText(`paid 9757 ${alias}`).kind).not.toBe("candidates");
        }

        const conflictingRules = structuredClone(RULES) as unknown as Array<
            Record<string, unknown>
        >;
        const currencyRule = conflictingRules.find((rule) => rule.field === "currency") as {
            map: { value: string; keywords: string[] }[];
        };
        currencyRule.map.push({ value: "USD", keywords: ["cp"] });
        expect(
            parseSourceGroundedTransactions(SCHEMA, conflictingRules, {
                source: "ocr",
                text: "Transaction Successful\n9,757 cp\nTransfer Amount",
            }),
        ).toEqual({ kind: "ambiguous", reason: "invalid_authoritative_amount" });
    });

    it("does not select an unlabelled identifier-shaped integer as money", () => {
        expect(parseOcr("Transaction Successful\n12,900 ecp\n987654321012 ALL")).toMatchObject({
            kind: "candidates",
            candidates: [{ amount: 12_900, currency: "EGP" }],
        });
        expect(parseOcr("Transaction Successful\n987654321012 ALL")).toEqual({
            kind: "none",
            reason: "no_grounded_monetary_amount",
        });
        expect(parseOcr("Transaction Successful\nTOTAL 987654321012 ALL")).toMatchObject({
            kind: "candidates",
            candidates: [{ amount: 987_654_321_012, currency: "ALL" }],
        });
        expect(parseOcr("Transaction Successful\n1,000,000,000 ALL")).toMatchObject({
            kind: "candidates",
            candidates: [{ amount: 1_000_000_000, currency: "ALL" }],
        });
    });

    it("accepts exact app-declared Arabic completion evidence without synthesizing a note", () => {
        expect(parseOcr("تمت العملية بنجاح\n12,900 EGP\nTransfer Amount")).toEqual({
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
    });

    it("accepts only the declared Arabic completion prefix, not its bare words", () => {
        const evidenceRequired = structuredClone(SCHEMA);
        evidenceRequired["x-openchat-source-grounded-transactions"].requireOcrEvidenceFields = [
            "kind",
        ];
        const parseWithSemantic = (ocrSemanticText: string) =>
            parseSourceGroundedTransactions(evidenceRequired, RULES, {
                source: "ocr",
                text: "12,900 ecp",
                ocrSemanticText,
            });

        expect(parseWithSemantic("تمت العملية")).toMatchObject({
            kind: "candidates",
            candidates: [{ amount: 12_900, currency: "EGP", kind: "settlement" }],
        });
        for (const incomplete of ["تمت", "العملية", "بنجاح", "تمت عملية"]) {
            expect(parseWithSemantic(incomplete)).toEqual({
                kind: "none",
                reason: "missing_transaction_semantics",
            });
        }
    });

    it("uses explicit success evidence, the transfer value, and a declared Note row", () => {
        const transcript = [
            "Your transaction was successful",
            "13,500 EGP",
            "Transfer Amount",
            "From",
            "sender@instapay",
            "To",
            "recipient",
            "Reference 708896614624",
            "Date 13 Aug 2026 11:59 AM",
            "Note Living Expenses",
            "POWERED BY",
        ].join("\n");
        expect(parseOcr(transcript)).toEqual({
            kind: "candidates",
            candidates: [
                {
                    amount: 13_500,
                    currency: "EGP",
                    kind: "settlement",
                    direction: "credit",
                    date: "2026-08-13",
                    note: "Living Expenses",
                },
            ],
        });
    });

    it("accepts an app-labelled success amount, exact OCR currency alias, and note", () => {
        const transcript = [
            "Transaction Successful",
            "9,757 tcp",
            "Transfer Amount",
            "sender@instapay",
            "EG260010005000000100012817112",
            "614106299983",
            "04 Jul 2026 03:19 PM",
            "Note Bill Payments - M9-4A-01",
            "POWERED BY",
        ].join("\n");
        expect(parseOcr(transcript)).toEqual({
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

    it("uses attached message text as the note and relationship evidence", () => {
        const transcript = [
            "Transaction Successful",
            "TOTAL EGP 350",
            "DATE: 04 JUL 2026",
            "NOTE: OCR description",
        ].join("\n");
        expect(parseOcr(transcript, "August living expenses")).toEqual({
            kind: "candidates",
            candidates: [
                {
                    amount: 350,
                    currency: "EGP",
                    kind: "settlement",
                    direction: "credit",
                    date: "2026-07-04",
                    note: "August living expenses",
                },
            ],
        });
    });

    it.each([
        ["inline", "Note Paid parking"],
        ["split", "Note\nPaid parking"],
    ])("does not treat a declared %s Note value as payment evidence", (_layout, noteRows) => {
        expect(parseOcr(["TOTAL EGP 350", noteRows].join("\n"))).toEqual({
            kind: "candidates",
            candidates: [
                {
                    amount: 350,
                    currency: "EGP",
                    kind: "iou",
                    direction: "credit",
                    note: "Paid parking",
                },
            ],
        });
    });

    it("does not turn a configured footer into the value of an empty Note row", () => {
        const result = parseOcr(
            "Transaction Successful\nTOTAL EGP 350\nDATE: 04 JUL 2026\nNOTE\nPOWERED BY",
        );
        expect(result).toMatchObject({
            kind: "candidates",
            candidates: [
                {
                    amount: 350,
                    currency: "EGP",
                    kind: "settlement",
                    date: "2026-07-04",
                },
            ],
        });
        if (result.kind === "candidates") {
            expect(result.candidates[0]).not.toHaveProperty("note");
        }
    });

    it("omits an unlabelled nearby line when the monetary amount is also unlabelled", () => {
        expect(parseOcr("Transaction Successful\nUNRELATED HEADING\n12,900 ecp")).toEqual({
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
        expect(
            parseOcr("Transaction Successful\nUNRELATED HEADING\n12,900 ecp\nNote Living Expenses"),
        ).toMatchObject({
            kind: "candidates",
            candidates: [{ note: "Living Expenses" }],
        });
    });

    it("fails closed when attached text contradicts image semantics", () => {
        expect(
            parseOcr(
                "Transaction Successful\nTOTAL EGP 350",
                "I owe you this unpaid amount due next month",
            ),
        ).toEqual({
            kind: "ambiguous",
            reason: "conflicting_ocr_and_message_semantics",
        });
    });

    it("uses the app-declared OCR default only when relationship evidence is absent", () => {
        expect(parseOcr("TRANSFER RECEIPT\nTOTAL EGP 350.00")).toEqual({
            kind: "candidates",
            candidates: [
                {
                    amount: 350,
                    currency: "EGP",
                    kind: "iou",
                    direction: "credit",
                },
            ],
        });
        expect(parseText("reservation 350 EGP")).toMatchObject({
            kind: "candidates",
            candidates: [{ direction: "debt" }],
        });
        expect(parseOcr("TRANSFER RECEIPT\nTOTAL EGP 350.00\nSTATUS: I OWE YOU")).toMatchObject({
            kind: "candidates",
            candidates: [{ direction: "debt" }],
        });

        const noOcrDefault = structuredClone(SCHEMA);
        delete (noOcrDefault["x-openchat-source-grounded-transactions"] as Record<string, unknown>)
            .ocrDefaultDirection;
        expect(
            parseSourceGroundedTransactions(noOcrDefault, RULES, {
                source: "ocr",
                text: "TRANSFER RECEIPT\nTOTAL EGP 350.00",
            }),
        ).toEqual({ kind: "ambiguous", reason: "missing_ocr_direction" });
    });

    it("can require explicit OCR evidence for a mapped semantic field without changing text defaults", () => {
        const evidenceRequired = structuredClone(SCHEMA);
        evidenceRequired["x-openchat-source-grounded-transactions"].requireOcrEvidenceFields = [
            "kind",
        ];

        expect(supportsSourceGroundedTransactions(evidenceRequired)).toBe(true);
        expect(
            parseSourceGroundedTransactions(evidenceRequired, RULES, {
                source: "ocr",
                text: "TOTAL 12,900 EGP",
            }),
        ).toEqual({ kind: "none", reason: "missing_transaction_semantics" });
        expect(
            parseSourceGroundedTransactions(evidenceRequired, RULES, {
                source: "ocr",
                text: "Transaction Successful\nTOTAL 12,900 EGP",
            }),
        ).toMatchObject({
            kind: "candidates",
            candidates: [{ amount: 12_900, currency: "EGP", kind: "settlement" }],
        });
        expect(
            parseSourceGroundedTransactions(evidenceRequired, RULES, {
                source: "ocr",
                text: "TOTAL 12,900 EGP\nSTATUS: I OWE YOU",
            }),
        ).toMatchObject({
            kind: "candidates",
            candidates: [{ amount: 12_900, currency: "EGP", kind: "iou" }],
        });
        expect(
            parseSourceGroundedTransactions(evidenceRequired, RULES, {
                source: "text",
                text: "reservation 12900 EGP",
            }),
        ).toMatchObject({
            kind: "candidates",
            candidates: [{ amount: 12_900, currency: "EGP", kind: "iou" }],
        });

        for (const invalid of [
            "kind",
            [],
            ["unknown"],
            ["kind", "kind"],
            ["kind", "direction", "amount"],
        ]) {
            const candidate = structuredClone(SCHEMA);
            candidate["x-openchat-source-grounded-transactions"].requireOcrEvidenceFields = invalid;
            expect(supportsSourceGroundedTransactions(candidate)).toBe(false);
        }
    });

    it("rejects direction cues hidden behind undeclared OCR labels before using the default", () => {
        for (const transcript of [
            "TOTAL EGP 350\nDETAILS: I OWE YOU",
            "TOTAL EGP 350\nDETAILS: YOU OWE ME\nMEMO: I OWE YOU",
            "TOTAL EGP 350\nSTATUS: OWED TO YOU\nDETAILS: I OWE YOU",
        ]) {
            expect(parseOcr(transcript)).toEqual({
                kind: "ambiguous",
                reason: "untrusted_ocr_semantic_cue",
            });
        }
    });

    it("rejects transaction-kind cues hidden behind undeclared OCR labels", () => {
        for (const cue of ["PAID", "SETTLED", "RECEIVED"]) {
            expect(parseOcr(`TOTAL EGP 350\nDETAILS: ${cue}`)).toEqual({
                kind: "ambiguous",
                reason: "untrusted_ocr_semantic_cue",
            });
        }
        expect(parseOcr("TOTAL EGP 350\nSTATUS: PAID")).toMatchObject({
            kind: "candidates",
            candidates: [{ kind: "settlement", direction: "credit" }],
        });
        expect(parseOcr("TOTAL EGP 350\nDETAILS: CLEANING")).toMatchObject({
            kind: "candidates",
            candidates: [{ kind: "iou", direction: "credit" }],
        });
    });

    it("rejects semantic cues hidden in an authoritative amount label remainder", () => {
        for (const transcript of [
            "TOTAL: DUE FROM YOU 350 EGP",
            "TOTAL: I OWE YOU 350 EGP",
            "TOTAL: PAID 350 EGP",
        ]) {
            expect(parseOcr(transcript)).toEqual({
                kind: "ambiguous",
                reason: "untrusted_ocr_semantic_cue",
            });
        }
        expect(parseOcr("TOTAL: 350 EGP")).toMatchObject({
            kind: "candidates",
            candidates: [{ amount: 350, kind: "iou", direction: "credit" }],
        });
        expect(parseOcr("AMOUNT DUE: 350 EGP")).toMatchObject({
            kind: "candidates",
            candidates: [{ amount: 350, kind: "iou", direction: "credit" }],
        });
    });

    it("rejects semantic cues in unknown colon-label prefixes", () => {
        for (const transcript of [
            "I OWE YOU: 350 EGP",
            "YOU OWE ME: 350 EGP",
            "SETTLED: 350 EGP",
            "PAID: 350 EGP",
            "DETAILS: YOU OWE ME\nMEMO: I OWE YOU\nTOTAL: 350 EGP",
        ]) {
            expect(parseOcr(transcript)).toEqual({
                kind: "ambiguous",
                reason: "untrusted_ocr_semantic_cue",
            });
        }
    });

    it("rejects OCR direction cues negated after the declared phrase", () => {
        for (const transcript of [
            "TOTAL EGP 350\nI OWE NOTHING",
            "TOTAL EGP 350\nSTATUS: I OWE NOT",
            "TOTAL EGP 350\nSTATUS: PAID NOT",
        ]) {
            expect(parseOcr(transcript)).toEqual({
                kind: "ambiguous",
                reason: "negated_transaction_semantics",
            });
        }
    });

    it("passes the validated synthetic image transcript", () => {
        const transcript =
            "IOU REQUEST\n\nCLEANING FEE\nOWED TO YOU\n\nAMOUNT DUE: 350 EGP\nDUE DATE: 04 JUL 2026";
        expect(parseOcr(transcript)).toEqual({
            kind: "candidates",
            candidates: [
                {
                    amount: 350,
                    currency: "EGP",
                    kind: "iou",
                    direction: "credit",
                    date: "2026-07-04",
                    note: "CLEANING FEE",
                },
            ],
        });
    });

    it("accepts harmless OCR whitespace in a configured label without repairing values", () => {
        expect(
            parseOcr("CLEANING FEE\nOWED TO YOU\nAMOUNT   DUE: 350 EGP\nDUE DATE: 04 JUL 2026"),
        ).toMatchObject({
            kind: "candidates",
            candidates: [{ amount: 350, date: "2026-07-04", note: "CLEANING FEE" }],
        });
    });

    it("passes the validated receipt transcript with bounded STATUS-prefix damage", () => {
        const transcript =
            "RIVER MARKET\n\nSERVICE RECEIPT\n04 JUL 2026   14:32\n\nCLEANING SERVICE\nREFERENCE                         TEST-042\n\nTOTAL EGP                  350.00\n\nATUS: OWED TO YOU\n\nPlease keep this receipt";
        expect(parseOcr(transcript)).toEqual({
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
    });

    it("deduplicates a receipt line item repeated by its authoritative total", () => {
        const transcript =
            "SERVICE RECEIPT\n04 JUL 2026\nCLEANING SERVICE 350.00\nTOTAL EGP 350.00\nSTATUS: OWED TO YOU";
        const result = parseOcr(transcript);
        expect(result).toEqual({
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
    });

    it("fails closed on conflicting totals, relationships and malformed amount/date values", () => {
        expect(parseOcr("TOTAL EGP 350.00\nAMOUNT DUE: 351 EGP\nSTATUS: OWED TO YOU")).toEqual({
            kind: "ambiguous",
            reason: "conflicting_authoritative_amounts",
        });
        expect(parseOcr("TOTAL EGP 350.00\nSTATUS: OWED TO YOU\nDIRECTION: OWED BY YOU")).toEqual({
            kind: "ambiguous",
            reason: "conflicting_ocr_relationship",
        });
        expect(parseOcr("TOTAL EGP 35O.00\nSTATUS: OWED TO YOU")).toEqual({
            kind: "ambiguous",
            reason: "invalid_authoritative_amount",
        });
        expect(parseOcr("TOTAL EGP 350.00\nSTATUS: OWED TO YOU\nDATE: O4 JUL 2026")).toEqual({
            kind: "ambiguous",
            reason: "invalid_labelled_date",
        });
    });

    it("does not fuzzy-repair relationship values or trust over-wide label damage", () => {
        expect(parseOcr("TOTAL EGP 350.00\nSTATUS: OWEO TO YOU")).toMatchObject({
            kind: "candidates",
            candidates: [{ direction: "credit" }],
        });
        expect(parseOcr("TOTAL EGP 350.00\nTUS: OWED TO YOU")).toEqual({
            kind: "ambiguous",
            reason: "untrusted_ocr_semantic_cue",
        });
    });
});
