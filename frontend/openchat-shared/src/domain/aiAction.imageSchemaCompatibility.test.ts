import { describe, expect, it } from "vitest";
import {
    type AiActionDefinition,
    type AiActionRule,
    applyRulesPostPass,
    runAiAction,
} from "./aiAction";

const RESPONSE_SCHEMA = {
    type: "object",
    properties: {
        amount: { type: "number", minimum: 0.005, maximum: 100_000 },
        currency: {
            type: "string",
            minLength: 3,
            maxLength: 3,
            format: "ascii-uppercase",
        },
        date: { type: "string", format: "date" },
        note: { type: "string", maxLength: 4_096, format: "utf8-no-nul" },
        message: { type: "string", maxLength: 200, format: "utf8-no-nul" },
    },
    required: ["amount"],
};

const IMAGE_ACTION: AiActionDefinition = {
    name: "example.expense.add",
    description: "Extract an expense from an image",
    promptTemplate: "Return one expense as JSON.",
    acceptsImage: true,
    responseSchema: RESPONSE_SCHEMA,
    card: {
        title: "Add expense",
        rows: [
            { label: "Amount", valueKey: "amount" },
            { label: "Currency", valueKey: "currency" },
            { label: "Date", valueKey: "date" },
            { label: "Note", valueKey: "note" },
            { label: "Message", valueKey: "message" },
        ],
        confirmLabel: "Add",
        cancelLabel: "Cancel",
    },
    consumerPublicKey: "-----BEGIN PUBLIC KEY-----\nABC\n-----END PUBLIC KEY-----\n",
};

const INVALID_IMAGE_EXTRACTION = {
    amount: 50,
    currency: "$",
    date: "08/07/2026",
    note: "n".repeat(4_097),
    message: "m".repeat(201),
};

const NORMALIZE_CURRENCY: AiActionRule[] = [
    { kind: "normalize", field: "currency", ops: ["uppercase", "trim"] },
];

describe("image extraction schema compatibility", () => {
    it("drops malformed optional image fields before an app is asked to attest the card", () => {
        const sanitized = applyRulesPostPass(
            [],
            INVALID_IMAGE_EXTRACTION,
            undefined,
            RESPONSE_SCHEMA,
        );
        expect(Object.keys(sanitized)).toEqual(["amount"]);
        expect(sanitized.amount).toBe(50);

        expect(
            applyRulesPostPass(
                [],
                {
                    amount: 50,
                    currency: "$$$",
                    date: "2026-13-40",
                    note: "receipt\0hidden",
                    message: "message\0hidden",
                },
                undefined,
                RESPONSE_SCHEMA,
            ),
        ).toEqual({ amount: 50 });

        expect(
            applyRulesPostPass(
                [],
                { amount: 50, note: "\ud800", message: "\udc00" },
                undefined,
                RESPONSE_SCHEMA,
            ),
        ).toEqual({ amount: 50 });

        expect(
            applyRulesPostPass(
                [],
                { amount: 50, currency: "\uFF25\uFF27\uFF30", date: "2026-02-29" },
                undefined,
                RESPONSE_SCHEMA,
            ),
        ).toEqual({ amount: 50 });
    });

    it("keeps valid bounded optional fields", () => {
        expect(
            applyRulesPostPass(
                [],
                {
                    amount: 50,
                    currency: "EGP",
                    date: "2026-08-07",
                    note: "receipt",
                },
                undefined,
                RESPONSE_SCHEMA,
            ),
        ).toEqual({
            amount: 50,
            currency: "EGP",
            date: "2026-08-07",
            note: "receipt",
        });

        expect(
            applyRulesPostPass(
                NORMALIZE_CURRENCY,
                { amount: 50, currency: " egp " },
                undefined,
                RESPONSE_SCHEMA,
            ),
        ).toEqual({ amount: 50, currency: "EGP" });

        const unicodeAtLimit = "\u{1F4B5}".repeat(4_096);
        expect(
            applyRulesPostPass([], { amount: 50, note: unicodeAtLimit }, undefined, RESPONSE_SCHEMA)
                .note,
        ).toBe(unicodeAtLimit);
    });

    it("drops numbers above the declared maximum", () => {
        expect(applyRulesPostPass([], { amount: 100_001 }, undefined, RESPONSE_SCHEMA)).toEqual({});
        expect(applyRulesPostPass([], { amount: 100_000 }, undefined, RESPONSE_SCHEMA)).toEqual({
            amount: 100_000,
        });
    });

    it("keeps the exact one-minor-unit rounding boundary and drops smaller positive values", () => {
        expect(applyRulesPostPass([], { amount: 0.0049 }, undefined, RESPONSE_SCHEMA)).toEqual({});
        expect(applyRulesPostPass([], { amount: 0.005 }, undefined, RESPONSE_SCHEMA)).toEqual({
            amount: 0.005,
        });
    });

    it("never runs inference on image input unless the action explicitly accepts images", async () => {
        for (const acceptsImage of [undefined, false]) {
            let inferenceCalls = 0;
            const result = await runAiAction(
                { ...IMAGE_ACTION, acceptsImage },
                { image: new Uint8Array([1, 2, 3]) },
                IMAGE_ACTION.consumerPublicKey ?? "",
                async () => {
                    inferenceCalls++;
                    return { kind: "ok", text: '{"amount":50}' };
                },
            );
            expect(result).toEqual({ kind: "image_not_accepted" });
            expect(inferenceCalls).toBe(0);
        }

        let textInferenceCalls = 0;
        const textResult = await runAiAction(
            { ...IMAGE_ACTION, acceptsImage: undefined },
            { text: "paid 50" },
            IMAGE_ACTION.consumerPublicKey ?? "",
            async () => {
                textInferenceCalls++;
                return { kind: "ok", text: '{"amount":50}' };
            },
        );
        expect(textResult.kind).toBe("ready");
        expect(textInferenceCalls).toBe(1);
    });

    it("builds an image card and confirm payload only from the sanitized extraction", async () => {
        const result = await runAiAction(
            IMAGE_ACTION,
            { image: new Uint8Array([1, 2, 3]) },
            IMAGE_ACTION.consumerPublicKey ?? "",
            async () => ({ kind: "ok", text: JSON.stringify(INVALID_IMAGE_EXTRACTION) }),
        );

        expect(result.kind).toBe("ready");
        if (result.kind !== "ready") return;
        expect(Object.keys(result.extracted)).toEqual(["amount"]);
        expect(result.extracted.amount).toBe(50);
        expect(result.card.rows).toEqual([{ label: "Amount", value: "50" }]);
        expect(new TextDecoder().decode(result.card.confirmPayload)).toBe('{"amount":50}');
    });
});
