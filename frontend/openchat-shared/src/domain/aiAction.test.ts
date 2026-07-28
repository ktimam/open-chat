import { describe, expect, it } from "vitest";
import {
    type AiActionDefinition,
    type AiActionDefinitionWire,
    type AiActionRule,
    type AiAppManifestWire,
    aiActionDefinitionFromWire,
    aiAppManifestFromWire,
    applyRulesPostPass,
    buildActionCardContent,
    buildMultiActionCardContent,
    chatKeyFor,
    OC_ENTRIES_ROW_LABEL,
    compileRules,
    missingRequired,
    parseExtraction,
    parseExtractionList,
    runAiAction,
} from "./aiAction";
import type { InferenceRequest, InferenceResult } from "./onDeviceModel";

const DEF: AiActionDefinition = {
    name: "demo.expense.add",
    description: "Log expense",
    promptTemplate: "extract the transaction as JSON",
    responseSchema: { type: "object" },
    card: {
        title: "Log expense",
        rows: [
            { label: "Amount", valueKey: "amount" },
            { label: "Currency", valueKey: "currency" },
            { label: "Note", valueKey: "note" },
        ],
        confirmLabel: "Add",
        cancelLabel: "Dismiss",
    },
    consumerPublicKey: "-----BEGIN PUBLIC KEY-----\nMFk\n-----END PUBLIC KEY-----\n",
};

const RECIPIENT = "-----BEGIN PUBLIC KEY-----\nABC\n-----END PUBLIC KEY-----\n";

// A definition whose schema requires a POSITIVE amount — used by the multi-entry tests so a
// degenerate element (amount 0) is dropped by the same viability gate the single-entry path uses.
const MULTI_DEF: AiActionDefinition = {
    ...DEF,
    responseSchema: {
        type: "object",
        properties: {
            kind: { type: "string" },
            amount: { type: "number", exclusiveMinimum: 0 },
            currency: { type: "string" },
            note: { type: "string" },
        },
        required: ["amount"],
    },
};

describe("parseExtractionList", () => {
    it("wraps a single bare object in a one-element list", () => {
        expect(parseExtractionList('{"amount":20,"currency":"USD"}')).toEqual([
            { amount: 20, currency: "USD" },
        ]);
    });
    it("parses a bare JSON array of objects", () => {
        expect(parseExtractionList('[{"amount":20},{"amount":30}]')).toEqual([
            { amount: 20 },
            { amount: 30 },
        ]);
    });
    it("parses an array wrapped in prose + ```json fences", () => {
        const text = 'Sure!\n```json\n[{"amount":20},{"amount":30}]\n```\ndone';
        expect(parseExtractionList(text)).toEqual([{ amount: 20 }, { amount: 30 }]);
    });
    it("keeps only object elements of the array, dropping scalars", () => {
        expect(parseExtractionList('[1, {"amount":5}, "x"]')).toEqual([{ amount: 5 }]);
    });
    it("returns undefined for an array with no object elements", () => {
        expect(parseExtractionList("[1, 2, 3]")).toBeUndefined();
    });
    it("returns undefined when there is no JSON at all", () => {
        expect(parseExtractionList("no json here")).toBeUndefined();
    });
});

describe("parseExtraction", () => {
    it("parses a bare JSON object", () => {
        expect(parseExtraction('{"amount":20,"currency":"USD"}')).toEqual({ amount: 20, currency: "USD" });
    });
    it("parses JSON wrapped in prose + ```json fences", () => {
        const text = 'Sure!\n```json\n{"amount": 20, "currency": "USD"}\n```\nHope that helps.';
        expect(parseExtraction(text)).toEqual({ amount: 20, currency: "USD" });
    });
    it("returns undefined when there is no JSON object", () => {
        expect(parseExtraction("no json here")).toBeUndefined();
    });
});

