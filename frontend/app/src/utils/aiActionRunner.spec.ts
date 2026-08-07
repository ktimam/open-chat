import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InferenceRequest, InferenceResult, OnDeviceInferenceCapability } from "@shared";

const { attestationAvailableMock, inferOnDeviceMock, inferenceCapabilityMock } = vi.hoisted(() => ({
    attestationAvailableMock: vi.fn(() => false),
    inferOnDeviceMock: vi.fn(
        async (_request: InferenceRequest): Promise<InferenceResult> => ({
            kind: "unavailable",
            reason: "not in tests",
        }),
    ),
    inferenceCapabilityMock: vi.fn(
        (): OnDeviceInferenceCapability => ({
            available: true,
            runtimesSupported: ["llama-cpp"],
            selectedModalities: ["text"],
        }),
    ),
}));

// These specs pin the MANUAL-extraction gate: the manual path (no on-device runtime — the caller
// supplies the extraction) must run the SAME deterministic pass as the model path (rules post-pass +
// schema conformance + required-fields check) before a card is built. Previously it built the card
// straight from the caller-supplied object, so a degenerate value (e.g. amount 0 against a schema
// requiring amount > 0) posted a confirm card the consumer app then rejected as an invalid draft.

// aiActionRunner imports the on-device inference facade at module level; stub it so importing the
// module never touches the Tauri bridge (the manual path performs no inference at all).
vi.mock("./aiActionAvailability", () => ({
    appContentAttestationAvailable: attestationAvailableMock,
}));
vi.mock("./onDeviceInference", () => ({
    inferOnDevice: inferOnDeviceMock,
    onDeviceInferenceCapability: inferenceCapabilityMock,
}));

import type { ActionCardContent, AiActionDefinition, AiAppRegistration } from "@shared";
import { MAX_AI_ACTION_CANDIDATES } from "@shared";
import type { MessageContext, OpenChat } from "@client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
    buildManualCard,
    manualExtractEnabled,
    imageUnsupportedReason,
    proposeFailureMessage,
    proposeAndPost,
    proposeAndPostCandidate,
    proposeAiActionForMessage,
    preflightAiActionForMessage,
    resolveCandidates,
    runProposeFlow,
    NO_MODEL_MESSAGE,
    type AiActionCandidate,
    type ProposeFlowDeps,
    type ProposeResult,
} from "./aiActionRunner";

const RECIPIENT = "-----BEGIN PUBLIC KEY-----\nABC\n-----END PUBLIC KEY-----\n";

beforeEach(() => {
    attestationAvailableMock.mockReturnValue(false);
    inferOnDeviceMock.mockClear();
    inferenceCapabilityMock.mockReturnValue({
        available: true,
        runtimesSupported: ["llama-cpp"],
        selectedModalities: ["text"],
    });
});

const DEF: AiActionDefinition = {
    name: "demo.expense.add",
    description: "Log expense",
    promptTemplate: "extract the transaction as JSON",
    responseSchema: {
        type: "object",
        properties: {
            kind: { type: "string", enum: ["expense", "settlement"] },
            amount: { type: "number", exclusiveMinimum: 0 },
            currency: { type: "string" },
        },
        required: ["amount"],
    },
    card: {
        title: "Log expense",
        rows: [
            { label: "Amount", valueKey: "amount" },
            { label: "Currency", valueKey: "currency" },
        ],
        confirmLabel: "Add",
        cancelLabel: "Dismiss",
    },
};

