import { describe, expect, it } from "vitest";
import {
    type AiActionDefinition,
    buildActionCardContent,
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
            expect(r.card.confirmPayload).toBeInstanceOf(Uint8Array);
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
        expect(seen?.prompt).toBe(DEF.promptTemplate);
        expect(seen?.responseSchema).toBe(DEF.responseSchema);
        expect(seen?.image).toEqual(new Uint8Array([1, 2, 3]));
    });
});