describe("buildActionCardContent", () => {
    it("maps template rows from the extraction and sets the inbox routing", () => {
        const extracted = { amount: 20, currency: "USD", note: "lunch" };
        const card = buildActionCardContent(DEF, extracted, RECIPIENT);
        expect(card.kind).toBe("action_card_content");
        expect(card.actionId).toBe("demo.expense.add");
        expect(card.rows).toEqual([
            { label: "Amount", value: "20" },
            { label: "Currency", value: "USD" },
            { label: "Note", value: "lunch" },
        ]);
        expect(card.recipientPublicKey).toBe(RECIPIENT);
        // confirmPayload is the verbatim JSON of the extraction — what the consumer decrypts + parses.
        expect(JSON.parse(new TextDecoder().decode(card.confirmPayload!))).toEqual(extracted);
    });
    it("drops rows whose value is missing/empty", () => {
        const card = buildActionCardContent(DEF, { amount: 20, currency: "USD" }, RECIPIENT);
        expect(card.rows.map((r) => r.label)).toEqual(["Amount", "Currency"]);
    });
    it("threads the optional per-app inbox onto the card, undefined when omitted", () => {
        const withInbox = buildActionCardContent(DEF, { amount: 1, currency: "USD" }, RECIPIENT, "aaaaa-aa");
        expect(withInbox.inboxCanisterId).toBe("aaaaa-aa");
        const withoutInbox = buildActionCardContent(DEF, { amount: 1, currency: "USD" }, RECIPIENT);
        expect(withoutInbox.inboxCanisterId).toBeUndefined();
    });
    it("fan-out: carries additional recipient keys, dropping empties and the primary key", () => {
        const card = buildActionCardContent(DEF, { amount: 1, currency: "USD" }, RECIPIENT, undefined, [
            "OTHER_KEY_PEM",
            "", // empty entries are dropped
            RECIPIENT, // the primary key never repeats in the fan-out list
            "SECOND_OTHER_KEY_PEM",
        ]);
        expect(card.recipientPublicKey).toBe(RECIPIENT);
        expect(card.recipientPublicKeys).toEqual(["OTHER_KEY_PEM", "SECOND_OTHER_KEY_PEM"]);
    });
    it("fan-out: recipientPublicKeys is undefined when no additional keys are supplied", () => {
        const card = buildActionCardContent(DEF, { amount: 1, currency: "USD" }, RECIPIENT);
        expect(card.recipientPublicKeys).toBeUndefined();
    });
    it("single-entry card carries NO hidden __oc_ sentinel row", () => {
        const card = buildActionCardContent(DEF, { amount: 20, currency: "USD", note: "lunch" }, RECIPIENT);
        expect(card.rows.some((r) => r.label.startsWith("__oc_"))).toBe(false);
    });
    it("bakes the owning appId onto the card (undefined when omitted)", () => {
        const withApp = buildActionCardContent(DEF, { amount: 1, currency: "USD" }, RECIPIENT, undefined, undefined, 42);
        expect(withApp.appId).toBe(42);
        const withoutApp = buildActionCardContent(DEF, { amount: 1, currency: "USD" }, RECIPIENT);
        expect(withoutApp.appId).toBeUndefined();
    });
});