describe("buildManualCard (manual-extraction gate)", () => {
    it("gates a degenerate manual extraction (required amount 0) to no_extraction — no card", () => {
        const manual = { kind: "settlement", amount: 0, currency: "USD" };
        const r = buildManualCard(DEF, manual, RECIPIENT);
        expect(r.kind).toBe("no_extraction");
        if (r.kind === "no_extraction") {
            // raw carries the ORIGINAL manual extraction for the caller to surface/debug.
            expect(JSON.parse(r.raw)).toEqual(manual);
        }
    });

    it("builds a ready card from a valid manual extraction, post-passed like the model path", () => {
        const r = buildManualCard(
            DEF,
            { kind: "settlement", amount: 350, currency: "USD", extra: 1 },
            RECIPIENT,
        );
        expect(r.kind).toBe("ready");
        if (r.kind === "ready") {
            // Undeclared keys are dropped by the same conformance pass the model path runs.
            expect(r.extracted).toEqual({ kind: "settlement", amount: 350, currency: "USD" });
            expect(r.card.rows).toEqual([
                { label: "Amount", value: "350" },
                { label: "Currency", value: "USD" },
            ]);
            expect(r.card.recipientPublicKey).toBe(RECIPIENT);
        }
    });

    it("runs declared normalize rules over the manual extraction ('350 usd' -> 350)", () => {
        const def: AiActionDefinition = {
            ...DEF,
            rules: [{ kind: "normalize", field: "amount", ops: ["k_m_suffix"] }],
        };
        const r = buildManualCard(def, { amount: "350 usd" }, RECIPIENT);
        expect(r.kind).toBe("ready");
        if (r.kind === "ready") {
            expect(r.extracted.amount).toBe(350);
        }
    });

    it("applies from_message rules to the real source text in the manual QC path", () => {
        const schema = DEF.responseSchema as {
            type: string;
            properties: Record<string, unknown>;
            required: string[];
        };
        const def: AiActionDefinition = {
            ...DEF,
            rules: [{ kind: "from_message", field: "message", maxLength: 200 }],
            responseSchema: {
                ...schema,
                properties: {
                    ...schema.properties,
                    message: { type: "string", maxLength: 200 },
                },
            },
        };
        const sourceText = "Journey qc: cleaning fee 350 EGP";
        const r = buildManualCard(
            def,
            { kind: "settlement", amount: 350, currency: "EGP" },
            RECIPIENT,
            undefined,
            undefined,
            undefined,
            undefined,
            sourceText,
        );
        expect(r.kind).toBe("ready");
        if (r.kind === "ready") {
            expect(r.extracted.message).toBe(sourceText);
            expect(JSON.parse(new TextDecoder().decode(r.card.confirmPayload!))).toMatchObject({
                currency: "EGP",
                message: sourceText,
            });
        }
    });

    it("no schema: the manual extraction passes through and builds a card", () => {
        const def: AiActionDefinition = { ...DEF, responseSchema: undefined };
        const r = buildManualCard(def, { amount: 0 }, RECIPIENT);
        expect(r.kind).toBe("ready");
    });

    it("threads the inbox + fan-out keys onto the card", () => {
        const r = buildManualCard(DEF, { amount: 5 }, RECIPIENT, "aaaaa-aa", ["OTHER_KEY_PEM"]);
        expect(r.kind).toBe("ready");
        if (r.kind === "ready") {
            expect(r.card.inboxCanisterId).toBe("aaaaa-aa");
            expect(r.card.recipientPublicKeys).toEqual(["OTHER_KEY_PEM"]);
        }
    });

    it("an ARRAY of two valid entries fails closed until exact-payload hydration exists", () => {
        const r = buildManualCard(
            DEF,
            [
                { kind: "expense", amount: 20, currency: "USD" },
                { kind: "expense", amount: 30, currency: "EUR" },
            ],
            RECIPIENT,
        );
        expect(r.kind).toBe("error");
        if (r.kind === "error") expect(r.error).toContain("exact-payload endpoint");
    });

    it("an ARRAY with one valid + one degenerate element drops the bad one → single OBJECT card", () => {
        const r = buildManualCard(
            DEF,
            [
                { kind: "expense", amount: 0, currency: "USD" },
                { kind: "expense", amount: 30, currency: "EUR" },
            ],
            RECIPIENT,
        );
        expect(r.kind).toBe("ready");
        if (r.kind === "ready") {
            const payload = JSON.parse(new TextDecoder().decode(r.card.confirmPayload!)) as unknown;
            expect(Array.isArray(payload)).toBe(false);
            expect(payload).toEqual({ kind: "expense", amount: 30, currency: "EUR" });
        }
    });

    it("an all-invalid ARRAY yields no_extraction — no card", () => {
        const arr = [
            { kind: "expense", amount: 0, currency: "USD" },
            { kind: "expense", currency: "EUR" },
        ];
        const r = buildManualCard(DEF, arr, RECIPIENT);
        expect(r.kind).toBe("no_extraction");
        if (r.kind === "no_extraction") {
            expect(JSON.parse(r.raw)).toEqual(arr);
        }
    });
});

describe("manualExtractEnabled", () => {
    beforeEach(() => {
        localStorage.clear();
        history.replaceState({}, "", "/");
    });
    it("is false when neither the flag nor the query param is set", () => {
        expect(manualExtractEnabled()).toBe(false);
    });
    it('is true when localStorage["oc:manualExtract"] === "1"', () => {
        localStorage.setItem("oc:manualExtract", "1");
        expect(manualExtractEnabled()).toBe(true);
    });
    it("is false for any other localStorage value", () => {
        localStorage.setItem("oc:manualExtract", "yes");
        expect(manualExtractEnabled()).toBe(false);
    });
    it("is true when the URL carries ?manualExtract=1", () => {
        history.replaceState({}, "", "/?manualExtract=1");
        expect(manualExtractEnabled()).toBe(true);
    });
});

