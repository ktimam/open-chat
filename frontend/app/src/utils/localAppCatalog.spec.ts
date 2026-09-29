import { describe, expect, it } from "vitest";
import {
    localAppCandidates,
    parseLocalAppCatalog,
    projectLocalAppPayload,
} from "./localAppCatalog";

function fixture() {
    return {
        version: 1,
        apps: [
            {
                id: "sample",
                revision: "v1",
                name: "Sample",
                description: "Synthetic app",
                destination: "https://example.invalid/import",
                actions: [
                    {
                        definition: {
                            name: "sample.save",
                            description: "Synthetic action",
                            promptTemplate: "Copy the visible label.",
                            acceptsImage: true,
                            responseSchema: {
                                type: "object",
                                "x-openchat-image-prompt-by-model": {
                                    version: 2,
                                    templates: {
                                        "opaque-model-id": {
                                            template: "APP-OWNED MODEL PROMPT",
                                            includeRuleGuidance: false,
                                            output: "canonical",
                                        },
                                    },
                                },
                                properties: { label: { type: "string" } },
                            },
                            card: {
                                title: "Review item",
                                rows: [{ label: "Label", valueKey: "label" }],
                                confirmLabel: "Send",
                                cancelLabel: "Cancel",
                            },
                            rules: [
                                {
                                    kind: "keyword_map",
                                    field: "label",
                                    mode: "hint",
                                    map: [{ value: "user-choice", keywords: ["user vocabulary"] }],
                                },
                            ],
                        },
                        draftSchema: {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                                items: {
                                    type: "array",
                                    items: {
                                        type: "object",
                                        additionalProperties: false,
                                        properties: { label: { type: "string" } },
                                        required: ["label"],
                                    },
                                    minItems: 1,
                                },
                            },
                            required: ["items"],
                        },
                        handoff: { kind: "wrapped-list", field: "items" },
                    },
                ],
            },
        ],
    };
}

describe("imported declarative local app catalog", () => {
    it("validates and freezes named choices without copying editor setup into payload", () => {
        const input = fixture();
        Object.assign(input.apps[0].actions[0].draftSchema.properties.items.items.properties, {
            preset: { type: "string" },
            presetLabel: { type: "string" },
        });
        const draftEditor = {
            version: 1,
            choices: [
                {
                    field: "preset",
                    label: "Preset",
                    noneLabel: "None",
                    options: [
                        {
                            value: "first",
                            label: "First preset",
                            assign: [{ field: "presetLabel", value: "First" }],
                            defaults: [{ field: "label", value: "Default" }],
                        },
                    ],
                },
            ],
        };
        Object.assign(input.apps[0].actions[0], { draftEditor });
        const action = parseLocalAppCatalog(JSON.stringify(input)).apps[0].actions[0];
        expect(action.draftEditor).toEqual(draftEditor);
        expect(Object.isFrozen(action.draftEditor?.choices[0].options)).toBe(true);
        expect(projectLocalAppPayload(action, [{ label: "raw" }])).toEqual({
            items: [{ label: "raw" }],
        });
        draftEditor.choices[0].options[0].defaults[0].field = "missing";
        expect(() => parseLocalAppCatalog(JSON.stringify(input))).toThrow();
    });
    it("preserves app prompts, opaque model IDs and user-defined vocabulary as immutable data", () => {
        const input = fixture();
        const catalog = parseLocalAppCatalog(JSON.stringify(input));
        expect(catalog).toEqual(input);
        expect(Object.isFrozen(catalog.apps[0].actions[0].definition.responseSchema)).toBe(true);
        expect(localAppCandidates(catalog)).toHaveLength(1);
        expect(localAppCandidates(catalog)[0].app).toBe(catalog.apps[0]);
    });
    it("projects payload using the app-owned wrapper field and strict final schema", () => {
        const action = parseLocalAppCatalog(JSON.stringify(fixture())).apps[0].actions[0];
        expect(projectLocalAppPayload(action, [{ label: "SYNTHETIC_PRIVATE_MARKER" }])).toEqual({
            items: [{ label: "SYNTHETIC_PRIVATE_MARKER" }],
        });
        expect(() =>
            projectLocalAppPayload(action, [{ label: "valid", hidden: "not allowed" }]),
        ).toThrow();
        expect(() => projectLocalAppPayload(action, [])).toThrow();
    });
    it("keeps explicitly imported setup context local and out of projected delivery", () => {
        const input = fixture();
        Object.assign(input.apps[0], {
            recipientLabel: "Declared review context; choose destination in app",
        });
        Object.assign(input.apps[0].actions[0], {
            processorContext: { options: ["PRIVATE_IMPORTED_VOCABULARY"] },
        });
        const app = parseLocalAppCatalog(JSON.stringify(input)).apps[0];
        expect(Object.isFrozen(app.actions[0].processorContext)).toBe(true);
        expect(projectLocalAppPayload(app.actions[0], [{ label: "synthetic" }])).toEqual({
            items: [{ label: "synthetic" }],
        });
        expect(
            JSON.stringify(projectLocalAppPayload(app.actions[0], [{ label: "synthetic" }])),
        ).not.toContain("PRIVATE_IMPORTED_VOCABULARY");
    });
    it.each(["endpoint", "consumerPublicKey", "recipientScope"])(
        "rejects legacy backend routing field %s",
        (key) => {
            const input = fixture();
            Object.assign(input.apps[0].actions[0].definition, { [key]: "untrusted-route" });
            expect(() => parseLocalAppCatalog(JSON.stringify(input))).toThrow();
        },
    );
    it("requires a pinned artifact descriptor for local-processor actions", () => {
        const input = fixture();
        Object.assign(input.apps[0].actions[0].definition.responseSchema, {
            "x-openchat-local-processor": { version: 1 },
        });
        expect(() => parseLocalAppCatalog(JSON.stringify(input))).toThrow();
        Object.assign(input.apps[0], { processor: { sha256: "a".repeat(64), byteLength: 500 } });
        expect(parseLocalAppCatalog(JSON.stringify(input)).apps[0].processor?.byteLength).toBe(500);
    });
    it.each([
        "https://user:password@example.invalid/import",
        "http://example.invalid/import",
        "javascript:void(0)",
    ])("rejects unsafe destination %s", (destination) => {
        const input = fixture();
        input.apps[0].destination = destination;
        expect(() => parseLocalAppCatalog(JSON.stringify(input))).toThrow();
    });
    it("rejects duplicate identities, unknown rules and unknown final schema keywords", () => {
        const input = fixture();
        input.apps.push(input.apps[0]);
        expect(() => parseLocalAppCatalog(JSON.stringify(input))).toThrow();
        const rules = fixture();
        Object.assign(rules.apps[0].actions[0].definition.rules[0], { kind: "execute" });
        expect(() => parseLocalAppCatalog(JSON.stringify(rules))).toThrow();
        const schema = fixture();
        Object.assign(schema.apps[0].actions[0].draftSchema, { additionalProperties: true });
        expect(() => parseLocalAppCatalog(JSON.stringify(schema))).toThrow();
    });
});