describe("runAiAction", () => {
    const okInfer = (text: string) => async (_req: InferenceRequest): Promise<InferenceResult> => ({ kind: "ok", text });

    it("runs the model, parses, and builds a ready card", async () => {
        const r = await runAiAction(
            DEF,
            { text: "I paid $20 USD for lunch" },
            RECIPIENT,
            okInfer('{"amount":20,"currency":"USD","note":"lunch"}'),
        );
        expect(r.kind).toBe("ready");
        if (r.kind === "ready") {
            expect(r.card.rows[0]).toEqual({ label: "Amount", value: "20" });
            expect(r.extracted.currency).toBe("USD");
            expect(ArrayBuffer.isView(r.card.confirmPayload)).toBe(true);
        }
    });
    it("propagates unavailable (no autonomous fallback)", async () => {
        const r = await runAiAction(DEF, {}, RECIPIENT, async () => ({ kind: "unavailable", reason: "no native runtime" }));
        expect(r.kind).toBe("unavailable");
    });
    it("reports no_extraction when the model returns no JSON", async () => {
        const r = await runAiAction(DEF, {}, RECIPIENT, okInfer("I couldn't find a transaction."));
        expect(r.kind).toBe("no_extraction");
    });
    it("passes the declared prompt + image to the model, but NOT the response schema", async () => {
        let seen: InferenceRequest | undefined;
        await runAiAction(DEF, { image: new Uint8Array([1, 2, 3]) }, RECIPIENT, async (req) => {
            seen = req;
            return { kind: "ok", text: "{}" };
        });
        const today = new Date().toISOString().slice(0, 10);
        // No rules and no message text: template + the dateline only.
        expect(seen?.prompt).toBe(`${DEF.promptTemplate}\n\nToday is ${today}.`);
        // The schema is enforced deterministically AFTER generation (conformToSchema), NOT as a
        // generation-time grammar constraint — constrained decoding collapses number fields (e.g. amount)
        // to a degenerate 0 on small models. So the model must NOT receive the schema.
        expect(seen?.responseSchema).toBeUndefined();
        expect(seen?.image).toEqual(new Uint8Array([1, 2, 3]));
    });

    it("interpolates the Rules lines, Today line and Message block into the prompt", async () => {
        const def: AiActionDefinition = {
            ...DEF,
            rules: [
                { kind: "instruction", text: "Amounts are in the account currency." },
                {
                    kind: "keyword_map",
                    field: "category",
                    mode: "hint",
                    map: [{ value: "travel", keywords: ["flight", "hotel"] }],
                },
                { kind: "from_message", field: "note" },
                // normalize + context are deterministic / covered by the dateline: no prompt line.
                { kind: "normalize", field: "amount", ops: ["k_m_suffix"] },
                { kind: "context", provide: ["today"] },
            ],
        };
        let seen: InferenceRequest | undefined;
        await runAiAction(def, { text: "paid for a flight" }, RECIPIENT, async (req) => {
            seen = req;
            return { kind: "ok", text: "{}" };
        });
        const today = new Date().toISOString().slice(0, 10);
        expect(seen?.prompt).toBe(
            `${DEF.promptTemplate}\n\n` +
                `Rules:\n` +
                `- Amounts are in the account currency.\n` +
                `- Set "category" to "travel" when the message mentions any of: flight, hotel\n` +
                `- Set "note" to a short phrase taken from the message.\n\n` +
                `Today is ${today}.\n\n` +
                `Message:\npaid for a flight`,
        );
    });

    it("keyword_map override wins over the model output using the message text", async () => {
        const def: AiActionDefinition = {
            ...DEF,
            rules: [
                {
                    kind: "keyword_map",
                    field: "category",
                    mode: "override",
                    map: [
                        { value: "travel", keywords: ["flight", "hotel"] },
                        { value: "food", keywords: ["lunch", "dinner"] },
                    ],
                },
            ],
        };
        const r = await runAiAction(
            def,
            { text: "Booked a Hotel for next week" },
            RECIPIENT,
            // The model got it wrong — the deterministic override must win.
            okInfer('{"amount":20,"category":"food"}'),
        );
        expect(r.kind).toBe("ready");
        if (r.kind === "ready") {
            expect(r.extracted.category).toBe("travel");
            // confirmPayload carries the POST-PASSED object.
            const payload = JSON.parse(new TextDecoder().decode(r.card.confirmPayload!)) as Record<string, unknown>;
            expect(payload.category).toBe("travel");
        }
    });

    it("from_message fills the field from the message text", async () => {
        const def: AiActionDefinition = {
            ...DEF,
            rules: [{ kind: "from_message", field: "note", maxLength: 10 }],
        };
        const r = await runAiAction(def, { text: "  team lunch at noon  " }, RECIPIENT, okInfer('{"amount":20}'));
        expect(r.kind).toBe("ready");
        if (r.kind === "ready") {
            // trimmed, then truncated to maxLength
            expect(r.extracted.note).toBe("team lunch");
            const payload = JSON.parse(new TextDecoder().decode(r.card.confirmPayload!)) as Record<string, unknown>;
            expect(payload.note).toBe("team lunch");
        }
    });

    it("k_m_suffix normalization turns '26k' into 26000", async () => {
        const def: AiActionDefinition = {
            ...DEF,
            rules: [{ kind: "normalize", field: "amount", ops: ["k_m_suffix"] }],
        };
        const r = await runAiAction(def, { text: "spent 26k" }, RECIPIENT, okInfer('{"amount":"26k"}'));
        expect(r.kind).toBe("ready");
        if (r.kind === "ready") {
            expect(r.extracted.amount).toBe(26000);
        }
    });

    it("degenerate extraction: a required amount deleted by exclusiveMinimum 0 yields no_extraction (no card)", async () => {
        // Live repro: the model "extracted" a settlement with amount 0 from the message "hi". The
        // conformance pass deletes the degenerate amount, and with `amount` required the runner must
        // NOT post a card the consumer will reject — it reports "model found no action" instead.
        const def: AiActionDefinition = {
            ...DEF,
            responseSchema: {
                type: "object",
                properties: {
                    kind: { type: "string" },
                    amount: { type: "number", exclusiveMinimum: 0 },
                    currency: { type: "string" },
                },
                required: ["amount"],
            },
        };
        const raw = '{"kind":"settlement","amount":0,"currency":"USD"}';
        const r = await runAiAction(def, { text: "hi" }, RECIPIENT, okInfer(raw));
        expect(r.kind).toBe("no_extraction");
        if (r.kind === "no_extraction") {
            expect(r.raw).toBe(raw);
        }
    });

    it("a positive amount under the same required + exclusiveMinimum schema still yields a ready card", async () => {
        const def: AiActionDefinition = {
            ...DEF,
            responseSchema: {
                type: "object",
                properties: {
                    kind: { type: "string" },
                    amount: { type: "number", exclusiveMinimum: 0 },
                    currency: { type: "string" },
                },
                required: ["amount"],
            },
        };
        const r = await runAiAction(
            def,
            { text: "settle 350 USD" },
            RECIPIENT,
            okInfer('{"kind":"settlement","amount":350,"currency":"USD"}'),
        );
        expect(r.kind).toBe("ready");
        if (r.kind === "ready") {
            expect(r.extracted.amount).toBe(350);
            expect(r.card.rows).toContainEqual({ label: "Amount", value: "350" });
        }
    });

    it("schema conformance deletes a field violating an enum", async () => {
        const def: AiActionDefinition = {
            ...DEF,
            responseSchema: {
                type: "object",
                properties: {
                    amount: { type: "number" },
                    currency: { type: "string", enum: ["USD", "EUR"] },
                },
            },
            rules: [{ kind: "instruction", text: "Report the currency as an ISO code." }],
        };
        const r = await runAiAction(def, { text: "paid 20" }, RECIPIENT, okInfer('{"amount":20,"currency":"???"}'));
        expect(r.kind).toBe("ready");
        if (r.kind === "ready") {
            // Visible omission beats silent wrongness: the enum-violating field is deleted.
            expect(r.extracted).toEqual({ amount: 20 });
            expect(r.card.rows.map((row) => row.label)).toEqual(["Amount"]);
        }
    });

    it("rules-free definitions behave exactly as before", async () => {
        let seen: InferenceRequest | undefined;
        const r = await runAiAction(
            DEF,
            { text: "I paid $20 USD for lunch" },
            RECIPIENT,
            async (req) => {
                seen = req;
                return { kind: "ok", text: '{"amount":20,"currency":"USD","extra":true}' };
            },
        );
        const today = new Date().toISOString().slice(0, 10);
        // No Rules block in the prompt...
        expect(seen?.prompt).toBe(
            `${DEF.promptTemplate}\n\nToday is ${today}.\n\nMessage:\nI paid $20 USD for lunch`,
        );
        // ...and the extraction passes through untouched (DEF's schema declares no properties).
        expect(r.kind).toBe("ready");
        if (r.kind === "ready") {
            expect(r.extracted).toEqual({ amount: 20, currency: "USD", extra: true });
        }
    });

    // --- multi-entry (array) extraction -----------------------------------------------------------
    it("a single OBJECT still yields a `ready` card with an OBJECT confirmPayload (byte-identical)", async () => {
        const r = await runAiAction(
            MULTI_DEF,
            { text: "I paid 20 USD for lunch" },
            RECIPIENT,
            okInfer('{"amount":20,"currency":"USD","note":"lunch"}'),
        );
        expect(r.kind).toBe("ready");
        if (r.kind === "ready") {
            const payload = JSON.parse(new TextDecoder().decode(r.card.confirmPayload!)) as unknown;
            expect(Array.isArray(payload)).toBe(false);
            expect(payload).toEqual({ amount: 20, currency: "USD", note: "lunch" });
            expect(r.card.title).toBe(DEF.card.title);
        }
    });

    it("an ARRAY of [valid, invalid(amount 0), valid] drops the degenerate element and builds ONE multi card", async () => {
        const raw =
            '[{"amount":20,"currency":"USD","note":"lunch"},' +
            '{"amount":0,"currency":"USD"},' +
            '{"amount":30,"currency":"EUR","note":"dinner"}]';
        const r = await runAiAction(MULTI_DEF, { text: "two expenses and a bad one" }, RECIPIENT, okInfer(raw));
        expect(r.kind).toBe("ready_multi");
        if (r.kind === "ready_multi") {
            // The confirmPayload round-trips to EXACTLY the two valid entries, in order.
            const payload = JSON.parse(new TextDecoder().decode(r.card.confirmPayload!)) as unknown;
            expect(payload).toEqual([
                { amount: 20, currency: "USD", note: "lunch" },
                { amount: 30, currency: "EUR", note: "dinner" },
            ]);
            // Title reflects the count (2) and derives from the definition's card title.
            expect(r.card.title).toContain("2");
            expect(r.card.title).toContain(DEF.card.title);
            // One readable row per entry, composed from the def's row valueKeys, plus the hidden
            // sentinel carrying the exact validated array to the app-rendered card.
            expect(r.card.rows).toEqual([
                { label: "Entry 1", value: "20 USD lunch" },
                { label: "Entry 2", value: "30 EUR dinner" },
                {
                    label: OC_ENTRIES_ROW_LABEL,
                    value: JSON.stringify([
                        { amount: 20, currency: "USD", note: "lunch" },
                        { amount: 30, currency: "EUR", note: "dinner" },
                    ]),
                },
            ]);
            // extracted mirrors the valid array.
            expect(r.extracted).toEqual([
                { amount: 20, currency: "USD", note: "lunch" },
                { amount: 30, currency: "EUR", note: "dinner" },
            ]);
        }
    });

    it("an ARRAY with a SINGLE valid entry collapses to the single-entry OBJECT card", async () => {
        const raw = '[{"amount":0,"currency":"USD"},{"amount":42,"currency":"USD","note":"taxi"}]';
        const r = await runAiAction(MULTI_DEF, { text: "one good one bad" }, RECIPIENT, okInfer(raw));
        expect(r.kind).toBe("ready");
        if (r.kind === "ready") {
            const payload = JSON.parse(new TextDecoder().decode(r.card.confirmPayload!)) as unknown;
            expect(Array.isArray(payload)).toBe(false);
            expect(payload).toEqual({ amount: 42, currency: "USD", note: "taxi" });
        }
    });

    it("an all-invalid ARRAY yields no_extraction (no card)", async () => {
        const raw = '[{"amount":0,"currency":"USD"},{"currency":"EUR"}]';
        const r = await runAiAction(MULTI_DEF, { text: "nothing usable" }, RECIPIENT, okInfer(raw));
        expect(r.kind).toBe("no_extraction");
        if (r.kind === "no_extraction") {
            expect(r.raw).toBe(raw);
        }
    });
});