// Proposing on an IMAGE used to do NOTHING: the bytes were shipped into a text-only runtime and the
// failure never surfaced. This policy is what turns that into an explanation. It is deliberately about
// the MODEL only — no native-vs-browser branch — because the remedy ("pick an image-capable model") is
// the same everywhere, and a distinction the UI never reads is exactly the dead code that hid the
// original bug.
describe("imageUnsupportedReason", () => {
    it("allows an image when the selected model has the image modality", () => {
        expect(
            imageUnsupportedReason({
                selectedModalities: ["text", "image"],
                selectedModelId: "gemma-4-e2b-it-q4",
            }),
        ).toBeUndefined();
    });

    it("blocks a text-only model and NAMES it, so the toast can say which one refused", () => {
        expect(
            imageUnsupportedReason({
                selectedModalities: ["text"],
                selectedModelId: "gemma-3-1b-it-q4",
            }),
        ).toEqual({
            kind: "image_unsupported",
            modelId: "gemma-3-1b-it-q4",
        });
    });

    it("blocks when NO model is selected (no modalities at all)", () => {
        expect(imageUnsupportedReason({ selectedModalities: [] })).toEqual({
            kind: "image_unsupported",
            modelId: undefined,
        });
    });

    it("BROWSER vision is absent, not impossible: an image-capable browser model is allowed", () => {
        // webEligibleModels excludes the 2-FILE (mmproj) shape, not vision itself — a single-file
        // vision GGUF under the ~2 GB wasm32 ceiling already passes that filter. The day the browser
        // capability probe reports "image", this must let it through with no edit here.
        expect(
            imageUnsupportedReason({
                selectedModalities: ["text", "image"],
                selectedModelId: "future-vlm.gguf",
            }),
        ).toBeUndefined();
    });
});

const CARD: ActionCardContent = {
    kind: "action_card_content",
    title: "Log expense",
    rows: [],
    confirmLabel: "Add",
    cancelLabel: "Dismiss",
    actionId: "demo.expense.add",
    state: "pending",
};

const APP: AiAppRegistration = {
    id: 1,
    owner: "owner-principal",
    manifest: {
        name: "Sample App",
        description: "Shared ledger",
        consumerPublicKey: RECIPIENT,
        perUserKeys: true,
        actions: [DEF],
        surfaces: [{ kind: "card", url: "https://app.example/card", display: "sheet" }],
        inboxCanisterId: "aaaaa-aa",
    },
    created: 0n,
    updated: 0n,
    published: true,
};

const DIRECT_CHAT = { kind: "direct_chat", userId: "2vxsx-fae" } as const;
const FATHER_KEY = "-----BEGIN PUBLIC KEY-----\nFATHER\n-----END PUBLIC KEY-----\n";

function directChatClient({
    directory = [],
    exact = [],
    keys = [],
}: {
    directory?: AiAppRegistration[];
    exact?: AiAppRegistration[];
    keys?: { appId: number; publicKey: string }[];
} = {}) {
    const calls = {
        exploreAiApps: vi.fn(async () => ({ matches: directory, total: directory.length })),
        aiApps: vi.fn(async () => exact),
        myAiAppKeys: vi.fn(async () => keys),
        enabledAiApps: vi.fn(),
    };
    return { calls, client: calls as unknown as OpenChat };
}

describe("direct-chat per-user-key candidate resolution", () => {
    beforeEach(() => {
        attestationAvailableMock.mockReturnValue(true);
    });

    it("runs a connected app using this user's key even when the app is absent from the explorer page", async () => {
        const { client, calls } = directChatClient({
            directory: [],
            exact: [APP],
            keys: [{ appId: APP.id, publicKey: FATHER_KEY }],
        });

        await expect(resolveCandidates(client, DIRECT_CHAT)).resolves.toEqual({
            candidates: [
                {
                    app: APP,
                    action: DEF,
                    recipientKey: FATHER_KEY,
                    inboxCanisterId: APP.manifest.inboxCanisterId,
                },
            ],
            linkRequired: [],
            unavailable: [],
        });
        expect(calls.exploreAiApps).toHaveBeenCalledWith(undefined, 0, 8);
        expect(calls.myAiAppKeys).toHaveBeenCalledTimes(1);
        expect(calls.aiApps).toHaveBeenCalledWith([{ appId: APP.id }]);
        expect(calls.enabledAiApps).not.toHaveBeenCalled();
    });

    it("asks to link a published per-user-key app when this user has no key", async () => {
        const { client, calls } = directChatClient({ directory: [APP] });

        await expect(
            proposeAiActionForMessage(
                client,
                DIRECT_CHAT,
                { kind: "text_content", text: "paid 20" },
                { amount: 20 },
            ),
        ).resolves.toEqual({ kind: "link_required", app: APP });
        expect(calls.exploreAiApps).toHaveBeenCalledWith(undefined, 0, 8);
        expect(calls.myAiAppKeys).toHaveBeenCalledTimes(1);
        expect(calls.enabledAiApps).not.toHaveBeenCalled();
        expect(inferOnDeviceMock).not.toHaveBeenCalled();
    });

    it("treats an empty app key as unconnected and never falls back to the manifest key", async () => {
        const { client } = directChatClient({
            directory: [APP],
            exact: [APP],
            keys: [{ appId: APP.id, publicKey: "" }],
        });

        await expect(resolveCandidates(client, DIRECT_CHAT)).resolves.toEqual({
            candidates: [],
            linkRequired: [APP],
            unavailable: [],
        });
    });

    it("does not use a key registered for another app to unlock this app", async () => {
        const { client } = directChatClient({
            directory: [APP],
            keys: [{ appId: APP.id + 1, publicKey: FATHER_KEY }],
        });

        await expect(resolveCandidates(client, DIRECT_CHAT)).resolves.toEqual({
            candidates: [],
            linkRequired: [APP],
            unavailable: [],
        });
    });
});

