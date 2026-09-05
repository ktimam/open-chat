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
        reading: { type: "number", minimum: 0.005, maximum: 100_000 },
        unit: {
            type: "string",
            minLength: 3,
            maxLength: 3,
            format: "ascii-uppercase",
        },
        date: { type: "string", format: "date" },
        annotation: { type: "string", maxLength: 4_096, format: "utf8-no-nul" },
        message: { type: "string", maxLength: 200, format: "utf8-no-nul" },
    },
    required: ["reading"],
};

const IMAGE_ACTION: AiActionDefinition = {
    name: "example.measurement.add",
    description: "Extract an measurement from an image",
    promptTemplate: "Return one measurement as JSON.",
    acceptsImage: true,
    responseSchema: RESPONSE_SCHEMA,
    card: {
        title: "Add measurement",
        rows: [
            { label: "Reading", valueKey: "reading" },
            { label: "Unit", valueKey: "unit" },
            { label: "Date", valueKey: "date" },
            { label: "Annotation", valueKey: "annotation" },
            { label: "Message", valueKey: "message" },
        ],
        confirmLabel: "Add",
        cancelLabel: "Cancel",
    },
    consumerPublicKey: "-----BEGIN PUBLIC KEY-----\nABC\n-----END PUBLIC KEY-----\n",
};

const INVALID_IMAGE_EXTRACTION = {
    reading: 50,
    unit: "$",
    date: "08/07/2026",
    annotation: "n".repeat(4_097),
    message: "m".repeat(201),
};

const NORMALIZE_UNIT: AiActionRule[] = [
    { kind: "normalize", field: "unit", ops: ["uppercase", "trim"] },
];

describe("image extraction schema compatibility", () => {
    it("drops malformed optional image fields before an app is asked to attest the card", () => {
        const sanitized = applyRulesPostPass(
            [],
            INVALID_IMAGE_EXTRACTION,
            undefined,
            RESPONSE_SCHEMA,
        );
        expect(Object.keys(sanitized)).toEqual(["reading"]);
        expect(sanitized.reading).toBe(50);

        expect(
            applyRulesPostPass(
                [],
                {
                    reading: 50,
                    unit: "$$$",
                    date: "2026-13-40",
                    annotation: "report\0hidden",
                    message: "message\0hidden",
                },
                undefined,
                RESPONSE_SCHEMA,
            ),
        ).toEqual({ reading: 50 });

        expect(
            applyRulesPostPass(
                [],
                { reading: 50, annotation: "\ud800", message: "\udc00" },
                undefined,
                RESPONSE_SCHEMA,
            ),
        ).toEqual({ reading: 50 });

        expect(
            applyRulesPostPass(
                [],
                { reading: 50, unit: "\uFF25\uFF27\uFF30", date: "2026-02-29" },
                undefined,
                RESPONSE_SCHEMA,
            ),
        ).toEqual({ reading: 50 });
    });

    it("keeps valid bounded optional fields", () => {
        expect(
            applyRulesPostPass(
                [],
                {
                    reading: 50,
                    unit: "HPA",
                    date: "2026-08-07",
                    annotation: "report",
                },
                undefined,
                RESPONSE_SCHEMA,
            ),
        ).toEqual({
            reading: 50,
            unit: "HPA",
            date: "2026-08-07",
            annotation: "report",
        });

        expect(
            applyRulesPostPass(
                NORMALIZE_UNIT,
                { reading: 50, unit: " hpa " },
                undefined,
                RESPONSE_SCHEMA,
            ),
        ).toEqual({ reading: 50, unit: "HPA" });

        const unicodeAtLimit = "\u{1F321}".repeat(4_096);
        expect(
            applyRulesPostPass(
                [],
                { reading: 50, annotation: unicodeAtLimit },
                undefined,
                RESPONSE_SCHEMA,
            ).annotation,
        ).toBe(unicodeAtLimit);
    });

    it("drops numbers above the declared maximum", () => {
        expect(applyRulesPostPass([], { reading: 100_001 }, undefined, RESPONSE_SCHEMA)).toEqual(
            {},
        );
        expect(applyRulesPostPass([], { reading: 100_000 }, undefined, RESPONSE_SCHEMA)).toEqual({
            reading: 100_000,
        });
    });

    it("keeps the exact declared fractional measurement boundary and drops smaller positive values", () => {
        expect(applyRulesPostPass([], { reading: 0.0049 }, undefined, RESPONSE_SCHEMA)).toEqual({});
        expect(applyRulesPostPass([], { reading: 0.005 }, undefined, RESPONSE_SCHEMA)).toEqual({
            reading: 0.005,
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
                    return { kind: "ok", text: '{"reading":50}' };
                },
            );
            expect(result).toEqual({ kind: "image_not_accepted" });
            expect(inferenceCalls).toBe(0);
        }

        let textInferenceCalls = 0;
        const textResult = await runAiAction(
            { ...IMAGE_ACTION, acceptsImage: undefined },
            { text: "measured 50" },
            IMAGE_ACTION.consumerPublicKey ?? "",
            async () => {
                textInferenceCalls++;
                return { kind: "ok", text: '{"reading":50}' };
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
        expect(Object.keys(result.extracted)).toEqual(["reading"]);
        expect(result.extracted.reading).toBe(50);
        expect(result.card.rows).toEqual([{ label: "Reading", value: "50" }]);
        expect(new TextDecoder().decode(result.card.confirmPayload)).toBe('{"reading":50}');
    });
});