describe("buildMultiActionCardContent", () => {
    const entries = [
        { amount: 20, currency: "USD", note: "lunch" },
        { amount: 30, currency: "EUR", note: "dinner" },
    ];
    it("builds one summary row per entry, plus the hidden sentinel row, with the array as confirmPayload", () => {
        const card = buildMultiActionCardContent(DEF, entries, RECIPIENT);
        expect(card.kind).toBe("action_card_content");
        expect(card.actionId).toBe(DEF.name);
        expect(card.title).toContain("2");
        expect(card.rows).toEqual([
            { label: "Entry 1", value: "20 USD lunch" },
            { label: "Entry 2", value: "30 EUR dinner" },
            { label: OC_ENTRIES_ROW_LABEL, value: JSON.stringify(entries) },
        ]);
        expect(JSON.parse(new TextDecoder().decode(card.confirmPayload!))).toEqual(entries);
    });
    it("the hidden sentinel row round-trips the EXACT validated entry array (== the confirmPayload)", () => {
        const card = buildMultiActionCardContent(DEF, entries, RECIPIENT);
        const sentinel = card.rows.find((r) => r.label === OC_ENTRIES_ROW_LABEL);
        expect(sentinel).toBeDefined();
        // JSON.parse recovers every entry (nothing flattened / lost).
        expect(JSON.parse(sentinel!.value)).toEqual(entries);
        // The sentinel value is byte-identical to the array serialized as the confirmPayload.
        expect(sentinel!.value).toBe(new TextDecoder().decode(card.confirmPayload!));
    });
    it("threads the inbox + fan-out keys exactly like the single-entry builder", () => {
        const card = buildMultiActionCardContent(DEF, entries, RECIPIENT, "aaaaa-aa", [
            "OTHER_KEY_PEM",
            "",
            RECIPIENT,
        ]);
        expect(card.inboxCanisterId).toBe("aaaaa-aa");
        expect(card.recipientPublicKey).toBe(RECIPIENT);
        expect(card.recipientPublicKeys).toEqual(["OTHER_KEY_PEM"]);
    });
    it("bakes the owning appId onto the multi card", () => {
        const card = buildMultiActionCardContent(DEF, entries, RECIPIENT, undefined, undefined, 7);
        expect(card.appId).toBe(7);
    });
});