const CANDIDATE: AiActionCandidate = { app: APP, action: DEF, recipientKey: RECIPIENT };

describe("candidate aggregate bounds", () => {
    it("accepts 31 and 32 actions, and caps a legacy 33-action manifest at 32", async () => {
        attestationAvailableMock.mockReturnValue(true);
        for (const count of [31, 32, 33]) {
            const app: AiAppRegistration = {
                ...APP,
                manifest: {
                    ...APP.manifest,
                    perUserKeys: false,
                    actions: Array.from({ length: count }, (_, index) => ({
                        ...DEF,
                        name: `sample.action.${index}`,
                    })),
                },
            };
            const client = {
                enabledAiApps: vi.fn(async () => [app.id]),
                aiApps: vi.fn(async () => [app]),
                myAiAppKeys: vi.fn(),
            } as unknown as OpenChat;
            const result = await resolveCandidates(client, {
                kind: "group_chat",
                groupId: "aaaaa-aa",
            });
            expect(result.candidates).toHaveLength(Math.min(count, MAX_AI_ACTION_CANDIDATES));
            expect(client.aiApps).toHaveBeenCalledWith([{ appId: app.id }]);
        }
    });
});

function proposalClient(app: AiAppRegistration) {
    const calls = {
        enabledAiApps: vi.fn(async () => [app.id]),
        aiApps: vi.fn(async () => [app]),
        myAiAppKeys: vi.fn(async () => [{ appId: app.id, publicKey: RECIPIENT }]),
        createAiAppCardProvenance: vi.fn(),
        sendMessageWithContent: vi.fn(),
    };
    return { calls, client: calls as unknown as OpenChat };
}

describe("new action-card availability preflight", () => {
    const messageContext: MessageContext = {
        chatId: { kind: "group_chat", groupId: "aaaaa-aa" },
    };
    const content = { kind: "text_content", text: "paid 20" } as const;

    it("the real UI preflight returns the attestation blocker before user-key/model work", async () => {
        const { client, calls } = proposalClient(APP);
        await expect(
            preflightAiActionForMessage(client, messageContext.chatId),
        ).resolves.toMatchObject({
            kind: "actions_unavailable",
            unavailable: [{ reason: "content_attestation_unavailable" }],
        });
        expect(calls.myAiAppKeys).not.toHaveBeenCalled();
        expect(inferOnDeviceMock).not.toHaveBeenCalled();
    });

    it("normal proposal path stops before key lookup, inference, provenance, or posting without full-content attestation", async () => {
        const { client, calls } = proposalClient(APP);
        const result = await proposeAndPost(client, messageContext, content);

        expect(result).toMatchObject({
            kind: "actions_unavailable",
            unavailable: [{ reason: "content_attestation_unavailable" }],
        });
        expect(calls.myAiAppKeys).not.toHaveBeenCalled();
        expect(inferOnDeviceMock).not.toHaveBeenCalled();
        expect(calls.createAiAppCardProvenance).not.toHaveBeenCalled();
        expect(calls.sendMessageWithContent).not.toHaveBeenCalled();
    });

    it("a custom candidate path cannot bypass the content-attestation kill-switch", async () => {
        const { client, calls } = proposalClient(APP);
        const result = await proposeAndPostCandidate(client, messageContext, content, CANDIDATE);

        expect(result).toMatchObject({
            kind: "actions_unavailable",
            unavailable: [{ reason: "content_attestation_unavailable" }],
        });
        expect(inferOnDeviceMock).not.toHaveBeenCalled();
        expect(calls.createAiAppCardProvenance).not.toHaveBeenCalled();
        expect(calls.sendMessageWithContent).not.toHaveBeenCalled();
    });

    it("fails before inference/post with an explicit reason when no valid card surface exists", async () => {
        const app: AiAppRegistration = {
            ...APP,
            manifest: { ...APP.manifest, surfaces: [] },
        };
        const { client, calls } = proposalClient(app);
        const result = await proposeAndPost(client, messageContext, content);

        expect(result).toMatchObject({
            kind: "actions_unavailable",
            unavailable: [{ reason: "missing_card_surface" }],
        });
        expect(inferOnDeviceMock).not.toHaveBeenCalled();
        expect(calls.createAiAppCardProvenance).not.toHaveBeenCalled();
        expect(calls.sendMessageWithContent).not.toHaveBeenCalled();
    });

    it("fails before inference/post with an explicit reason when no inbox route exists", async () => {
        const app: AiAppRegistration = {
            ...APP,
            manifest: { ...APP.manifest, inboxCanisterId: undefined },
        };
        const { client, calls } = proposalClient(app);
        const result = await proposeAndPost(client, messageContext, content);

        expect(result).toMatchObject({
            kind: "actions_unavailable",
            unavailable: [{ reason: "missing_inbox_route" }],
        });
        expect(inferOnDeviceMock).not.toHaveBeenCalled();
        expect(calls.createAiAppCardProvenance).not.toHaveBeenCalled();
        expect(calls.sendMessageWithContent).not.toHaveBeenCalled();
    });
});

