import { describe, expect, it } from "vitest";
import {
    type AiActionDefinition,
    type AiActionDefinitionWire,
    type AiActionRule,
    type AiAppManifestWire,
    aiActionDefinitionFromWire,
    aiAppCardChatContext,
    aiAppManifestFromWire,
    applyRulesPostPass,
    buildActionCardContent,
    buildMultiActionCardContent,
    chatKeyFor,
    MAX_AI_ACTION_CARD_ROW_VALUE_CHARS,
    MAX_AI_ACTION_CARD_TITLE_CHARS,
    MAX_AI_ACTION_CANDIDATES,
    MAX_AI_APP_CONFIRM_PAYLOAD_BYTES,
    multiActionCardBoundsError,
    compileRules,
    formatLocalCalendarDate,
    missingRequired,
    parseExtraction,
    parseExtractionList,
    postProcessAiActionCandidate,
    rulesFromWire,
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
    // A small on-device model routinely fails to close its JSON. Before the balanced-object scan,
    // ANY of these fell through to parseExtraction, which slices first-"{" .. last-"}" — for a
    // multi-object emission that is `{a},{b}`, invalid JSON — so the whole message extracted to
    // NOTHING and the user got "The model found no action in this message" after a long wait.
    it("salvages the complete objects of a TRUNCATED array (no closing bracket)", () => {
        const text = '[{"amount":20,"note":"rent"},{"amount":30,"note":"uber"},{"amount":40,"not';
        expect(parseExtractionList(text)).toEqual([
            { amount: 20, note: "rent" },
            { amount: 30, note: "uber" },
        ]);
    });
    it("survives a stray '[' in prose ahead of the JSON", () => {
        const text = 'Transactions [see below]:\n{"amount":20}\n{"amount":30}';
        expect(parseExtractionList(text)).toEqual([{ amount: 20 }, { amount: 30 }]);
    });
    it("survives a trailing comma between elements", () => {
        expect(parseExtractionList('[{"amount":20},{"amount":30},]')).toEqual([
            { amount: 20 },
            { amount: 30 },
        ]);
    });
    it("does not split on a brace inside a quoted string", () => {
        const text = '[{"amount":20,"note":"paid 50 } later"},{"amount":30,"note":"a { b"}';
        expect(parseExtractionList(text)).toEqual([
            { amount: 20, note: "paid 50 } later" },
            { amount: 30, note: "a { b" },
        ]);
    });
    it("does not split on an ESCAPED quote inside a string", () => {
        const text = '[{"note":"say \\"hi\\" }","amount":20},{"amount":30}';
        expect(parseExtractionList(text)).toEqual([
            { note: 'say "hi" }', amount: 20 },
            { amount: 30 },
        ]);
    });
    it("skips ONE malformed object without losing the others", () => {
        const text = '[{"amount":20},{"amount":},{"amount":30}]';
        expect(parseExtractionList(text)).toEqual([{ amount: 20 }, { amount: 30 }]);
    });
    it("still returns undefined for an array with no object elements", () => {
        expect(parseExtractionList("[1, 2, 3]")).toBeUndefined();
    });
    it("returns undefined when there is no JSON at all", () => {
        expect(parseExtractionList("no json here")).toBeUndefined();
    });

    it.each([31, 32])(
        "posts the valid %i-candidate boundary as one exact multi-entry card",
        async (count) => {
            const raw = JSON.stringify(
                Array.from({ length: count }, (_, i) => ({ amount: i + 1, note: `entry-${i}` })),
            );
            expect(parseExtractionList(raw)).toHaveLength(count);
            const result = await runAiAction(MULTI_DEF, { text: "many" }, RECIPIENT, async () => ({
                kind: "ok",
                text: raw,
            }));
            expect(result.kind).toBe("ready_multi");
            if (result.kind === "ready_multi") {
                expect(result.extracted).toHaveLength(count);
                expect(result.card.rows).toHaveLength(count);
                expect(JSON.parse(new TextDecoder().decode(result.card.confirmPayload!))).toEqual(
                    JSON.parse(raw),
                );
                expect(result.card.rows.some((row) => row.label.startsWith("__oc_"))).toBe(false);
            }
        },
    );

    it("stops at a 33rd overflow sentinel and rejects before per-candidate work", async () => {
        const entries = Array.from({ length: MAX_AI_ACTION_CANDIDATES + 1 }, (_, i) => ({
            amount: i + 1,
        }));
        const raw = JSON.stringify({ transactions: entries });
        expect(parseExtractionList(raw)).toHaveLength(MAX_AI_ACTION_CANDIDATES + 1);
        const result = await runAiAction(MULTI_DEF, { text: "many" }, RECIPIENT, async () => ({
            kind: "ok",
            text: raw,
        }));
        expect(result).toEqual({
            kind: "error",
            error: `The model returned more than ${MAX_AI_ACTION_CANDIDATES} action candidates.`,
        });
    });

    it("rejects oversized model output without scanning it", () => {
        expect(parseExtractionList(`{"amount":1}${" ".repeat(131_072)}`)).toBeUndefined();
    });
});

describe("parseExtraction", () => {
    it("parses a bare JSON object", () => {
        expect(parseExtraction('{"amount":20,"currency":"USD"}')).toEqual({
            amount: 20,
            currency: "USD",
        });
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
        const withInbox = buildActionCardContent(
            DEF,
            { amount: 1, currency: "USD" },
            RECIPIENT,
            "aaaaa-aa",
        );
        expect(withInbox.inboxCanisterId).toBe("aaaaa-aa");
        const withoutInbox = buildActionCardContent(DEF, { amount: 1, currency: "USD" }, RECIPIENT);
        expect(withoutInbox.inboxCanisterId).toBeUndefined();
    });
    it("fan-out: carries additional recipient keys, dropping empties and the primary key", () => {
        const card = buildActionCardContent(
            DEF,
            { amount: 1, currency: "USD" },
            RECIPIENT,
            undefined,
            [
                "OTHER_KEY_PEM",
                "", // empty entries are dropped
                RECIPIENT, // the primary key never repeats in the fan-out list
                "SECOND_OTHER_KEY_PEM",
            ],
        );
        expect(card.recipientPublicKey).toBe(RECIPIENT);
        expect(card.recipientPublicKeys).toEqual(["OTHER_KEY_PEM", "SECOND_OTHER_KEY_PEM"]);
    });
    it("fan-out: recipientPublicKeys is undefined when no additional keys are supplied", () => {
        const card = buildActionCardContent(DEF, { amount: 1, currency: "USD" }, RECIPIENT);
        expect(card.recipientPublicKeys).toBeUndefined();
    });
    it("single-entry card carries no reserved transport row", () => {
        const card = buildActionCardContent(
            DEF,
            { amount: 20, currency: "USD", note: "lunch" },
            RECIPIENT,
        );
        expect(card.rows.some((r) => r.label.startsWith("__oc_"))).toBe(false);
    });
    it("bakes the owning appId onto the card (undefined when omitted)", () => {
        const withApp = buildActionCardContent(
            DEF,
            { amount: 1, currency: "USD" },
            RECIPIENT,
            undefined,
            undefined,
            42,
        );
        expect(withApp.appId).toBe(42);
        const withoutApp = buildActionCardContent(DEF, { amount: 1, currency: "USD" }, RECIPIENT);
        expect(withoutApp.appId).toBeUndefined();
    });
});

