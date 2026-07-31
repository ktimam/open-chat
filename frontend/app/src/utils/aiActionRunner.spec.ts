import { beforeEach, describe, expect, it, vi } from "vitest";

// These specs pin the MANUAL-extraction gate: the manual path (no on-device runtime — the caller
// supplies the extraction) must run the SAME deterministic pass as the model path (rules post-pass +
// schema conformance + required-fields check) before a card is built. Previously it built the card
// straight from the caller-supplied object, so a degenerate value (e.g. amount 0 against a schema
// requiring amount > 0) posted a confirm card the consumer app then rejected as an invalid draft.

// aiActionRunner imports the on-device inference facade at module level; stub it so importing the
// module never touches the Tauri bridge (the manual path performs no inference at all).
vi.mock("./onDeviceInference", () => ({
    inferOnDevice: vi.fn(async () => ({ kind: "unavailable", reason: "not in tests" })),
}));

import type { ActionCardContent, AiActionDefinition, AiAppRegistration } from "openchat-shared";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
    buildManualCard,
    manualExtractEnabled,
    imageUnsupportedReason,
    proposeFailureMessage,
    runProposeFlow,
    NO_MODEL_MESSAGE,
    type AiActionCandidate,
    type ProposeFlowDeps,
    type ProposeResult,
} from "./aiActionRunner";

const RECIPIENT = "-----BEGIN PUBLIC KEY-----\nABC\n-----END PUBLIC KEY-----\n";

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

    it("an ARRAY of two valid entries builds ONE multi card with an array confirmPayload", () => {
        const r = buildManualCard(
            DEF,
            [
                { kind: "expense", amount: 20, currency: "USD" },
                { kind: "expense", amount: 30, currency: "EUR" },
            ],
            RECIPIENT,
        );
        expect(r.kind).toBe("ready_multi");
        if (r.kind === "ready_multi") {
            expect(JSON.parse(new TextDecoder().decode(r.card.confirmPayload!))).toEqual([
                { kind: "expense", amount: 20, currency: "USD" },
                { kind: "expense", amount: 30, currency: "EUR" },
            ]);
            // One visible summary row per entry; the multi card also appends a hidden "__oc_" sentinel
            // row carrying the exact entry array to the app-rendered card, so filter it out here.
            expect(r.card.rows.filter((row) => !row.label.startsWith("__oc_")).length).toBe(2);
            expect(r.card.title).toContain("2");
        }
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
        expect(imageUnsupportedReason({ selectedModalities: ["text"], selectedModelId: "gemma-3-1b-it-q4" })).toEqual({
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
        // Written when the browser refused every image, to pin that the refusal lived in the model
        // gates and not here. Browser vision has since landed (webEligibleModels accepts a
        // weights+mmproj pair, webInfer has a vision path, the probe reports what the model says) —
        // and this assertion carried it through with no edit, which was the point.
        expect(
            imageUnsupportedReason({ selectedModalities: ["text", "image"], selectedModelId: "future-vlm.gguf" }),
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
        name: "IOU",
        description: "Shared ledger",
        consumerPublicKey: RECIPIENT,
        perUserKeys: true,
        actions: [DEF],
    },
    created: 0n,
    updated: 0n,
    published: true,
};

const CANDIDATE: AiActionCandidate = { app: APP, action: DEF, recipientKey: RECIPIENT };

// Proposing that ends without a word is the defect this whole describe exists for: a user taps
// "Propose action", nothing happens, nothing is said, and there is no way to tell a bug from an app
// with nothing to offer. Keying the table by ProposeResult["kind"] means a NEW kind fails to compile
// here too, so the table can never quietly stop covering the union it claims to cover.
const EVERY_RESULT: Record<ProposeResult["kind"], ProposeResult> = {
    ready: { kind: "ready", card: CARD, extracted: { amount: 20 } },
    ready_multi: { kind: "ready_multi", card: CARD, extracted: [{ amount: 20 }] },
    choose: { kind: "choose", candidates: [CANDIDATE] },
    link_required: { kind: "link_required", app: APP },
    no_actions: { kind: "no_actions" },
    unavailable: { kind: "unavailable", reason: "no model" },
    unsupported_content: { kind: "unsupported_content" },
    image_unsupported: { kind: "image_unsupported", modelId: "gemma-3-1b-it-q4" },
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
});

const resolving = (result: ProposeResult) => vi.fn(async () => result);

// The propose flow, exercised with every dependency injected: no model, no Tauri, no component. It
// lived inside two hand-maintained ChatMessage trees until one was fixed and the other was not —
// nothing could reach it except a click, so nothing caught the difference.
function flowDeps(overrides: Partial<ProposeFlowDeps> = {}): {
    [K in keyof ProposeFlowDeps]: ReturnType<typeof vi.fn>;
} & ProposeFlowDeps {
    const deps = {
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

    it("never opens the manual prompt when a model IS available", async () => {
        const deps = flowDeps({ canInfer: vi.fn(() => true) });
        await runProposeFlow(deps);
        expect(deps.promptForExtraction).not.toHaveBeenCalled();
        expect(deps.propose).toHaveBeenCalled();
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
// notices when the trees drift: the one live harness that covers this (IOU's
// scripts/live/verify-nomodel-guide.ts) selects `.bubble-wrapper`, which exists only in the classic
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