describe("provenance before posting", () => {
    const messageContext: MessageContext = {
        chatId: { kind: "group_chat", groupId: "aaaaa-aa" },
    };
    const content = { kind: "text_content", text: "paid 20" } as const;

    beforeEach(() => {
        // These tests exercise the dormant post-attestation pipeline. Production remains false and
        // the proposal-entry tests below prove that no caller reaches this path while it is absent.
        attestationAvailableMock.mockReturnValue(true);
    });

    it("binds provenance and the send to the same preallocated message id", async () => {
        const provenance = new Uint8Array([1, 2, 3]);
        const createAiAppCardProvenance = vi.fn(async () => ({
            provenance,
            expiresAt: BigInt(Date.now() + 60_000),
        }));
        const sendMessageWithContent = vi.fn(async () => ({ kind: "success" }));
        const client = {
            createAiAppCardProvenance,
            sendMessageWithContent,
        } as unknown as OpenChat;

        const result = await proposeAndPostCandidate(client, messageContext, content, CANDIDATE, {
            amount: 20,
        });

        expect(result.kind).toBe("ready");
        const provenanceCalls = createAiAppCardProvenance.mock.calls as unknown as unknown[][];
        const sendCalls = sendMessageWithContent.mock.calls as unknown as unknown[][];
        const provedMessageId = provenanceCalls[0][5] as bigint;
        const exactContent = provenanceCalls[0][3] as Record<string, unknown>;
        const sendArgs = sendCalls[0];
        expect(sendArgs[5]).toBe(provedMessageId);
        expect(sendArgs[1]).toMatchObject({ appProvenance: provenance });
        expect(exactContent).toEqual({
            title: "Log expense",
            rows: [{ label: "Amount", value: "20" }],
            confirmLabel: "Add",
            cancelLabel: "Dismiss",
            actionId: DEF.name,
            disclosure: undefined,
            expiresAt: undefined,
            confirmPayload: new TextEncoder().encode('{"amount":20}'),
        });
        expect(Object.keys(exactContent).sort()).toEqual([
            "actionId",
            "cancelLabel",
            "confirmLabel",
            "confirmPayload",
            "disclosure",
            "expiresAt",
            "rows",
            "title",
        ]);
        expect(createAiAppCardProvenance).toHaveBeenCalledWith(
            APP.id,
            APP.updated,
            DEF.name,
            exactContent,
            messageContext.chatId,
            provedMessageId,
            undefined,
        );
    });

    it("sanitizes image extraction before binding the exact card and payload to provenance", async () => {
        const imageDef: AiActionDefinition = {
            ...DEF,
            acceptsImage: true,
            responseSchema: {
                type: "object",
                properties: {
                    amount: { type: "number", minimum: 0.005, maximum: 100_000 },
                    currency: {
                        type: "string",
                        minLength: 3,
                        maxLength: 3,
                        format: "ascii-uppercase",
                    },
                    date: { type: "string", minLength: 10, maxLength: 10, format: "date" },
                    note: { type: "string", maxLength: 4_096, format: "utf8-no-nul" },
                },
                required: ["amount"],
            },
            card: {
                ...DEF.card,
                rows: [
                    { label: "Amount", valueKey: "amount" },
                    { label: "Currency", valueKey: "currency" },
                    { label: "Date", valueKey: "date" },
                    { label: "Note", valueKey: "note" },
                ],
            },
        };
        const imageApp: AiAppRegistration = {
            ...APP,
            manifest: { ...APP.manifest, actions: [imageDef] },
        };
        const imageCandidate: AiActionCandidate = {
            app: imageApp,
            action: imageDef,
            recipientKey: RECIPIENT,
        };
        const provenance = new Uint8Array([4, 5, 6]);
        const createAiAppCardProvenance = vi.fn(async () => ({
            provenance,
            expiresAt: BigInt(Date.now() + 60_000),
        }));
        const sendMessageWithContent = vi.fn(async () => ({ kind: "success" }));
        const client = {
            createAiAppCardProvenance,
            sendMessageWithContent,
        } as unknown as OpenChat;
        const pixels = new Uint8Array([1, 2, 3, 4]);
        const imageContent = {
            kind: "image_content",
            blobData: pixels,
        } as unknown as Parameters<typeof proposeAndPostCandidate>[2];

        inferenceCapabilityMock.mockReturnValue({
            available: true,
            runtimesSupported: ["llama-cpp"],
            selectedModalities: ["text", "image"],
            selectedModelId: "vision-test",
        });
        inferOnDeviceMock.mockResolvedValueOnce({
            kind: "ok",
            text: JSON.stringify({
                amount: 20,
                currency: "$$$",
                date: "08/07/2026",
                note: `visible${String.fromCharCode(0)}hidden`,
            }),
        });

        const result = await proposeAndPostCandidate(
            client,
            messageContext,
            imageContent,
            imageCandidate,
        );

        expect(result.kind).toBe("ready");
        expect(inferOnDeviceMock).toHaveBeenCalledTimes(1);
        expect(inferOnDeviceMock.mock.calls[0][0].image).toEqual(pixels);
        const provenanceCalls = createAiAppCardProvenance.mock.calls as unknown as unknown[][];
        const sendCalls = sendMessageWithContent.mock.calls as unknown as unknown[][];
        const exactContent = provenanceCalls[0][3] as Record<string, unknown>;
        const provedMessageId = provenanceCalls[0][5] as bigint;
        expect(exactContent).toEqual({
            title: "Log expense",
            rows: [{ label: "Amount", value: "20" }],
            confirmLabel: "Add",
            cancelLabel: "Dismiss",
            actionId: imageDef.name,
            disclosure: undefined,
            expiresAt: undefined,
            confirmPayload: new TextEncoder().encode('{"amount":20}'),
        });
        expect(sendCalls[0][5]).toBe(provedMessageId);
        expect(sendCalls[0][1]).toMatchObject({ appProvenance: provenance });
    });

    it("binds a thread card to Some(threadRootMessageIndex)", async () => {
        const createAiAppCardProvenance = vi.fn(async () => ({
            provenance: new Uint8Array([9]),
            expiresAt: BigInt(Date.now() + 60_000),
        }));
        const client = {
            createAiAppCardProvenance,
            sendMessageWithContent: vi.fn(async () => ({ kind: "success" })),
        } as unknown as OpenChat;
        const threadContext: MessageContext = { ...messageContext, threadRootMessageIndex: 42 };
        await proposeAndPostCandidate(client, threadContext, content, CANDIDATE, { amount: 20 });
        const provenanceCalls = createAiAppCardProvenance.mock.calls as unknown as unknown[][];
        expect(provenanceCalls[0][6]).toBe(42);
    });

    it("fails closed and never sends when authoritative provenance is unavailable", async () => {
        const sendMessageWithContent = vi.fn();
        const client = {
            createAiAppCardProvenance: vi.fn(async () => undefined),
            sendMessageWithContent,
        } as unknown as OpenChat;
        const result = await proposeAndPostCandidate(client, messageContext, content, CANDIDATE, {
            amount: 20,
        });
        expect(result.kind).toBe("error");
        expect(sendMessageWithContent).not.toHaveBeenCalled();
    });

    it("never mints provenance or sends for a multi-entry manual extraction", async () => {
        const createAiAppCardProvenance = vi.fn();
        const sendMessageWithContent = vi.fn();
        const client = {
            createAiAppCardProvenance,
            sendMessageWithContent,
        } as unknown as OpenChat;
        const result = await proposeAndPostCandidate(client, messageContext, content, CANDIDATE, [
            { amount: 20 },
            { amount: 30 },
        ]);
        expect(result.kind).toBe("error");
        expect(createAiAppCardProvenance).not.toHaveBeenCalled();
        expect(sendMessageWithContent).not.toHaveBeenCalled();
    });
});