describe("compileRules", () => {
    it("compiles instruction / keyword_map / from_message and skips normalize + context", () => {
        const rules: AiActionRule[] = [
            { kind: "instruction", text: "Be terse." },
            {
                kind: "keyword_map",
                field: "kind",
                mode: "override",
                map: [
                    { value: "a", keywords: ["x", "y"] },
                    { value: "b", keywords: ["z"] },
                ],
            },
            { kind: "from_message", field: "note" },
            { kind: "normalize", field: "amount", ops: ["trim"] },
            { kind: "context", provide: ["today"] },
        ];
        expect(compileRules(rules)).toEqual([
            "Be terse.",
            'Set "kind" to "a" when the message mentions any of: x, y',
            'Set "kind" to "b" when the message mentions any of: z',
            'Set "note" to a short phrase taken from the message.',
        ]);
    });
});

describe("applyRulesPostPass", () => {
    it("keyword_map hint mode never touches the extraction", () => {
        const rules: AiActionRule[] = [
            { kind: "keyword_map", field: "category", mode: "hint", map: [{ value: "travel", keywords: ["hotel"] }] },
        ];
        expect(applyRulesPostPass(rules, { category: "food" }, "a hotel stay")).toEqual({ category: "food" });
    });
    it("keyword_map override matches case-insensitively and the first matching mapping wins", () => {
        const rules: AiActionRule[] = [
            {
                kind: "keyword_map",
                field: "category",
                mode: "override",
                map: [
                    { value: "travel", keywords: ["HOTEL"] },
                    { value: "stay", keywords: ["hotel"] },
                ],
            },
        ];
        expect(applyRulesPostPass(rules, {}, "A Hotel Stay")).toEqual({ category: "travel" });
    });
    it("skips message-driven rules when there is no message text", () => {
        const rules: AiActionRule[] = [
            { kind: "from_message", field: "note" },
            { kind: "keyword_map", field: "category", mode: "override", map: [{ value: "a", keywords: ["b"] }] },
        ];
        expect(applyRulesPostPass(rules, { amount: 1 }, undefined)).toEqual({ amount: 1 });
    });
    it("from_message truncates to 200 chars by default", () => {
        const rules: AiActionRule[] = [{ kind: "from_message", field: "note" }];
        const out = applyRulesPostPass(rules, {}, "x".repeat(500));
        expect((out.note as string).length).toBe(200);
    });
    it("normalize handles k/m suffixes, plain numeric strings and leaves real numbers alone", () => {
        const rules: AiActionRule[] = [{ kind: "normalize", field: "amount", ops: ["k_m_suffix"] }];
        expect(applyRulesPostPass(rules, { amount: "26k" }, undefined)).toEqual({ amount: 26000 });
        expect(applyRulesPostPass(rules, { amount: "1.5m" }, undefined)).toEqual({ amount: 1500000 });
        expect(applyRulesPostPass(rules, { amount: "1,500 k" }, undefined)).toEqual({ amount: 1500000 });
        expect(applyRulesPostPass(rules, { amount: "42" }, undefined)).toEqual({ amount: 42 });
        expect(applyRulesPostPass(rules, { amount: 42 }, undefined)).toEqual({ amount: 42 });
        expect(applyRulesPostPass(rules, { amount: "not a number" }, undefined)).toEqual({ amount: "not a number" });
        // A currency code the model folded into the amount is tolerated — the LEADING number is
        // recovered so it survives the number-typed schema field instead of being dropped as a string.
        expect(applyRulesPostPass(rules, { amount: "2000 usd" }, undefined)).toEqual({ amount: 2000 });
        expect(applyRulesPostPass(rules, { amount: "2000usd" }, undefined)).toEqual({ amount: 2000 });
        expect(applyRulesPostPass(rules, { amount: "2.5m dollars" }, undefined)).toEqual({ amount: 2500000 });
    });
    it("recovers a model-folded currency amount ('2000 usd') through normalize + schema conformance", () => {
        // Repro of the "invalid draft / amount set to 0" report: the model emitted amount as the string
        // "2000 usd". Without the leading-number normalize it stays a string, the number-typed schema
        // field drops it, and the consumer (IOU) gets no amount -> "invalid draft" + amount 0. With the
        // k_m_suffix normalize the leading number is recovered and kept.
        const schema = {
            type: "object",
            properties: { amount: { type: "number" }, currency: { type: "string" } },
        };
        const rules: AiActionRule[] = [{ kind: "normalize", field: "amount", ops: ["k_m_suffix"] }];
        expect(applyRulesPostPass(rules, { amount: "2000 usd", currency: "USD" }, undefined, schema)).toEqual({
            amount: 2000,
            currency: "USD",
        });
    });
    it("normalize strip_symbols removes currency symbols/commas/spaces and parses numerics", () => {
        const rules: AiActionRule[] = [{ kind: "normalize", field: "amount", ops: ["strip_symbols"] }];
        expect(applyRulesPostPass(rules, { amount: "$1,299.50" }, undefined)).toEqual({ amount: 1299.5 });
        expect(applyRulesPostPass(rules, { amount: "€ 20" }, undefined)).toEqual({ amount: 20 });
    });
    it("normalize applies string ops in order and skips absent fields", () => {
        const rules: AiActionRule[] = [
            { kind: "normalize", field: "code", ops: ["trim", "uppercase"] },
            { kind: "normalize", field: "missing", ops: ["lowercase"] },
        ];
        expect(applyRulesPostPass(rules, { code: "  usd " }, undefined)).toEqual({ code: "USD" });
    });
    it("schema conformance drops undeclared keys and type-violating fields", () => {
        const schema = {
            type: "object",
            properties: {
                amount: { type: "number" },
                code: { type: "string", pattern: "^[A-Z]{3}$" },
            },
        };
        expect(applyRulesPostPass([], { amount: "20", code: "USD", extra: 1 }, undefined, schema)).toEqual({
            code: "USD",
        });
        expect(applyRulesPostPass([], { amount: 20, code: "usd" }, undefined, schema)).toEqual({
            amount: 20,
        });
    });
    it("schema conformance keeps a number meeting its minimum and deletes one below it", () => {
        const schema = {
            type: "object",
            properties: { amount: { type: "number", minimum: 10 } },
        };
        expect(applyRulesPostPass([], { amount: 10 }, undefined, schema)).toEqual({ amount: 10 });
        expect(applyRulesPostPass([], { amount: 9.99 }, undefined, schema)).toEqual({});
    });
    it("schema conformance deletes a number EQUAL to its exclusiveMinimum bound", () => {
        const schema = {
            type: "object",
            properties: { amount: { type: "number", exclusiveMinimum: 0 } },
        };
        expect(applyRulesPostPass([], { amount: 0 }, undefined, schema)).toEqual({});
        expect(applyRulesPostPass([], { amount: 0.01 }, undefined, schema)).toEqual({ amount: 0.01 });
    });
    it("minimum never applies to non-number values", () => {
        // An untyped field carrying a (nonsensical) numeric bound: a string value is untouched —
        // the bound constrains numbers only, exactly like JSON schema.
        const schema = {
            type: "object",
            properties: { note: { minimum: 5 }, code: { exclusiveMinimum: 5 } },
        };
        expect(applyRulesPostPass([], { note: "hi", code: "ab" }, undefined, schema)).toEqual({
            note: "hi",
            code: "ab",
        });
    });
    it("no schema passes a violating-looking value straight through", () => {
        expect(applyRulesPostPass([], { amount: -5 }, undefined, undefined)).toEqual({ amount: -5 });
    });
});

