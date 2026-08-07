import { beforeEach, describe, expect, it, vi } from "vitest";

// The image-unsupported gate, tested THROUGH the two doors real users come in by
// (proposeAiActionForMessage = the message menu, proposeAndPostCandidate = the auto-propose chip)
// rather than through the pure policy function.
//
// imageUnsupportedReason is already pinned in aiActionRunner.spec.ts, and it kept passing while the
// thing that actually mattered — that the bytes never reach the runtime — was pinned nowhere. Proposing
// on a photo with a text-only model shipped the image into llama.cpp anyway: in the browser the propose
// silently did nothing, and on desktop a debug-CRT build fail-fasts inside clip/mmproj so the whole app
// vanishes with no toast, no log and no way for the user to know what happened. Hence the load-bearing
// assertion in every case below is `expect(infer).not.toHaveBeenCalled()`.
//
// Lives in its own file (not aiActionRunner.spec.ts) because it needs the on-device facade mocked
// WHOLE — capability included — and that spec deliberately stubs only inferOnDevice.

import type { AiAppRegistration, MessageContent, MessageContext, OpenChat } from "@client";
import type { OnDeviceInferenceCapability } from "@shared";

// The on-device facade, replaced entirely: `capability` is what the gate reads, `inferOnDevice` is the
// runtime the gate is supposed to keep the image away from. Both must be stubbed here — reaching the
// real onDeviceInferenceCapability drags in the Tauri bridge and the model stores.
const facade = vi.hoisted(() => ({
    capability: {
        available: true,
        runtimesSupported: ["llama-cpp"],
        selectedModalities: ["text"],
        selectedModelId: "gemma-3-1b-it-q4",
    } as OnDeviceInferenceCapability,
}));

vi.mock("./onDeviceInference", () => ({
    inferOnDevice: vi.fn(async () => ({ kind: "ok", text: '{"amount":20}' })),
    onDeviceInferenceCapability: () => facade.capability,
}));

// This suite isolates the model-modality gate. The production switch remains false; overriding it
// here prevents the separate app-content-attestation preflight from short-circuiting these tests.
vi.mock("./aiActionAvailability", () => ({
    appContentAttestationAvailable: () => true,
}));

import { proposeAiActionForMessage, proposeAndPostCandidate } from "./aiActionRunner";
import { inferOnDevice } from "./onDeviceInference";

const infer = vi.mocked(inferOnDevice);

const RECIPIENT = "-----BEGIN PUBLIC KEY-----\nABC\n-----END PUBLIC KEY-----\n";
const PIXELS = new Uint8Array([1, 2, 3, 4]);

const ACTION = {
    name: "demo.expense.add",
    description: "Log expense",
    promptTemplate: "extract the transaction as JSON",
    acceptsImage: true,
    responseSchema: {
        type: "object",
        properties: { amount: { type: "number", exclusiveMinimum: 0 } },
        required: ["amount"],
    },
    card: {
        title: "Log expense",
        rows: [{ label: "Amount", valueKey: "amount" }],
        confirmLabel: "Add",
        cancelLabel: "Dismiss",
    },
};

// A per-user-keys app the user HAS linked, so a direct chat resolves to exactly one runnable
// candidate and propose goes straight to runDefinition — the only place the gate lives.
const APP = {
    id: 7,
    owner: "owner",
    published: true,
    manifest: {
        name: "sample-app",
        description: "Sample app",
        consumerPublicKey: "",
        perUserKeys: true,
        actions: [ACTION],
        surfaces: [{ kind: "card", url: "https://app.example/card", display: "sheet" }],
        inboxCanisterId: "aaaaa-aa",
    },
    created: 0n,
    updated: 0n,
} as unknown as AiAppRegistration;

const CHAT = { kind: "group_chat", groupId: "aaaaa-aa" } as const;
const CONTEXT = { chatId: CHAT } as unknown as MessageContext;

const sendMessageWithContent = vi.fn(async () => ({ kind: "success" }));

const client = {
    enabledAiApps: async () => [APP.id],
    aiApps: async () => [APP],
    myAiAppKeys: async () => [{ appId: APP.id, publicKey: RECIPIENT }],
    aiAppUserKeys: async () => [],
    sendMessageWithContent,
} as unknown as OpenChat;

// contentToInput prefers blobData over blobUrl, so a just-sent image needs no fetch plumbing here.
const IMAGE = { kind: "image_content", blobData: PIXELS } as unknown as MessageContent;
const TEXT = { kind: "text_content", text: "Owe me 300 uber" } as unknown as MessageContent;