// Proposing that ends without a word is the defect this whole describe exists for: a user taps
// "Propose action", nothing happens, nothing is said, and there is no way to tell a bug from an app
// with nothing to offer. Keying the table by ProposeResult["kind"] means a NEW kind fails to compile
// here too, so the table can never quietly stop covering the union it claims to cover.
const EVERY_RESULT: Record<ProposeResult["kind"], ProposeResult> = {
    ready: { kind: "ready", card: CARD, extracted: { amount: 20 } },
    ready_multi: { kind: "ready_multi", card: CARD, extracted: [{ amount: 20 }] },
    choose: { kind: "choose", candidates: [CANDIDATE] },
    link_required: { kind: "link_required", app: APP },
    actions_unavailable: {
        kind: "actions_unavailable",
        unavailable: [{ app: APP, reason: "content_attestation_unavailable" }],
    },
    no_actions: { kind: "no_actions" },
    unavailable: { kind: "unavailable", reason: "no model" },
    unsupported_content: { kind: "unsupported_content" },
    image_unsupported: { kind: "image_unsupported", modelId: "gemma-3-1b-it-q4" },
    image_not_accepted: { kind: "image_not_accepted" },
    no_extraction: { kind: "no_extraction", raw: "{}" },
    error: { kind: "error", error: "boom" },
};