describe("missingRequired", () => {
    const schema = {
        type: "object",
        properties: {
            amount: { type: "number", exclusiveMinimum: 0 },
            currency: { type: "string" },
        },
        required: ["amount", "currency"],
    };
    it("reports required fields absent from the extraction", () => {
        expect(missingRequired({ currency: "USD" }, schema)).toEqual(["amount"]);
    });
    it("passes when every required field is present", () => {
        expect(missingRequired({ amount: 1, currency: "USD" }, schema)).toEqual([]);
    });
    it("reports a required field the conformance pass deleted", () => {
        const conformed = applyRulesPostPass([], { amount: 0, currency: "USD" }, undefined, schema);
        expect(missingRequired(conformed, schema)).toEqual(["amount"]);
    });
    it("returns [] when the schema declares no required fields, or there is no schema", () => {
        expect(missingRequired({}, { type: "object" })).toEqual([]);
        expect(missingRequired({}, undefined)).toEqual([]);
    });
});

describe("aiActionDefinitionFromWire", () => {
    const WIRE: AiActionDefinitionWire = {
        name: "demo.expense.add",
        description: "Log expense",
        prompt_template: "extract the transaction",
        response_schema: '{"type":"object"}',
        endpoint: "",
        consumer_public_key: "-----BEGIN PUBLIC KEY-----\nABC\n-----END PUBLIC KEY-----\n",
        card: {
            title: "Log expense",
            confirm_label: "Add",
            cancel_label: "Dismiss",
            rows: [
                { field: "amount", label: "Amount" },
                { field: "currency", label: "Currency" },
            ],
        },
    };

    it("maps the snake_case wire definition to a runner AiActionDefinition", () => {
        const def = aiActionDefinitionFromWire(WIRE);
        expect(def.name).toBe("demo.expense.add");
        expect(def.promptTemplate).toBe("extract the transaction");
        expect(def.responseSchema).toEqual({ type: "object" });
        expect(def.consumerPublicKey).toContain("BEGIN PUBLIC KEY");
        expect(def.card.confirmLabel).toBe("Add");
        // card row `field` becomes the runner's `valueKey`
        expect(def.card.rows).toEqual([
            { label: "Amount", valueKey: "amount" },
            { label: "Currency", valueKey: "currency" },
        ]);
    });
    it("tolerates a non-JSON schema string (no constraint)", () => {
        const def = aiActionDefinitionFromWire({ ...WIRE, response_schema: "not json" });
        expect(def.responseSchema).toBeUndefined();
    });
    it("defaults rules to [] when absent from the wire", () => {
        const def = aiActionDefinitionFromWire(WIRE);
        expect(def.rules).toEqual([]);
    });
    it("maps externally tagged wire rules to the flat domain union", () => {
        const def = aiActionDefinitionFromWire({
            ...WIRE,
            rules: [
                {
                    keyword_map: {
                        field: "category",
                        mode: "override",
                        map: [{ value: "travel", keywords: ["flight", "hotel"] }],
                    },
                },
                { from_message: { field: "note", max_length: 120 } },
                { normalize: { field: "amount", ops: ["k_m_suffix", "trim"] } },
                { instruction: { text: "Be terse." } },
                { context: { provide: ["today"] } },
            ],
        });
        expect(def.rules).toEqual([
            {
                kind: "keyword_map",
                field: "category",
                mode: "override",
                map: [{ value: "travel", keywords: ["flight", "hotel"] }],
            },
            { kind: "from_message", field: "note", maxLength: 120 },
            { kind: "normalize", field: "amount", ops: ["k_m_suffix", "trim"] },
            { kind: "instruction", text: "Be terse." },
            { kind: "context", provide: ["today"] },
        ]);
    });
    it("maps wire surfaces and defaults them to [] when absent", () => {
        const manifestWire: AiAppManifestWire = {
            name: "demo",
            description: "Demo app",
            consumer_public_key: "-----BEGIN PUBLIC KEY-----\nABC\n-----END PUBLIC KEY-----\n",
            actions: [WIRE],
            surfaces: [
                {
                    kind: "chat_link",
                    url: "https://app.example/openchat/link-chat?chat={chatKey}",
                    display: "sheet",
                },
                { kind: "docs", url: "https://app.example/docs", display: "external" },
            ],
        };
        const manifest = aiAppManifestFromWire(manifestWire);
        expect(manifest.surfaces).toEqual([
            {
                kind: "chat_link",
                url: "https://app.example/openchat/link-chat?chat={chatKey}",
                display: "sheet",
            },
            { kind: "docs", url: "https://app.example/docs", display: "external" },
        ]);
        // Registrations that predate surfaces omit the field entirely.
        const legacy = aiAppManifestFromWire({ ...manifestWire, surfaces: undefined });
        expect(legacy.surfaces).toEqual([]);
    });

    it("maps the wire inbox_canister_id (already a text principal) and leaves it undefined when absent", () => {
        const base: AiAppManifestWire = {
            name: "demo",
            description: "Demo app",
            consumer_public_key: "-----BEGIN PUBLIC KEY-----\nABC\n-----END PUBLIC KEY-----\n",
            actions: [WIRE],
            inbox_canister_id: "aaaaa-aa",
        };
        expect(aiAppManifestFromWire(base).inboxCanisterId).toBe("aaaaa-aa");
        expect(aiAppManifestFromWire({ ...base, inbox_canister_id: undefined }).inboxCanisterId).toBeUndefined();
    });

    it("skips malformed wire rules instead of failing", () => {
        const def = aiActionDefinitionFromWire({
            ...WIRE,
            // deliberately broken entries mixed in with one valid rule
            rules: [
                "nonsense",
                { unknown_rule: { field: "x" } },
                { keyword_map: { field: "k", mode: "sideways", map: [] } },
                { instruction: { text: "Keep it short." } },
                // unrecognised normalize ops are dropped, the rule itself survives
                { normalize: { field: "amount", ops: ["trim", "future_op"] } },
            ] as unknown as NonNullable<AiActionDefinitionWire["rules"]>,
        });
        expect(def.rules).toEqual([
            { kind: "instruction", text: "Keep it short." },
            { kind: "normalize", field: "amount", ops: ["trim"] },
        ]);
    });
});

describe("chatKeyFor", () => {
    // These MUST byte-match the backend renderer
    // (backend/canisters/local_user_index/impl/src/action_deposit_envelope.rs `chat_key`).
    it("renders a group chat as group:<principal>", () => {
        expect(chatKeyFor({ kind: "group_chat", groupId: "dgegb-daaaa-aaaar-arlhq-cai" })).toBe(
            "group:dgegb-daaaa-aaaar-arlhq-cai",
        );
    });
    it("renders a channel as channel:<community principal>:<channel id decimal>", () => {
        expect(
            chatKeyFor({
                kind: "channel",
                communityId: "dgegb-daaaa-aaaar-arlhq-cai",
                channelId: 42,
            }),
        ).toBe("channel:dgegb-daaaa-aaaar-arlhq-cai:42");
    });
    it("keys direct chats by the other participant", () => {
        expect(chatKeyFor({ kind: "direct_chat", userId: "27eue-hyaaa-aaaaf-aaa4a-cai" })).toBe(
            "direct:27eue-hyaaa-aaaaf-aaa4a-cai",
        );
    });
});