const CANDIDATE = {
    app: APP,
    action: ACTION,
    recipientKey: RECIPIENT,
} as unknown as Parameters<typeof proposeAndPostCandidate>[3];

function candidateWithAcceptsImage(acceptsImage: boolean | undefined) {
    const action = { ...ACTION, acceptsImage };
    const app = {
        ...APP,
        manifest: { ...APP.manifest, actions: [action] },
    } as unknown as AiAppRegistration;
    return {
        app,
        action,
        recipientKey: RECIPIENT,
    } as unknown as Parameters<typeof proposeAndPostCandidate>[3];
}

function withCapability(selectedModalities: ("text" | "image")[], selectedModelId?: string) {
    facade.capability = {
        available: true,
        runtimesSupported: ["llama-cpp"],
        selectedModalities,
        selectedModelId,
    };
}

describe("image gate (propose on a photo)", () => {
    beforeEach(() => {
        infer.mockClear();
        sendMessageWithContent.mockClear();
        withCapability(["text"], "gemma-3-1b-it-q4");
    });

    it("a text-only model never sees the image bytes, and the refusal NAMES it", async () => {
        const r = await proposeAiActionForMessage(client, CHAT, IMAGE);
        // Asserted first on purpose: this is the crash. Naming the model only makes the toast useful;
        // not calling the runtime is what stops a debug build dying inside clip/mmproj with the app
        // simply disappearing.
        expect(infer).not.toHaveBeenCalled();
        expect(r).toEqual({ kind: "image_unsupported", modelId: "gemma-3-1b-it-q4" });
    });

    it("no model selected at all is refused the same way, still without an inference", async () => {
        withCapability([], undefined);
        const r = await proposeAiActionForMessage(client, CHAT, IMAGE);
        expect(infer).not.toHaveBeenCalled();
        expect(r).toEqual({ kind: "image_unsupported", modelId: undefined });
    });

    it("an image-capable model IS allowed through, with the exact bytes — the gate is not a blanket refusal", async () => {
        withCapability(["text", "image"], "smolvlm-256m-instruct-q8");
        const r = await proposeAiActionForMessage(client, CHAT, IMAGE);
        expect(r.kind).not.toBe("image_unsupported");
        expect(r.kind).toBe("ready");
        expect(infer).toHaveBeenCalledTimes(1);
        expect(infer.mock.calls[0][0].image).toEqual(PIXELS);
    });

    it("TEXT against the same text-only model runs normally — the gate keys on the IMAGE, not the model", async () => {
        // Guards the obvious "simplification": dropping the `input.image !== undefined` condition and
        // gating on the capability alone, which would refuse every ordinary text propose on a 1B model.
        const r = await proposeAiActionForMessage(client, CHAT, TEXT);
        expect(r.kind).not.toBe("image_unsupported");
        expect(infer).toHaveBeenCalledTimes(1);
        expect(infer.mock.calls[0][0].image).toBeUndefined();
    });

    it("the chooser/auto-propose door is gated too — one gate, both entry points", async () => {
        // proposeAndPostCandidate bypasses resolveCandidates entirely (the user already picked), so it
        // would be a second, ungated path into the runtime if the check lived in the caller.
        const r = await proposeAndPostCandidate(client, CONTEXT, IMAGE, CANDIDATE);
        expect(infer).not.toHaveBeenCalled();
        expect(sendMessageWithContent).not.toHaveBeenCalled();
        expect(r).toEqual({ kind: "image_unsupported", modelId: "gemma-3-1b-it-q4" });
    });

    for (const [label, acceptsImage] of [
        ["explicitly false", false],
        ["omitted", undefined],
    ] as const) {
        it(`an action whose acceptsImage flag is ${label} never receives image bytes`, async () => {
            withCapability(["text", "image"], "vision-test");
            const r = await proposeAndPostCandidate(
                client,
                CONTEXT,
                IMAGE,
                candidateWithAcceptsImage(acceptsImage),
            );

            expect(infer).not.toHaveBeenCalled();
            expect(sendMessageWithContent).not.toHaveBeenCalled();
            expect(r).toEqual({ kind: "image_not_accepted" });
        });
    }

    it("acceptsImage only governs images; an opted-out action still receives ordinary text", async () => {
        const candidate = candidateWithAcceptsImage(false);
        const textClient = {
            ...client,
            aiApps: async () => [candidate.app],
        } as unknown as OpenChat;

        const r = await proposeAiActionForMessage(textClient, CHAT, TEXT);

        expect(r.kind).toBe("ready");
        expect(infer).toHaveBeenCalledTimes(1);
        expect(infer.mock.calls[0][0].image).toBeUndefined();
    });
});