describe("runAiAction", () => {
    const okInfer =
        (text: string) =>
        async (_req: InferenceRequest): Promise<InferenceResult> => ({ kind: "ok", text });

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
    // The browser backend appends request.text to request.prompt, and the prompt ALREADY carries the
    // message (the native runtime reads only `prompt`). Passing both sent the model the same message
    // twice and it extracted some transactions twice — "owe me 300 uber 150 food" came back with 300
    // repeated. Native never saw it, so it read like small-model flakiness.
    it("sends the message EXACTLY ONCE — inlined in the prompt, never also as `text`", async () => {
        const seen: InferenceRequest[] = [];
        const capture = async (req: InferenceRequest): Promise<InferenceResult> => {
            seen.push(req);
            return { kind: "ok", text: '{"amount":20,"currency":"USD","note":"lunch"}' };
        };
        const message = "owe me 300 uber 150 food";
        await runAiAction(DEF, { text: message }, RECIPIENT, capture);

        expect(seen).toHaveLength(1);
        // No `text` field at all: anything that concatenates prompt+text cannot double the message.
        expect(seen[0].text).toBeUndefined();
        expect(seen[0].prompt).toContain(message);
        expect(seen[0].prompt.split(message).length - 1).toBe(1);
    });

    it("does not add undeclared date context to text input", async () => {
        let seen: InferenceRequest | undefined;
        await runAiAction(DEF, { text: "paid 20 today" }, RECIPIENT, async (req) => {
            seen = req;
            return { kind: "ok", text: '{"amount":20,"currency":"USD"}' };
        });

        expect(seen?.prompt).toBe(`${DEF.promptTemplate}\n\nMessage:\npaid 20 today`);
        expect(seen?.prompt).not.toContain("Today is ");
    });

    it("propagates unavailable (no autonomous fallback)", async () => {
        const r = await runAiAction(DEF, {}, RECIPIENT, async () => ({
            kind: "unavailable",
            reason: "no native runtime",
        }));
        expect(r.kind).toBe("unavailable");
    });
    it("reports no_extraction when the model returns no JSON", async () => {
        const r = await runAiAction(DEF, {}, RECIPIENT, okInfer("I couldn't find a transaction."));
        expect(r.kind).toBe("no_extraction");
    });
    it("passes the declared prompt + image to the model, but NOT the response schema", async () => {
        let seen: InferenceRequest | undefined;
        await runAiAction(
            { ...DEF, acceptsImage: true },
            { image: new Uint8Array([1, 2, 3]) },
            RECIPIENT,
            async (req) => {
                seen = req;
                return { kind: "ok", text: "{}" };
            },
        );
        // Image pixels are the only evidence. OpenChat must not inject a date that the model can
        // mistake for text visible in the image.
        expect(seen?.prompt).toBe(DEF.promptTemplate);
        expect(seen?.prompt).not.toContain("Today is ");
        // The schema is enforced deterministically AFTER generation (conformToSchema), NOT as a
        // generation-time grammar constraint — constrained decoding collapses number fields (e.g. amount)
        // to a degenerate 0 on small models. So the model must NOT receive the schema.
        expect(seen?.responseSchema).toBeUndefined();
        expect(seen?.image).toEqual(new Uint8Array([1, 2, 3]));
    });

    it("omits from_message guidance for image-only input while retaining applicable rules", async () => {
        const def: AiActionDefinition = {
            ...DEF,
            acceptsImage: true,
            rules: [
                { kind: "instruction", text: "Return one object." },
                { kind: "from_message", field: "note" },
                {
                    kind: "keyword_map",
                    field: "category",
                    mode: "override",
                    map: [{ value: "travel", keywords: ["hotel"] }],
                },
            ],
        };
        let seen: InferenceRequest | undefined;
        await runAiAction(def, { image: new Uint8Array([1, 2, 3]) }, RECIPIENT, async (req) => {
            seen = req;
            return { kind: "ok", text: '{"amount":20,"currency":"USD"}' };
        });

        expect(seen?.prompt).toContain("Return one object.");
        expect(seen?.prompt).toContain(
            'Set "category" to "travel" when the message mentions any of: hotel',
        );
        expect(seen?.prompt).not.toContain('Set "note" to a short phrase taken from the message.');
    });

    it.each([
        ["text", { text: "hotel receipt" }],
        ["mixed image + text", { image: new Uint8Array([1, 2, 3]), text: "hotel receipt" }],
    ])("retains from_message guidance for %s input", async (_label, input) => {
        const def: AiActionDefinition = {
            ...DEF,
            acceptsImage: true,
            rules: [{ kind: "from_message", field: "note" }],
        };
        let seen: InferenceRequest | undefined;
        await runAiAction(def, input, RECIPIENT, async (req) => {
            seen = req;
            return { kind: "ok", text: '{"amount":20,"currency":"USD"}' };
        });

        expect(seen?.prompt).toContain('Set "note" to a short phrase taken from the message.');
    });

    it("adds declared date context to mixed image + nonempty text input", async () => {
        const def: AiActionDefinition = {
            ...DEF,
            acceptsImage: true,
            rules: [{ kind: "context", provide: ["today"] }],
        };
        let seen: InferenceRequest | undefined;
        await runAiAction(
            def,
            { image: new Uint8Array([1, 2, 3]), text: "due tomorrow" },
            RECIPIENT,
            async (req) => {
                seen = req;
                return { kind: "ok", text: '{"amount":20,"currency":"USD"}' };
            },
        );

        const today = formatLocalCalendarDate(new Date());
        expect(seen?.prompt).toBe(
            `${DEF.promptTemplate}\n\nToday is ${today}.\n\nMessage:\ndue tomorrow`,
        );
        expect(seen?.image).toEqual(new Uint8Array([1, 2, 3]));
    });

    it("formats the user's local calendar components without a UTC conversion", () => {
        expect(
            formatLocalCalendarDate({
                getFullYear: () => 2026,
                getMonth: () => 7,
                getDate: () => 9,
            }),
        ).toBe("2026-08-09");
    });

    it.each([undefined, "", "   "])(
        "does not add declared date context without nonempty text (%s)",
        async (text) => {
            const def: AiActionDefinition = {
                ...DEF,
                acceptsImage: true,
                rules: [{ kind: "context", provide: ["today"] }],
            };
            let seen: InferenceRequest | undefined;
            await runAiAction(
                def,
                { image: new Uint8Array([1, 2, 3]), text },
                RECIPIENT,
                async (req) => {
                    seen = req;
                    return { kind: "ok", text: '{"amount":20,"currency":"USD"}' };
                },
            );

            expect(seen?.prompt).toBe(DEF.promptTemplate);
            expect(seen?.prompt).not.toContain("Today is ");
        },
    );

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
                // normalize is deterministic and context is emitted separately: neither adds a
                // Rules-block prompt line.
                { kind: "normalize", field: "amount", ops: ["k_m_suffix"] },
                { kind: "context", provide: ["today"] },
            ],
        };
        let seen: InferenceRequest | undefined;
        await runAiAction(def, { text: "paid for a flight" }, RECIPIENT, async (req) => {
            seen = req;
            return { kind: "ok", text: "{}" };
        });
        const today = formatLocalCalendarDate(new Date());
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
            const payload = JSON.parse(new TextDecoder().decode(r.card.confirmPayload!)) as Record<
                string,
                unknown
            >;
            expect(payload.category).toBe("travel");
        }
    });

    it.each([undefined, "", "   "])(
        "maps image-extracted string evidence with blank source text (%s) before enforcing an enum schema",
        async (text) => {
            const def: AiActionDefinition = {
                ...DEF,
                acceptsImage: true,
                responseSchema: {
                    type: "object",
                    required: ["amount", "direction"],
                    properties: {
                        amount: { type: "number" },
                        direction: { type: "string", enum: ["credit", "debt"] },
                        message: { type: "string" },
                    },
                },
                card: {
                    ...DEF.card,
                    rows: [
                        { label: "Amount", valueKey: "amount" },
                        { label: "Direction", valueKey: "direction" },
                    ],
                },
                rules: [
                    {
                        kind: "keyword_map",
                        field: "direction",
                        mode: "override",
                        map: [
                            { value: "credit", keywords: ["owed to you"] },
                            { value: "debt", keywords: ["you owe"] },
                        ],
                    },
                ],
            };

            const result = await runAiAction(
                def,
                { image: new Uint8Array([1, 2, 3]), text },
                RECIPIENT,
                okInfer(
                    '{"amount":350,"direction":"owed to you","message":"Cleaning fee owed to you"}',
                ),
            );

            expect(result.kind).toBe("ready");
            if (result.kind === "ready") {
                expect(result.extracted.direction).toBe("credit");
                expect(result.card.rows).toContainEqual({ label: "Direction", value: "credit" });
            }
        },
    );

    describe("image-only response-schema omissions", () => {
        const omissionDef = (annotation: unknown = true): AiActionDefinition => ({
            ...DEF,
            acceptsImage: true,
            responseSchema: {
                type: "object",
                properties: {
                    amount: { type: "number" },
                    unstable: {
                        type: "string",
                        "x-openchat-omit-for-image-only": annotation,
                    },
                    retainedDate: { type: "string", format: "date" },
                },
                required: ["amount"],
            },
            card: {
                ...DEF.card,
                rows: [
                    { label: "Amount", valueKey: "amount" },
                    { label: "Unstable", valueKey: "unstable" },
                    { label: "Retained date", valueKey: "retainedDate" },
                ],
            },
        });

        it.each([undefined, "", "   "])(
            "removes only an opted-in property for image input with blank text (%s)",
            async (text) => {
                const result = await runAiAction(
                    omissionDef(),
                    { image: new Uint8Array([1, 2, 3]), text },
                    RECIPIENT,
                    okInfer('{"amount":20,"unstable":"model guess","retainedDate":"2026-08-09"}'),
                );

                expect(result.kind).toBe("ready");
                if (result.kind === "ready") {
                    expect(result.extracted).toEqual({
                        amount: 20,
                        retainedDate: "2026-08-09",
                    });
                    expect(result.card.rows).toEqual([
                        { label: "Amount", value: "20" },
                        { label: "Retained date", value: "2026-08-09" },
                    ]);
                    expect(
                        JSON.parse(new TextDecoder().decode(result.card.confirmPayload!)),
                    ).toEqual(result.extracted);
                }
            },
        );

        it.each([
            ["text-only", { text: "source says the value" }],
            [
                "mixed image + nonblank text",
                { image: new Uint8Array([1, 2, 3]), text: "source says the value" },
            ],
        ])("retains an opted-in property for %s input", async (_label, input) => {
            const result = await runAiAction(
                omissionDef(),
                input,
                RECIPIENT,
                okInfer('{"amount":20,"unstable":"source value"}'),
            );

            expect(result.kind).toBe("ready");
            if (result.kind === "ready") {
                expect(result.extracted.unstable).toBe("source value");
                expect(result.card.rows).toContainEqual({
                    label: "Unstable",
                    value: "source value",
                });
            }
        });

        it.each([false, "true", 1, null])(
            "ignores a malformed or disabled annotation (%s)",
            async (annotation) => {
                const result = await runAiAction(
                    omissionDef(annotation),
                    { image: new Uint8Array([1, 2, 3]) },
                    RECIPIENT,
                    okInfer('{"amount":20,"unstable":"keep me"}'),
                );

                expect(result.kind).toBe("ready");
                if (result.kind === "ready") {
                    expect(result.extracted.unstable).toBe("keep me");
                }
            },
        );

        it("fails closed when an image-only omitted property is required", async () => {
            const def = omissionDef();
            (def.responseSchema as { required: string[] }).required.push("unstable");

            const result = await runAiAction(
                def,
                { image: new Uint8Array([1, 2, 3]) },
                RECIPIENT,
                okInfer('{"amount":20,"unstable":"model guess"}'),
            );

            expect(result).toMatchObject({
                kind: "incomplete_extraction",
                missingFields: ["unstable"],
                candidateCount: 1,
                validCandidateCount: 0,
            });
        });

        it("applies independently to every model-produced entry without mutating the schema or source data", async () => {
            const def = omissionDef();
            const schemaBefore = structuredClone(def.responseSchema);
            const source = [
                { amount: 20, unstable: "first", retainedDate: "2026-08-09" },
                { amount: 30, unstable: "second", retainedDate: "2026-08-10" },
            ];
            const sourceBefore = structuredClone(source);

            const result = await runAiAction(
                def,
                { image: new Uint8Array([1, 2, 3]) },
                RECIPIENT,
                okInfer(JSON.stringify(source)),
            );

            expect(result.kind).toBe("ready_multi");
            if (result.kind === "ready_multi") {
                expect(result.extracted).toEqual([
                    { amount: 20, retainedDate: "2026-08-09" },
                    { amount: 30, retainedDate: "2026-08-10" },
                ]);
                expect(JSON.parse(new TextDecoder().decode(result.card.confirmPayload!))).toEqual(
                    result.extracted,
                );
            }
            expect(def.responseSchema).toEqual(schemaBefore);
            expect(source).toEqual(sourceBefore);
        });
    });

    it("from_message fills the field from the message text", async () => {
        const def: AiActionDefinition = {
            ...DEF,
            rules: [{ kind: "from_message", field: "note", maxLength: 10 }],
        };
        const r = await runAiAction(
            def,
            { text: "  team lunch at noon  " },
            RECIPIENT,
            okInfer('{"amount":20}'),
        );
        expect(r.kind).toBe("ready");
        if (r.kind === "ready") {
            // trimmed, then truncated to maxLength
            expect(r.extracted.note).toBe("team lunch");
            const payload = JSON.parse(new TextDecoder().decode(r.card.confirmPayload!)) as Record<
                string,
                unknown
            >;
            expect(payload.note).toBe("team lunch");
        }
    });

    it("k_m_suffix normalization turns '26k' into 26000", async () => {
        const def: AiActionDefinition = {
            ...DEF,
            rules: [{ kind: "normalize", field: "amount", ops: ["k_m_suffix"] }],
        };
        const r = await runAiAction(
            def,
            { text: "spent 26k" },
            RECIPIENT,
            okInfer('{"amount":"26k"}'),
        );
        expect(r.kind).toBe("ready");
        if (r.kind === "ready") {
            expect(r.extracted.amount).toBe(26000);
        }
    });

    it("reports an incomplete extraction when a required amount violates its schema", async () => {
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
        expect(r.kind).toBe("incomplete_extraction");
        if (r.kind === "incomplete_extraction") {
            expect(r.raw).toBe(raw);
            expect(r.missingFields).toEqual(["amount"]);
            expect(r.candidateCount).toBe(1);
            expect(r.validCandidateCount).toBe(0);
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
        const r = await runAiAction(
            def,
            { text: "paid 20" },
            RECIPIENT,
            okInfer('{"amount":20,"currency":"???"}'),
        );
        expect(r.kind).toBe("ready");
        if (r.kind === "ready") {
            // Visible omission beats silent wrongness: the enum-violating field is deleted.
            expect(r.extracted).toEqual({ amount: 20 });
            expect(r.card.rows.map((row) => row.label)).toEqual(["Amount"]);
        }
    });

    it("rules-free definitions preserve extraction behavior without adding context", async () => {
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
        // No Rules block in the prompt...
        expect(seen?.prompt).toBe(`${DEF.promptTemplate}\n\nMessage:\nI paid $20 USD for lunch`);
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

    it("fails the whole multi proposal when one element is degenerate", async () => {
        const raw =
            '[{"amount":20,"currency":"USD","note":"lunch"},' +
            '{"amount":0,"currency":"USD"},' +
            '{"amount":30,"currency":"EUR","note":"dinner"}]';
        const r = await runAiAction(
            MULTI_DEF,
            { text: "two expenses and a bad one" },
            RECIPIENT,
            okInfer(raw),
        );
        expect(r.kind).toBe("incomplete_extraction");
        if (r.kind === "incomplete_extraction") {
            expect(r.missingFields).toEqual(["amount"]);
            expect(r.candidateCount).toBe(3);
            expect(r.validCandidateCount).toBe(2);
        }
    });

    it("accepts the exact multi-card title boundary and rejects the first character beyond it", async () => {
        const run = (title: string) =>
            runAiAction(
                { ...MULTI_DEF, card: { ...MULTI_DEF.card, title } },
                { text: "two" },
                RECIPIENT,
                okInfer('[{"amount":1},{"amount":2}]'),
            );
        // `buildMultiActionCardContent` appends ` (2 entries)` (12 characters).
        const atBoundary = await run("T".repeat(MAX_AI_ACTION_CARD_TITLE_CHARS - 12));
        expect(atBoundary.kind).toBe("ready_multi");

        const overflow = await run("T".repeat(MAX_AI_ACTION_CARD_TITLE_CHARS - 11));
        expect(overflow).toEqual({
            kind: "error",
            error: `The multi-entry card title exceeds ${MAX_AI_ACTION_CARD_TITLE_CHARS} characters.`,
        });
    });

    it("accepts the exact summary-row boundary and rejects the first character beyond it", async () => {
        const prefix = "Amount: 1 · Note: ";
        const run = (noteLength: number) =>
            runAiAction(
                MULTI_DEF,
                { text: "two" },
                RECIPIENT,
                okInfer(
                    JSON.stringify([
                        { amount: 1, note: "x".repeat(noteLength) },
                        { amount: 2, note: "ok" },
                    ]),
                ),
            );
        const atBoundary = await run(MAX_AI_ACTION_CARD_ROW_VALUE_CHARS - prefix.length);
        expect(atBoundary.kind).toBe("ready_multi");

        const overflow = await run(MAX_AI_ACTION_CARD_ROW_VALUE_CHARS - prefix.length + 1);
        expect(overflow).toEqual({
            kind: "error",
            error: `A multi-entry card summary exceeds ${MAX_AI_ACTION_CARD_ROW_VALUE_CHARS} characters.`,
        });
    });

    it("accepts a 16 KiB exact array and rejects 16 KiB + 1 before provenance", async () => {
        const def: AiActionDefinition = {
            ...MULTI_DEF,
            responseSchema: {
                type: "object",
                properties: {
                    amount: { type: "number", exclusiveMinimum: 0 },
                    opaque: { type: "string" },
                },
                required: ["amount"],
            },
            card: {
                ...MULTI_DEF.card,
                rows: [{ label: "Amount", valueKey: "amount" }],
            },
        };
        const rawWithPayloadBytes = (target: number): string => {
            const empty = JSON.stringify([{ amount: 1, opaque: "" }, { amount: 2 }]);
            const overhead = new TextEncoder().encode(empty).byteLength;
            return JSON.stringify([
                { amount: 1, opaque: "x".repeat(target - overhead) },
                { amount: 2 },
            ]);
        };
        const atBoundary = await runAiAction(
            def,
            { text: "two" },
            RECIPIENT,
            okInfer(rawWithPayloadBytes(MAX_AI_APP_CONFIRM_PAYLOAD_BYTES)),
        );
        expect(atBoundary.kind).toBe("ready_multi");
        if (atBoundary.kind === "ready_multi") {
            expect(atBoundary.card.confirmPayload).toHaveLength(MAX_AI_APP_CONFIRM_PAYLOAD_BYTES);
            // `opaque` is exact app payload, not a manifest-declared public row.
            expect(JSON.stringify(atBoundary.card.rows)).not.toContain("opaque");
            expect(JSON.stringify(atBoundary.card.rows)).not.toContain("xxxx");
        }

        const overflow = await runAiAction(
            def,
            { text: "two" },
            RECIPIENT,
            okInfer(rawWithPayloadBytes(MAX_AI_APP_CONFIRM_PAYLOAD_BYTES + 1)),
        );
        expect(overflow).toEqual({
            kind: "error",
            error: `The multi-entry confirmation payload exceeds ${MAX_AI_APP_CONFIRM_PAYLOAD_BYTES} bytes.`,
        });
    });

    it("does not collapse a partial ARRAY into a misleading single-entry card", async () => {
        const raw = '[{"amount":0,"currency":"USD"},{"amount":42,"currency":"USD","note":"taxi"}]';
        const r = await runAiAction(
            MULTI_DEF,
            { text: "one good one bad" },
            RECIPIENT,
            okInfer(raw),
        );
        expect(r.kind).toBe("incomplete_extraction");
        if (r.kind === "incomplete_extraction") {
            expect(r.missingFields).toEqual(["amount"]);
            expect(r.candidateCount).toBe(2);
            expect(r.validCandidateCount).toBe(1);
        }
    });

    it("an all-invalid ARRAY reports the required fields that failed", async () => {
        const raw = '[{"amount":0,"currency":"USD"},{"currency":"EUR"}]';
        const r = await runAiAction(MULTI_DEF, { text: "nothing usable" }, RECIPIENT, okInfer(raw));
        expect(r.kind).toBe("incomplete_extraction");
        if (r.kind === "incomplete_extraction") {
            expect(r.raw).toBe(raw);
            expect(r.missingFields).toEqual(["amount"]);
            expect(r.candidateCount).toBe(2);
            expect(r.validCandidateCount).toBe(0);
        }
    });
});

describe("buildMultiActionCardContent", () => {
    const entries = [
        { amount: 20, currency: "USD", note: "lunch" },
        { amount: 30, currency: "EUR", note: "dinner" },
    ];
    it("builds public summary rows without placing the exact array in a hidden row", () => {
        const card = buildMultiActionCardContent(DEF, entries, RECIPIENT);
        expect(card.kind).toBe("action_card_content");
        expect(card.actionId).toBe(DEF.name);
        expect(card.title).toContain("2");
        expect(card.rows).toEqual([
            { label: "Entry 1", value: "Amount: 20 · Currency: USD · Note: lunch" },
            { label: "Entry 2", value: "Amount: 30 · Currency: EUR · Note: dinner" },
        ]);
        expect(JSON.parse(new TextDecoder().decode(card.confirmPayload!))).toEqual(entries);
    });
    it("never copies the send-only exact payload into public rows", () => {
        const card = buildMultiActionCardContent(DEF, entries, RECIPIENT);
        expect(card.rows.some((r) => r.label.startsWith("__oc_"))).toBe(false);
        expect(
            card.rows.some((r) => r.value === new TextDecoder().decode(card.confirmPayload!)),
        ).toBe(false);
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

    it("rejects a card whose individually valid rows exceed the aggregate 64 KiB bound", () => {
        const card = buildMultiActionCardContent(DEF, entries, RECIPIENT);
        const withinAggregate = {
            ...card,
            rows: Array.from({ length: 15 }, (_, index) => ({
                label: `Entry ${index + 1}`,
                value: "x".repeat(4_090),
            })),
            confirmPayload: new TextEncoder().encode("[{},{}]"),
        };
        expect(multiActionCardBoundsError(withinAggregate)).toBeUndefined();

        const overflow = {
            ...withinAggregate,
            rows: [...withinAggregate.rows, { label: "Entry 16", value: "x".repeat(4_090) }],
        };
        expect(multiActionCardBoundsError(overflow)).toMatch(/64 KiB/);
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

    it("omits only from_message guidance when no message text is available", () => {
        const rules: AiActionRule[] = [
            { kind: "instruction", text: "Use visible evidence." },
            { kind: "from_message", field: "note" },
            {
                kind: "keyword_map",
                field: "category",
                mode: "override",
                map: [{ value: "travel", keywords: ["hotel"] }],
            },
        ];

        expect(compileRules(rules, { hasMessageText: false })).toEqual([
            "Use visible evidence.",
            'Set "category" to "travel" when the message mentions any of: hotel',
        ]);
    });
});

describe("applyRulesPostPass", () => {
    it("keyword_map hint mode never touches the extraction", () => {
        const rules: AiActionRule[] = [
            {
                kind: "keyword_map",
                field: "category",
                mode: "hint",
                map: [{ value: "travel", keywords: ["hotel"] }],
            },
        ];
        expect(applyRulesPostPass(rules, { category: "food" }, "a hotel stay")).toEqual({
            category: "food",
        });
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

    it("supports specific direction phrases before a bare owe shorthand fallback", () => {
        const rules: AiActionRule[] = [
            {
                kind: "keyword_map",
                field: "direction",
                mode: "override",
                map: [
                    { value: "credit", keywords: ["you owe", "owe me", "owes me"] },
                    { value: "debt", keywords: ["i owe", "owe you", "owe"] },
                ],
            },
        ];
        const directionFor = (message: string) =>
            applyRulesPostPass(rules, {}, message).direction;

        expect(directionFor("owe 200 uber")).toBe("debt");
        expect(directionFor("I owe you 200 for Uber")).toBe("debt");
        expect(directionFor("You owe me 200 for Uber")).toBe("credit");
        expect(directionFor("you owe 200 for Uber")).toBe("credit");
    });

    // The override is deterministic and unarguable — neither the model nor the user gets a say — so a
    // keyword that fires INSIDE another word silently mislabels the entry. A ledger app can register
    // the bare keyword "owe" while expecting OpenChat to match on word boundaries, which was
    // only ever true of the auto-propose chip), so under substring matching every message containing
    // "power", "shower" or "flower" came out force-classified as kind "debt".
    describe("keyword_map override matches WHOLE WORDS", () => {
        const rules: AiActionRule[] = [
            {
                kind: "keyword_map",
                field: "kind",
                mode: "override",
                map: [{ value: "debt", keywords: ["owe", "owed", "owes"] }],
            },
        ];
        const kindFor = (message: string) => applyRulesPostPass(rules, {}, message).kind;

        it("does not fire inside a longer word", () => {
            expect(kindFor("I lost power yesterday")).toBeUndefined();
            expect(kindFor("the shower is broken")).toBeUndefined();
            expect(kindFor("bought her a flower")).toBeUndefined();
        });

        it("still fires on the real word, wherever it sits and however it is cased", () => {
            expect(kindFor("Owe me 300 uber")).toBe("debt");
            expect(kindFor("you owe me")).toBe("debt");
            expect(kindFor("owes")).toBe("debt");
            // Punctuation is a boundary, not a mismatch — otherwise the fix just trades one silent
            // misclassification for a silent miss.
            expect(kindFor("he owed, then paid")).toBe("debt");
            expect(kindFor("(owe) 300")).toBe("debt");
        });
    });

    describe("keyword_map override for image-extracted text evidence", () => {
        const rules: AiActionRule[] = [
            {
                kind: "keyword_map",
                field: "kind",
                mode: "override",
                map: [
                    { value: "credit", keywords: ["owed to you", "receivable"] },
                    { value: "debt", keywords: ["you owe", "owe"] },
                ],
            },
        ];
        const withImage = { hasImage: true };

        it.each([
            ["raw target field", { kind: "owed to you" }],
            ["message field", { kind: "unknown", message: "This is owed to you" }],
            ["note field", { kind: "unknown", note: "Account receivable" }],
            ["another extracted string field", { kind: "unknown", details: "you owe this" }],
        ])("scans the %s", (_label, extracted) => {
            expect(applyRulesPostPass(rules, extracted, undefined, undefined, withImage).kind).toBe(
                _label === "another extracted string field" ? "debt" : "credit",
            );
        });

        it("preserves whole-word matching for extracted strings", () => {
            expect(
                applyRulesPostPass(
                    rules,
                    { kind: "unknown", note: "The power is out" },
                    undefined,
                    undefined,
                    withImage,
                ).kind,
            ).toBe("unknown");
        });

        it("keeps first-mapping-wins order when image evidence contains competing keywords", () => {
            expect(
                applyRulesPostPass(
                    rules,
                    { kind: "unknown", message: "you owe; this is also owed to you" },
                    undefined,
                    undefined,
                    withImage,
                ).kind,
            ).toBe("credit");
        });

        it("uses a deterministic priority independent of extracted object key order", () => {
            const first = {
                filler: "x".repeat(10_000),
                note: "owed to you",
                kind: "unknown",
            };
            const second = {
                kind: "unknown",
                note: "owed to you",
                filler: "x".repeat(10_000),
            };

            expect(applyRulesPostPass(rules, first, undefined, undefined, withImage).kind).toBe(
                "credit",
            );
            expect(applyRulesPostPass(rules, second, undefined, undefined, withImage).kind).toBe(
                "credit",
            );
        });

        it("bounds the aggregate extracted-string scan", () => {
            const atBoundary = { note: `${"x".repeat(9_996)} owe` };
            const afterBoundary = { note: `${"x".repeat(9_997)} owe` };

            expect(
                applyRulesPostPass(rules, atBoundary, undefined, undefined, withImage).kind,
            ).toBe("debt");
            expect(
                applyRulesPostPass(rules, afterBoundary, undefined, undefined, withImage).kind,
            ).toBeUndefined();
        });

        it("does not scan extracted strings without an image source", () => {
            expect(applyRulesPostPass(rules, { kind: "owed to you" }, undefined).kind).toBe(
                "owed to you",
            );
        });

        it("keeps source text authoritative when both text and image are present", () => {
            expect(
                applyRulesPostPass(
                    rules,
                    { kind: "unknown", note: "owed to you" },
                    "you owe this",
                    undefined,
                    withImage,
                ).kind,
            ).toBe("debt");
            expect(
                applyRulesPostPass(
                    rules,
                    { kind: "unknown", note: "owed to you" },
                    "no declared keyword here",
                    undefined,
                    withImage,
                ).kind,
            ).toBe("unknown");
        });
    });

    it("skips message-driven rules when there is no message text", () => {
        const rules: AiActionRule[] = [
            { kind: "from_message", field: "note" },
            {
                kind: "keyword_map",
                field: "category",
                mode: "override",
                map: [{ value: "a", keywords: ["b"] }],
            },
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
        expect(applyRulesPostPass(rules, { amount: "1.5m" }, undefined)).toEqual({
            amount: 1500000,
        });
        expect(applyRulesPostPass(rules, { amount: "1,500 k" }, undefined)).toEqual({
            amount: 1500000,
        });
        expect(applyRulesPostPass(rules, { amount: "42" }, undefined)).toEqual({ amount: 42 });
        expect(applyRulesPostPass(rules, { amount: 42 }, undefined)).toEqual({ amount: 42 });
        expect(applyRulesPostPass(rules, { amount: "not a number" }, undefined)).toEqual({
            amount: "not a number",
        });
        // A currency code the model folded into the amount is tolerated — the LEADING number is
        // recovered so it survives the number-typed schema field instead of being dropped as a string.
        expect(applyRulesPostPass(rules, { amount: "2000 usd" }, undefined)).toEqual({
            amount: 2000,
        });
        expect(applyRulesPostPass(rules, { amount: "2000usd" }, undefined)).toEqual({
            amount: 2000,
        });
        expect(applyRulesPostPass(rules, { amount: "2.5m dollars" }, undefined)).toEqual({
            amount: 2500000,
        });
    });
    it("recovers a model-folded currency amount ('2000 usd') through normalize + schema conformance", () => {
        // Repro of the "invalid draft / amount set to 0" report: the model emitted amount as the string
        // "2000 usd". Without the leading-number normalize it stays a string, the number-typed schema
        // field drops it, and the consumer app gets no amount -> "invalid draft" + amount 0. With the
        // k_m_suffix normalize the leading number is recovered and kept.
        const schema = {
            type: "object",
            properties: { amount: { type: "number" }, currency: { type: "string" } },
        };
        const rules: AiActionRule[] = [{ kind: "normalize", field: "amount", ops: ["k_m_suffix"] }];
        expect(
            applyRulesPostPass(rules, { amount: "2000 usd", currency: "USD" }, undefined, schema),
        ).toEqual({
            amount: 2000,
            currency: "USD",
        });
    });
    it("normalize strip_symbols removes currency symbols/commas/spaces and parses numerics", () => {
        const rules: AiActionRule[] = [
            { kind: "normalize", field: "amount", ops: ["strip_symbols"] },
        ];
        expect(applyRulesPostPass(rules, { amount: "$1,299.50" }, undefined)).toEqual({
            amount: 1299.5,
        });
        expect(applyRulesPostPass(rules, { amount: "€ 20" }, undefined)).toEqual({ amount: 20 });
    });
    it("normalize applies string ops in order and skips absent fields", () => {
        const rules: AiActionRule[] = [
            { kind: "normalize", field: "code", ops: ["trim", "uppercase"] },
            { kind: "normalize", field: "missing", ops: ["lowercase"] },
        ];
        expect(applyRulesPostPass(rules, { code: "  usd " }, undefined)).toEqual({ code: "USD" });
    });
    it("schema conformance drops undeclared, type-violating, and patterned fields", () => {
        const schema = {
            type: "object",
            properties: {
                amount: { type: "number" },
                code: { type: "string", pattern: "^[A-Z]{3}$" },
            },
        };
        expect(
            applyRulesPostPass([], { amount: "20", code: "USD", extra: 1 }, undefined, schema),
        ).toEqual({});
        expect(applyRulesPostPass([], { amount: 20, code: "usd" }, undefined, schema)).toEqual({
            amount: 20,
        });
    });
    it("never executes a catastrophic manifest regex", () => {
        const schema = {
            type: "object",
            properties: {
                unsafe: { type: "string", pattern: "(a+)+$" },
                amount: { type: "number" },
            },
        };
        const started = performance.now();
        expect(
            applyRulesPostPass(
                [],
                { unsafe: `${"a".repeat(50_000)}!`, amount: 5 },
                undefined,
                schema,
            ),
        ).toEqual({ amount: 5 });
        expect(performance.now() - started).toBeLessThan(250);
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
        expect(applyRulesPostPass([], { amount: 0.01 }, undefined, schema)).toEqual({
            amount: 0.01,
        });
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
        expect(applyRulesPostPass([], { amount: -5 }, undefined, undefined)).toEqual({
            amount: -5,
        });
    });
});

describe("postProcessAiActionCandidate", () => {
    const def: AiActionDefinition = {
        ...DEF,
        acceptsImage: true,
        rules: [
            {
                kind: "keyword_map",
                field: "direction",
                mode: "override",
                map: [
                    { value: "credit", keywords: ["owed to you"] },
                    { value: "debt", keywords: ["you owe"] },
                ],
            },
        ],
        responseSchema: {
            type: "object",
            properties: {
                amount: { type: "number", exclusiveMinimum: 0 },
                direction: { type: "string", enum: ["credit", "debt"] },
                date: {
                    type: "string",
                    format: "date",
                    "x-openchat-omit-for-image-only": true,
                },
                message: {
                    type: "string",
                    "x-openchat-omit-for-image-only": true,
                },
            },
            required: ["amount", "direction"],
        },
    };

    it.each([undefined, "", "   "])(
        "maps image evidence and strips date/message when source text is blank (%s)",
        (text) => {
            expect(
                postProcessAiActionCandidate(
                    def,
                    {
                        amount: 350,
                        direction: "owed to you",
                        date: "2026-08-09",
                        message: "Cleaning fee owed to you",
                    },
                    { hasImage: true, text },
                ),
            ).toEqual({ amount: 350, direction: "credit" });
        },
    );

    it("retains annotated values and lets real source text stay authoritative for text input", () => {
        expect(
            postProcessAiActionCandidate(
                def,
                {
                    amount: 350,
                    direction: "owed to you",
                    date: "2026-08-09",
                    message: "model phrase owed to you",
                },
                { text: "you owe this" },
            ),
        ).toEqual({
            amount: 350,
            direction: "debt",
            date: "2026-08-09",
            message: "model phrase owed to you",
        });
    });

    it("makes a required image-only omitted field visibly missing to the caller's fail-closed gate", () => {
        const requiredMessageDef: AiActionDefinition = {
            ...def,
            responseSchema: {
                ...(def.responseSchema as object),
                required: ["amount", "direction", "message"],
            },
        };
        const processed = postProcessAiActionCandidate(
            requiredMessageDef,
            { amount: 350, direction: "owed to you", message: "Cleaning fee owed to you" },
            { hasImage: true },
        );

        expect(processed).toEqual({ amount: 350, direction: "credit" });
        expect(missingRequired(processed, requiredMessageDef.responseSchema)).toEqual(["message"]);
    });

    describe("x-openchat-require-text-evidence", () => {
        const inferOk = (text: string) => async () => ({ kind: "ok" as const, text });
        const currencyDef = (
            annotation: unknown = true,
            required: string[] = ["amount"],
        ): AiActionDefinition => ({
            ...DEF,
            rules: [
                {
                    kind: "keyword_map",
                    field: "currency",
                    mode: "hint",
                    map: [
                        { value: "USD", keywords: ["dollars", "$"] },
                        { value: "EUR", keywords: ["euros", "€"] },
                    ],
                },
            ],
            responseSchema: {
                type: "object",
                properties: {
                    amount: { type: "number", exclusiveMinimum: 0 },
                    currency: {
                        type: "string",
                        enum: ["USD", "EUR", "JPY"],
                        "x-openchat-require-text-evidence": annotation,
                    },
                    note: { type: "string" },
                },
                required,
            },
        });

        it.each([
            ["the direct ISO code", "Paid 20 USD for lunch"],
            ["a whole-word alias", "Paid 20 dollars for lunch"],
            ["a punctuation alias touching the number", "Paid $20 for lunch"],
        ])("retains a normalized claim evidenced by %s", (_label, text) => {
            expect(
                postProcessAiActionCandidate(
                    currencyDef(),
                    { amount: 20, currency: "USD", note: "lunch" },
                    { text },
                ),
            ).toEqual({ amount: 20, currency: "USD", note: "lunch" });
        });

        it.each([
            ["a different direct claim", "Paid 20 EUR for lunch", "USD"],
            ["an unsupported claim", "Paid 20 for lunch", "JPY"],
        ])("deletes %s rather than trusting the model", (_label, text, currency) => {
            expect(
                postProcessAiActionCandidate(
                    currencyDef(),
                    { amount: 20, currency, note: "lunch" },
                    { text },
                ),
            ).toEqual({ amount: 20, note: "lunch" });
        });

        it.each([
            ["image-only", { hasImage: true }],
            ["no source metadata", {}],
            ["empty source text", { text: "" }],
            ["whitespace source text", { text: "   " }],
        ])("preserves the claim when there is no authoritative text: %s", (_label, source) => {
            expect(
                postProcessAiActionCandidate(
                    currencyDef(),
                    { amount: 20, currency: "USD" },
                    source,
                ),
            ).toEqual({ amount: 20, currency: "USD" });
        });

        it.each([false, "true", 1, null, { enabled: true }])(
            "ignores a malformed or disabled annotation (%s)",
            (annotation) => {
                expect(
                    postProcessAiActionCandidate(
                        currencyDef(annotation),
                        { amount: 20, currency: "USD" },
                        { text: "Paid 20 for lunch" },
                    ),
                ).toEqual({ amount: 20, currency: "USD" });
            },
        );

        it("fails closed when evidence deletion makes a required field missing", async () => {
            const result = await runAiAction(
                currencyDef(true, ["amount", "currency"]),
                { text: "Paid 20 for lunch" },
                RECIPIENT,
                inferOk('{"amount":20,"currency":"USD"}'),
            );

            expect(result).toMatchObject({
                kind: "incomplete_extraction",
                missingFields: ["currency"],
                candidateCount: 1,
                validCandidateCount: 0,
            });
        });

        it("removes invented currencies independently from every stored multi-entry payload row", async () => {
            const result = await runAiAction(
                currencyDef(),
                { text: "Lunch cost 20 and dinner cost 30" },
                RECIPIENT,
                inferOk(
                    '[{"amount":20,"currency":"USD","note":"lunch"},' +
                        '{"amount":30,"currency":"EUR","note":"dinner"}]',
                ),
            );

            expect(result.kind).toBe("ready_multi");
            if (result.kind === "ready_multi") {
                const expected = [
                    { amount: 20, note: "lunch" },
                    { amount: 30, note: "dinner" },
                ];
                expect(result.extracted).toEqual(expected);
                expect(JSON.parse(new TextDecoder().decode(result.card.confirmPayload!))).toEqual(
                    expected,
                );
                expect(result.card.rows).toHaveLength(2);
                expect(result.card.rows.some((row) => /USD|EUR/.test(row.value))).toBe(false);
            }
        });

        it("checks only the authoritative source prefix that the app can attest", () => {
            const def = currencyDef();
            def.rules = [
                ...(def.rules ?? []),
                { kind: "from_message", field: "message", maxLength: 200 },
            ];
            def.responseSchema = {
                ...(def.responseSchema as object),
                properties: {
                    ...((def.responseSchema as { properties: object }).properties ?? {}),
                    message: { type: "string", maxLength: 200 },
                },
            };
            const source = `${"x".repeat(205)} USD`;

            expect(
                postProcessAiActionCandidate(
                    def,
                    { amount: 20, currency: "USD" },
                    { text: source },
                ),
            ).toEqual({ amount: 20, message: "x".repeat(200) });
        });

        it("deletes a claim when the declared evidence field cannot survive its schema", () => {
            const def = currencyDef();
            def.rules = [
                ...(def.rules ?? []),
                { kind: "from_message", field: "message", maxLength: 200 },
            ];
            def.responseSchema = {
                ...(def.responseSchema as object),
                properties: {
                    ...((def.responseSchema as { properties: object }).properties ?? {}),
                    message: { type: "string", maxLength: 100 },
                },
            };

            expect(
                postProcessAiActionCandidate(
                    def,
                    { amount: 20, currency: "USD" },
                    { text: `${"x".repeat(150)} USD` },
                ),
            ).toEqual({ amount: 20 });
        });
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

    it("does not satisfy a required field through the prototype chain", () => {
        const inherited = Object.create({ amount: 10 }) as Record<string, unknown>;
        inherited.currency = "USD";
        expect(missingRequired(inherited, schema)).toEqual(["amount"]);
    });

    it("treats forbidden required names as unsatisfied", () => {
        expect(
            missingRequired({ amount: 1 }, { required: ["amount", "__proto__", "constructor"] }),
        ).toEqual(["__proto__", "constructor"]);
    });
});

describe("untrusted extraction field integrity", () => {
    it("drops prototype keys and returns a null-prototype own-property map", () => {
        const extraction = JSON.parse(
            '{"amount":10,"note":"rent","__proto__":{"admin":true},"constructor":"evil"}',
        ) as Record<string, unknown>;
        const conformed = applyRulesPostPass([], extraction, undefined);
        expect(Object.getPrototypeOf(conformed)).toBeNull();
        expect(conformed).toEqual({ amount: 10, note: "rent" });
        expect(Object.hasOwn(conformed, "__proto__")).toBe(false);
        expect(Object.hasOwn(conformed, "constructor")).toBe(false);
    });

    it("serializes and displays only safe declared fields", () => {
        const def: AiActionDefinition = {
            ...DEF,
            responseSchema: {
                type: "object",
                properties: { amount: { type: "number" }, note: { type: "string" } },
                required: ["amount"],
            },
        };
        const raw = JSON.parse(
            '{"amount":10,"note":"rent","prototype":"evil","__proto__":{"admin":true}}',
        ) as Record<string, unknown>;
        const safe = applyRulesPostPass([], raw, undefined, def.responseSchema);
        const card = buildActionCardContent(def, safe, RECIPIENT);
        expect(card.rows).toEqual([
            { label: "Amount", value: "10" },
            { label: "Note", value: "rent" },
        ]);
        expect(JSON.parse(new TextDecoder().decode(card.confirmPayload!))).toEqual({
            amount: 10,
            note: "rent",
        });
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
    it("preserves the bounded image-only omission annotation from the wire schema", () => {
        const def = aiActionDefinitionFromWire({
            ...WIRE,
            response_schema: JSON.stringify({
                type: "object",
                properties: {
                    optionalValue: {
                        type: "string",
                        "x-openchat-omit-for-image-only": true,
                    },
                },
            }),
        });

        expect(def.responseSchema).toEqual({
            type: "object",
            properties: {
                optionalValue: {
                    type: "string",
                    "x-openchat-omit-for-image-only": true,
                },
            },
        });
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
                    url: "https://app.example/openchat/link-chat?app={appId}",
                    display: "sheet",
                },
                { kind: "docs", url: "https://app.example/docs", display: "external" },
            ],
        };
        const manifest = aiAppManifestFromWire(manifestWire);
        expect(manifest.surfaces).toEqual([
            {
                kind: "chat_link",
                url: "https://app.example/openchat/link-chat?app={appId}",
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
        expect(
            aiAppManifestFromWire({ ...base, inbox_canister_id: undefined }).inboxCanisterId,
        ).toBeUndefined();
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

    it("fails the whole card template closed for forbidden, duplicate, or control-bearing rows", () => {
        for (const rows of [
            [
                { field: "amount", label: "Amount" },
                { field: "__proto__", label: "Admin" },
            ],
            [
                { field: "amount", label: "Amount" },
                { field: "currency", label: "Amount" },
            ],
            [
                { field: "amount", label: "Amount" },
                { field: "amount", label: "Again" },
            ],
            [{ field: "amount", label: "Amount\u202e" }],
        ]) {
            expect(
                aiActionDefinitionFromWire({ ...WIRE, card: { ...WIRE.card, rows } }).card.rows,
            ).toEqual([]);
        }
    });

    it("rejects forbidden rule targets and enforces aggregate rule/keyword budgets", () => {
        expect(
            rulesFromWire([
                { from_message: { field: "__proto__" } },
                { normalize: { field: "constructor", ops: ["trim"] } },
            ]),
        ).toEqual([]);

        const instructions = Array.from({ length: 21 }, (_, i) => ({
            instruction: { text: `instruction-${i}` },
        }));
        expect(rulesFromWire(instructions)).toHaveLength(20);

        const keywordRule = rulesFromWire([
            {
                keyword_map: {
                    field: "category",
                    mode: "override",
                    map: Array.from({ length: 11 }, (_, mapping) => ({
                        value: `value-${mapping}`,
                        keywords: Array.from(
                            { length: 50 },
                            (_, keyword) => `k${mapping}_${keyword}`,
                        ),
                    })),
                },
            },
        ]);
        expect(keywordRule).toHaveLength(1);
        if (keywordRule[0]?.kind !== "keyword_map") throw new Error("expected keyword map");
        expect(keywordRule[0].map.flatMap((mapping) => mapping.keywords)).toHaveLength(500);
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
    it("uses the same byte-ordered direct identity from both participant perspectives", () => {
        const alice = "scp3f-4qbae-aq"; // principal bytes [1,1,1]
        const bob = "ed6q5-uqcai-ba"; // principal bytes [2,2,2]
        const expected = `direct:${alice}:${bob}`;
        expect(chatKeyFor({ kind: "direct_chat", userId: bob }, alice)).toBe(expected);
        expect(chatKeyFor({ kind: "direct_chat", userId: alice }, bob)).toBe(expected);
        expect(aiAppCardChatContext({ kind: "direct_chat", userId: bob }, alice)).toEqual({
            kind: "direct",
            userIds: [alice, bob],
        });
    });

    it("fails closed without the current direct-chat viewer or with an invalid pair", () => {
        const other = "ed6q5-uqcai-ba";
        expect(chatKeyFor({ kind: "direct_chat", userId: other })).toBeUndefined();
        expect(chatKeyFor({ kind: "direct_chat", userId: other }, other)).toBeUndefined();
        expect(
            chatKeyFor({ kind: "direct_chat", userId: other }, "not-a-principal"),
        ).toBeUndefined();
    });
});

// ── Real model replies, end to end ───────────────────────────────────────────
//
// Every stage of the multi-entry pipeline is unit-tested above in isolation, and every stage passed
// while the user reported "produces two entries only, dropping the 150 food" TWICE. That is the gap
// this block closes: the stages are exercised TOGETHER, on replies an actual on-device model actually
// produced, asserting the thing the user cares about — every amount in the message reaches a card.
//
// The first fixture is captured verbatim from Qwen3-VL 2B (the current browser default) for the
// reported message, via an external live harness. Re-running that extraction four times gave this
// same 3-entry shape every time, which is how the drop was traced past the model and the parser.
describe("real captured model replies keep every transaction", () => {
    const REPORTED_MESSAGE = "Owe me 300 uber 150 food\n\n500 movies";

    // The exact bytes Qwen3-VL 2B returned. Kept verbatim (whitespace included) — reformatting it
    // would quietly weaken the test into one about our own pretty-printing.
    const QWEN_3_ENTRIES = `[
  { "kind": "debt", "amount": 300, "currency": "USD", "direction": "debt", "note": "Uber ride" },
  { "kind": "debt", "amount": 150, "currency": "USD", "direction": "debt", "note": "Food" },
  { "kind": "settlement", "amount": 500, "currency": "USD", "direction": "credit", "note": "Movies" }
]`;

    const amountsOf = (entries: Record<string, unknown>[]) => entries.map((e) => e.amount);

    it("three transactions in, three entries out — including two on the SAME line", async () => {
        // "300 uber 150 food" share a line; "500 movies" is a paragraph away. Both splits must survive.
        expect(amountsOf(parseExtractionList(QWEN_3_ENTRIES)!)).toEqual([300, 150, 500]);
        const r = await runAiAction(MULTI_DEF, { text: REPORTED_MESSAGE }, RECIPIENT, async () => ({
            kind: "ok",
            text: QWEN_3_ENTRIES,
        }));
        expect(r.kind).toBe("ready_multi");
        if (r.kind === "ready_multi") {
            expect(amountsOf(r.extracted)).toEqual([300, 150, 500]);
            expect(r.card.rows).toHaveLength(3);
        }
    });

    it("never encodes the exact entry array into public rows", async () => {
        // Exact entries belong only in confirmPayload, never in a public display row.
        const r = await runAiAction(MULTI_DEF, { text: REPORTED_MESSAGE }, RECIPIENT, async () => ({
            kind: "ok",
            text: QWEN_3_ENTRIES,
        }));
        expect(r.kind).toBe("ready_multi");
        if (r.kind !== "ready_multi") throw new Error("expected a multi-entry card");
        const exactArray = QWEN_3_ENTRIES.replace(/\s+/g, "");
        expect(r.card.rows.some((row) => row.value.replace(/\s+/g, "").includes(exactArray))).toBe(
            false,
        );
        expect(r.card.rows.some((row) => row.label.startsWith("__oc_"))).toBe(false);
        expect(JSON.parse(new TextDecoder().decode(r.card.confirmPayload!))).toEqual(r.extracted);
    });

    it("gives each entry its OWN note, never the whole message", async () => {
        // The first form of this bug: every row got the entire message as its description, so three
        // entries read "Owe me 300 uber 150 food 500 movies". The note is the model's per-entry text;
        // the raw message travels separately, on `message`.
        const r = await runAiAction(MULTI_DEF, { text: REPORTED_MESSAGE }, RECIPIENT, async () => ({
            kind: "ok",
            text: QWEN_3_ENTRIES,
        }));
        expect(r.kind).toBe("ready_multi");
        if (r.kind !== "ready_multi") throw new Error("expected a multi-entry card");
        expect(r.extracted.map((e) => e.note)).toEqual(["Uber ride", "Food", "Movies"]);
        for (const e of r.extracted) {
            expect(e.note).not.toContain("500 movies");
        }
    });

    it("does not add any candidates beyond the model's duplicated reply", async () => {
        // The browser backend once received the message twice (prompt AND text) and duly extracted
        // 300 twice. The duplicate send is fixed and tested above; this pins the SYMPTOM, so a
        // reintroduction anywhere in the chain fails here too.
        const duplicated = `[
  { "kind": "debt", "amount": 300, "note": "Uber ride" },
  { "kind": "debt", "amount": 150, "note": "Food" },
  { "kind": "debt", "amount": 300, "note": "Uber ride" },
  { "kind": "debt", "amount": 150, "note": "Food" }
]`;
        const r = await runAiAction(MULTI_DEF, { text: REPORTED_MESSAGE }, RECIPIENT, async () => ({
            kind: "ok",
            text: duplicated,
        }));
        expect(r.kind).toBe("ready_multi");
        // We do NOT dedupe (two identical real transactions are legal), so this documents today's
        // behaviour deliberately: the guard against duplicates is the single-send test, not a filter.
        if (r.kind === "ready_multi") {
            expect(amountsOf(r.extracted)).toEqual([300, 150, 300, 150]);
        }
    });

    it("salvages the completed transactions when the model's reply is cut off mid-object", async () => {
        // A small model hitting the token cap truncates. Losing the tail is acceptable; losing
        // EVERYTHING (which is what happened before scanJsonObjects) is not — that is the long wait
        // ending in "nothing to process".
        const truncated = `[
  { "kind": "debt", "amount": 300, "note": "Uber ride" },
  { "kind": "debt", "amount": 150, "note": "Food" },
  { "kind": "debt", "amount": 500, "note": "Mov`;
        const r = await runAiAction(MULTI_DEF, { text: REPORTED_MESSAGE }, RECIPIENT, async () => ({
            kind: "ok",
            text: truncated,
        }));
        expect(r.kind).toBe("ready_multi");
        if (r.kind === "ready_multi") {
            expect(amountsOf(r.extracted)).toEqual([300, 150]);
        }
    });

    it("does not silently drop one degenerate transaction from a captured model reply", async () => {
        // amount 0 violates exclusiveMinimum, so that element is dropped by the viability gate — but
        // dropping the whole card would lose two good transactions with it.
        const withZero = `[
  { "kind": "debt", "amount": 300, "note": "Uber ride" },
  { "kind": "debt", "amount": 0, "note": "Food" },
  { "kind": "debt", "amount": 500, "note": "Movies" }
]`;
        const r = await runAiAction(MULTI_DEF, { text: REPORTED_MESSAGE }, RECIPIENT, async () => ({
            kind: "ok",
            text: withZero,
        }));
        expect(r.kind).toBe("incomplete_extraction");
        if (r.kind === "incomplete_extraction") {
            expect(r.missingFields).toEqual(["amount"]);
            expect(r.candidateCount).toBe(3);
            expect(r.validCandidateCount).toBe(2);
        }
    });
});

// ── The reply SHAPES a small model actually emits ────────────────────────────
//
// This is the block that would have caught "produces two entries only, dropping the 150 food".
//
// Every one of these carries the same three transactions; only the packaging differs, and the
// packaging is not something we control — a model wraps its list under a key, splits it across two
// fenced blocks, or adds an afterthought object after the closing bracket, depending on its mood.
// The parser used to stop at the first promising REGION, so four of these six silently yielded FEWER
// entries than the message had amounts. Silently is the operative word: the card just had fewer rows,
// which nobody notices without counting.
//
// Written as a table so a newly observed shape is one line, not a new test.
describe("parseExtractionList — the reply shapes a small model actually emits", () => {
    const SHAPES: [string, string][] = [
        // Used to yield 1: the scanner sees one top-level object and the entries are nested inside it.
        // That candidate then failed the required-field gate — the long wait ending in "nothing to
        // process".
        [
            "the list wrapped under a key",
            '{"transactions":[{"amount":300,"note":"uber"},{"amount":150,"note":"food"},{"amount":500,"note":"movies"}]}',
        ],
        // Used to yield 2: the fence match was non-greedy, so only the FIRST block was read.
        [
            "two separate fenced blocks",
            '```json\n[{"amount":300},{"amount":150}]\n```\n```json\n[{"amount":500}]\n```',
        ],
        // Used to yield 2: the array fast path returned as soon as the array parsed, ignoring the rest.
        [
            "an array plus an afterthought object",
            '[{"amount":300},{"amount":150}] and also {"amount":500}',
        ],
        [
            "a fenced array plus an afterthought object",
            'Sure:\n```json\n[{"amount":300},{"amount":150}]\n```\nplus {"amount":500}',
        ],
        // These already worked. Kept so a future "simplification" cannot quietly break them.
        ["bare objects, one per line", '{"amount":300}\n{"amount":150}\n{"amount":500}'],
        [
            "objects scattered through prose",
            '1. {"amount":300}\nThen: {"amount":150}\nFinally {"amount":500}\nThat is all.',
        ],
        ["a clean array", '[{"amount":300},{"amount":150},{"amount":500}]'],
    ];

    it.each(SHAPES)("keeps all three transactions: %s", (_name, raw) => {
        const got = parseExtractionList(raw);
        expect(got).toBeDefined();
        expect(got!.map((o) => o.amount)).toEqual([300, 150, 500]);
    });

    it("still finds nothing in a reply that contains no JSON at all", () => {
        // The negative control: scanning the whole text more aggressively must not start inventing
        // entries out of prose.
        expect(
            parseExtractionList("I could not find a transaction in that message."),
        ).toBeUndefined();
    });

    it("does not unwrap a real extraction that happens to hold one array", () => {
        // {"schedule":[…]} is unwrapped (harmless — a bare schedule fails the required-field gate
        // anyway), but a genuine entry carries more than one field and must survive intact.
        const got = parseExtractionList('{"amount":300,"schedule":[{"due_date":"2026-08-01"}]}');
        expect(got).toHaveLength(1);
        expect(got![0].amount).toBe(300);
    });
});
