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
    chatKeyFor,
    compileRules,
    parseExtraction,
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
    it("passes the declared prompt + schema + image to the model", async () => {
        let seen: InferenceRequest | undefined;
        await runAiAction(DEF, { image: new Uint8Array([1, 2, 3]) }, RECIPIENT, async (req) => {
            seen = req;
            return { kind: "ok", text: "{}" };
        });
        const today = new Date().toISOString().slice(0, 10);
        // No rules and no message text: template + the dateline only.
        expect(seen?.prompt).toBe(`${DEF.promptTemplate}\n\nToday is ${today}.`);
        expect(seen?.responseSchema).toBe(DEF.responseSchema);
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