// The four kinds the FLOW is still working on (a card was posted, or a chooser/consent surface is
// up). Everything else is a dead end and must explain itself.
const SILENT_KINDS = ["ready", "ready_multi", "choose", "link_required"] as const;

describe("proposeFailureMessage", () => {
    for (const [kind, result] of Object.entries(EVERY_RESULT) as [
        ProposeResult["kind"],
        ProposeResult,
    ][]) {
        if ((SILENT_KINDS as readonly string[]).includes(kind)) {
            it(`says nothing for "${kind}" — the flow is not finished with it`, () => {
                expect(proposeFailureMessage(result)).toBeUndefined();
            });
            continue;
        }
        it(`always has something to say about "${kind}"`, () => {
            const message = proposeFailureMessage(result);
            expect(message).toEqual(expect.any(String));
            expect(message!.length).toBeGreaterThan(0);
        });
    }

    it('points a model-less user at where to get one, for "unavailable"', () => {
        expect(proposeFailureMessage({ kind: "unavailable", reason: "no runtime" })).toMatch(
            /on-device model/,
        );
    });

    it("NAMES the model that refused an image, so the user knows which one to replace", () => {
        const message = proposeFailureMessage({
            kind: "image_unsupported",
            modelId: "gemma-3-1b-it-q4",
        });
        expect(message).toContain("gemma-3-1b-it-q4");
        expect(message).toMatch(/doesn't support images/);
    });

    it("falls back to 'This model' when no model is selected at all", () => {
        expect(proposeFailureMessage({ kind: "image_unsupported" })).toMatch(
            /^This model doesn't support images/,
        );
    });

    it("distinguishes an app action that did not opt into images from a text-only model", () => {
        expect(proposeFailureMessage({ kind: "image_not_accepted" })).toBe(
            "This app action doesn't accept images. Choose an image-enabled action or send the details as text.",
        );
    });
});

const resolving = (result: ProposeResult) => vi.fn(async () => result);

// The propose flow, exercised with every dependency injected: no model, no Tauri, no component. It
// lived inside two hand-maintained ChatMessage trees until one was fixed and the other was not —
// nothing could reach it except a click, so nothing caught the difference.
function flowDeps(overrides: Partial<ProposeFlowDeps> = {}): {
    [K in keyof ProposeFlowDeps]: ReturnType<typeof vi.fn>;
} & ProposeFlowDeps {
    const deps = {
        preflight: vi.fn(async () => undefined),
        canInfer: vi.fn(() => true),
        promptForExtraction: vi.fn(() => undefined),
        propose: resolving({ kind: "ready", card: CARD, extracted: {} }),
        proposeCandidate: resolving({ kind: "ready", card: CARD, extracted: {} }),
        chooseCandidate: vi.fn(async () => undefined),
        linkApp: vi.fn(async () => false),
        toast: vi.fn(),
        ...overrides,
    };
    return deps as ReturnType<typeof flowDeps>;
}

describe("runProposeFlow", () => {
    it("reports an attestation blocker before model checks, prompts, or proposal work", async () => {
        const blocker: ProposeResult = {
            kind: "actions_unavailable",
            unavailable: [{ app: APP, reason: "content_attestation_unavailable" }],
        };
        const deps = flowDeps({
            preflight: vi.fn(async () => blocker),
            canInfer: vi.fn(() => false),
        });
        await runProposeFlow(deps);
        expect(deps.toast).toHaveBeenCalledWith(expect.stringContaining("temporarily unavailable"));
        expect(deps.canInfer).not.toHaveBeenCalled();
        expect(deps.promptForExtraction).not.toHaveBeenCalled();
        expect(deps.propose).not.toHaveBeenCalled();
    });

    it("with no model and nothing supplied, TELLS the user instead of doing nothing", async () => {
        const deps = flowDeps({ canInfer: vi.fn(() => false) });
        await runProposeFlow(deps);
        expect(deps.toast).toHaveBeenCalledWith(NO_MODEL_MESSAGE);
        expect(deps.propose).not.toHaveBeenCalled();
    });

    it("says the SAME thing when the manual seam is on but its prompt is dismissed", async () => {
        // The seam answering `undefined` means "no extraction available" — identical to it being off.
        // Branching on the seam before deciding whether to speak is what made a stale
        // `oc:manualExtract` (or a browser suppressing repeat dialogs) look like a dead button.
        const deps = flowDeps({
            canInfer: vi.fn(() => false),
            promptForExtraction: vi.fn(() => undefined),
        });
        await runProposeFlow(deps);
        expect(deps.toast).toHaveBeenCalledWith(NO_MODEL_MESSAGE);
        expect(deps.propose).not.toHaveBeenCalled();
    });

    it("with no model but an extraction supplied, proposes with it and stays quiet", async () => {
        const deps = flowDeps({
            canInfer: vi.fn(() => false),
            promptForExtraction: vi.fn(() => ({ amount: 20 })),
        });
        await runProposeFlow(deps);
        expect(deps.propose).toHaveBeenCalledWith({ amount: 20 });
        expect(deps.toast).not.toHaveBeenCalled();
    });

    it("checks the inert manual seam before using an available model", async () => {
        const deps = flowDeps({ canInfer: vi.fn(() => true) });
        await runProposeFlow(deps);
        expect(deps.promptForExtraction).toHaveBeenCalledOnce();
        expect(deps.propose).toHaveBeenCalled();
    });

    it("lets the explicit manual test seam override an available model deterministically", async () => {
        const deps = flowDeps({
            canInfer: vi.fn(() => true),
            promptForExtraction: vi.fn(() => ({ amount: 20 })),
        });
        await runProposeFlow(deps);
        expect(deps.propose).toHaveBeenCalledWith({ amount: 20 });
        expect(deps.canInfer).not.toHaveBeenCalled();
        expect(deps.toast).not.toHaveBeenCalled();
    });

    it("an 'unavailable' propose reaches the toast even when the retry prompt gives nothing", async () => {
        const deps = flowDeps({
            propose: resolving({ kind: "unavailable", reason: "no runtime" }),
            promptForExtraction: vi.fn(() => undefined),
        });
        await runProposeFlow(deps);
        expect(deps.toast).toHaveBeenCalledWith(NO_MODEL_MESSAGE);
    });

    // THE branch the mobile tree still got wrong: after the chooser, an `unavailable` whose retry
    // prompt supplies nothing used to `return` — so a user with two candidate actions and no model
    // picked one and was told nothing at all.
    it("a CHOSEN candidate that comes back 'unavailable' still explains itself", async () => {
        const deps = flowDeps({
            propose: resolving({ kind: "choose", candidates: [CANDIDATE] }),
            chooseCandidate: vi.fn(async () => CANDIDATE),
            proposeCandidate: resolving({ kind: "unavailable", reason: "no runtime" }),
            promptForExtraction: vi.fn(() => undefined),
        });
        await runProposeFlow(deps);
        expect(deps.chooseCandidate).toHaveBeenCalledWith([CANDIDATE]);
        expect(deps.toast).toHaveBeenCalledWith(NO_MODEL_MESSAGE);
    });

    it("backing out of the chooser is a choice — no candidate runs, nothing is claimed", async () => {
        const deps = flowDeps({
            propose: resolving({ kind: "choose", candidates: [CANDIDATE] }),
            chooseCandidate: vi.fn(async () => undefined),
        });
        await runProposeFlow(deps);
        expect(deps.proposeCandidate).not.toHaveBeenCalled();
        expect(deps.toast).not.toHaveBeenCalled();
    });

    it("re-proposes with the SAME extraction once the app is linked", async () => {
        const propose = vi
            .fn()
            .mockResolvedValueOnce({ kind: "link_required", app: APP })
            .mockResolvedValueOnce({ kind: "ready", card: CARD, extracted: {} });
        const deps = flowDeps({
            canInfer: vi.fn(() => false),
            promptForExtraction: vi.fn(() => ({ amount: 20 })),
            propose,
            linkApp: vi.fn(async () => true),
        });
        await runProposeFlow(deps);
        expect(deps.linkApp).toHaveBeenCalledWith(APP);
        expect(propose.mock.calls).toEqual([[{ amount: 20 }], [{ amount: 20 }]]);
        expect(deps.toast).not.toHaveBeenCalled();
    });

    it("a refused link stops the flow — the consent sheet already said its piece", async () => {
        const deps = flowDeps({
            propose: resolving({ kind: "link_required", app: APP }),
            linkApp: vi.fn(async () => false),
        });
        await runProposeFlow(deps);
        expect(deps.propose).toHaveBeenCalledTimes(1);
        expect(deps.toast).not.toHaveBeenCalled();
    });
});

// Crude on purpose. The two ChatMessage trees are near-copies, and the only reason the silent propose
// survived in one of them is that the fix went into whichever file someone had open. Nothing else
// notices when the trees drift: an external live harness selects `.bubble-wrapper`, which exists only in the classic
// tree, so it has never once looked at the mobile one.
describe("both ChatMessage trees run the SHARED propose flow", () => {
    const TREES = {
        classic: "../components/home/ChatMessage.svelte",
        mobile: "../components_mobile/home/ChatMessage.svelte",
    };

    for (const [tree, relative] of Object.entries(TREES)) {
        it(`${tree}: delegates to runProposeFlow and keeps no copy of the decisions`, () => {
            const src = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
            expect(src).toContain("runProposeFlow(");
            // Deciding for itself whether a model exists is how a tree starts owning the flow again.
            expect(src).not.toContain("canInferOnDevice()");
            // A second copy of the message is a second thing to forget to fix.
            expect(src).not.toContain("No on-device model is ready");
        });
    }
});
