// @vitest-environment node
import {
    Gemma4ForConditionalGeneration,
    PretrainedConfig,
    Tensor,
} from "@huggingface/transformers";
import { Tensor as NodeOrtTensor } from "onnxruntime-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    GEMMA4_AUDIO_TOKEN_ID,
    GEMMA4_BASE_EMBEDDING_LAYOUT,
    GEMMA4_IMAGE_TOKEN_ID,
    GEMMA4_PER_LAYER_BYTES_PER_TOKEN,
} from "./gemma4WebGpuEmbedding";

// Exercise the installed HF implementation, not a reimplementation of its scatter. Only learned
// ONNX sessions are replaced by deterministic CPU tensors. This proves the forward-path boundary,
// not audio-encoder semantics, WebGPU execution, recognition accuracy, or UI prompt behavior.
type OrtFeed = Record<string, Tensor["ort_tensor"]>;
const WIDTH = GEMMA4_BASE_EMBEDDING_LAYOUT.width;
const TOKENS = 6;
const PER_LAYER_WIDTH = GEMMA4_PER_LAYER_BYTES_PER_TOKEN / Float32Array.BYTES_PER_ELEMENT;

function floatTensor(dims: number[], start: number): Tensor {
    const length = dims.reduce((product, size) => product * size, 1);
    return new Tensor(
        "float32",
        Float32Array.from({ length }, (_, index) => start + index / 8),
        dims,
    );
}

function forwardFixture(featureCount = 2, featureStart = 1000) {
    const calls: string[] = [];
    const inputIds = new Tensor(
        "int64",
        BigInt64Array.from([11, GEMMA4_AUDIO_TOKEN_ID, 12, 13, GEMMA4_AUDIO_TOKEN_ID, 14], BigInt),
        [1, TOKENS],
    );
    const attentionMask = new Tensor("int64", BigInt64Array.from([1n, 1n, 1n, 1n, 1n, 0n]), [
        1,
        TOKENS,
    ]);
    const inputFeatures = floatTensor([1, 7, 128], 0.5);
    const inputFeaturesMask = new Tensor("bool", Uint8Array.from([1, 1, 1, 1, 1, 1, 0]), [1, 7]);
    const embeddings = floatTensor([1, TOKENS, WIDTH], -2000);
    const perLayer = floatTensor([1, TOKENS, 35, PER_LAYER_WIDTH / 35], -4000);
    const initialEmbeddings = Float32Array.from(embeddings.data as Float32Array);
    const initialPerLayer = Float32Array.from(perLayer.data as Float32Array);
    const audioFeatures = floatTensor([1, featureCount, WIDTH], featureStart);
    const initialAudioFeatures = Float32Array.from(audioFeatures.data as Float32Array);
    const logits = floatTensor([1, 1, 2], 42);
    // HF's Node backend identifies real session outputs with onnxruntime-node's constructor.
    // Its bundled Tensor constructor is not the native backend's constructor; return native
    // ORT tensors so the real sessionRun output wrapping is exercised too.
    const ortEmbeddings = new NodeOrtTensor(
        "float32",
        embeddings.data as Float32Array,
        embeddings.dims,
    );
    const ortPerLayer = new NodeOrtTensor("float32", perLayer.data as Float32Array, perLayer.dims);
    const ortAudioFeatures = new NodeOrtTensor(
        "float32",
        audioFeatures.data as Float32Array,
        audioFeatures.dims,
    );
    const ortLogits = new NodeOrtTensor("float32", logits.data as Float32Array, logits.dims);
    const embedRun = vi.fn(async (feed: OrtFeed) => {
        calls.push("embed_tokens");
        expect(feed.input_ids).toBe(inputIds.ort_tensor);
        return { inputs_embeds: ortEmbeddings, per_layer_inputs: ortPerLayer };
    });
    const audioRun = vi.fn(async (feed: OrtFeed) => {
        calls.push("audio_encoder");
        expect(feed.input_features).toBe(inputFeatures.ort_tensor);
        expect(feed.input_features_mask).toBe(inputFeaturesMask.ort_tensor);
        return { audio_features: ortAudioFeatures };
    });
    const decoderRun = vi.fn(async (_feed: OrtFeed) => {
        calls.push("decoder_model_merged");
        return { logits: ortLogits };
    });
    const model = new Gemma4ForConditionalGeneration(
        new PretrainedConfig({
            model_type: "gemma4",
            audio_token_id: GEMMA4_AUDIO_TOKEN_ID,
            image_token_id: GEMMA4_IMAGE_TOKEN_ID,
            text_config: { num_hidden_layers: 35, hidden_size: WIDTH },
        }),
        {
            embed_tokens: { inputNames: ["input_ids"], run: embedRun },
            audio_encoder: {
                inputNames: ["input_features", "input_features_mask"],
                run: audioRun,
            },
            decoder_model_merged: {
                inputNames: ["inputs_embeds", "per_layer_inputs", "attention_mask"],
                inputMetadata: [],
                run: decoderRun,
            },
        },
        {},
    );
    return {
        model,
        calls,
        inputIds,
        attentionMask,
        embeddings,
        perLayer,
        ortEmbeddings,
        ortPerLayer,
        initialEmbeddings,
        initialPerLayer,
        audioFeatures,
        initialAudioFeatures,
        logits,
        embedRun,
        audioRun,
        decoderRun,
        forward: () =>
            model.forward({
                input_ids: inputIds,
                attention_mask: attentionMask,
                input_features: inputFeatures,
                input_features_mask: inputFeaturesMask,
            }),
    };
}

describe("installed HF Gemma 4 audio forward/scatter (no model weights)", () => {
    const fetchForbidden = vi.fn(() => {
        throw new Error("This CPU-only forward regression must not fetch model files.");
    });

    beforeEach(() => {
        fetchForbidden.mockClear();
        vi.stubGlobal("fetch", fetchForbidden);
    });

    afterEach(() => {
        expect(fetchForbidden).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it.each([1000, -1000])(
        "passes sentinel audio features beginning at %i to the decoder, preserving other inputs",
        async (featureStart) => {
            const fixture = forwardFixture(2, featureStart);
            try {
                const output = await fixture.forward();
                expect(fixture.calls).toEqual([
                    "embed_tokens",
                    "audio_encoder",
                    "decoder_model_merged",
                ]);
                expect(fixture.embedRun).toHaveBeenCalledTimes(1);
                expect(fixture.audioRun).toHaveBeenCalledTimes(1);
                expect(fixture.decoderRun).toHaveBeenCalledTimes(1);
                const feed = fixture.decoderRun.mock.calls[0][0];
                expect(feed.inputs_embeds).toBe(fixture.ortEmbeddings);
                expect(feed.inputs_embeds.dims).toEqual([1, TOKENS, WIDTH]);
                expect(feed.inputs_embeds.type).toBe("float32");
                const decoderEmbeddings = feed.inputs_embeds.data as Float32Array;
                // The two audio positions are deliberately nonadjacent. Check literal slices
                // at the session boundary; no local scatter implementation participates.
                expect(decoderEmbeddings.slice(WIDTH, 2 * WIDTH)).toEqual(
                    fixture.initialAudioFeatures.slice(0, WIDTH),
                );
                expect(decoderEmbeddings.slice(4 * WIDTH, 5 * WIDTH)).toEqual(
                    fixture.initialAudioFeatures.slice(WIDTH, 2 * WIDTH),
                );
                for (const textPosition of [0, 2, 3, 5]) {
                    expect(
                        decoderEmbeddings.slice(textPosition * WIDTH, (textPosition + 1) * WIDTH),
                    ).toEqual(
                        fixture.initialEmbeddings.slice(
                            textPosition * WIDTH,
                            (textPosition + 1) * WIDTH,
                        ),
                    );
                }
                expect(feed.per_layer_inputs).toBe(fixture.ortPerLayer);
                expect(feed.per_layer_inputs.dims).toEqual([1, TOKENS, 35, 256]);
                expect(feed.per_layer_inputs.data).toEqual(fixture.initialPerLayer);
                expect(feed.attention_mask).toBe(fixture.attentionMask.ort_tensor);
                expect(feed.attention_mask.data).toEqual(
                    BigInt64Array.from([1n, 1n, 1n, 1n, 1n, 0n]),
                );
                expect(fixture.audioFeatures.data).toEqual(fixture.initialAudioFeatures);
                expect(fixture.inputIds.tolist()).toEqual([
                    [
                        11n,
                        BigInt(GEMMA4_AUDIO_TOKEN_ID),
                        12n,
                        13n,
                        BigInt(GEMMA4_AUDIO_TOKEN_ID),
                        14n,
                    ],
                ]);
                expect(output.logits).toBeInstanceOf(Tensor);
                expect(output.logits.data).toEqual(fixture.logits.data);
            } finally {
                await fixture.model.dispose();
            }
        },
    );

    it.each([1, 3])(
        "rejects %i audio feature rows for two audio tokens before mutating embeddings or calling the decoder",
        async (featureCount) => {
            const fixture = forwardFixture(featureCount);
            try {
                await expect(fixture.forward()).rejects.toThrow(
                    `Number of tokens and features do not match: tokens: 2, features ${featureCount}`,
                );
                expect(fixture.calls).toEqual(["embed_tokens", "audio_encoder"]);
                expect(fixture.decoderRun).not.toHaveBeenCalled();
                expect(fixture.embeddings.data).toEqual(fixture.initialEmbeddings);
                expect(fixture.perLayer.data).toEqual(fixture.initialPerLayer);
                expect(fixture.audioFeatures.data).toEqual(fixture.initialAudioFeatures);
            } finally {
                await fixture.model.dispose();
            }
        },
    );
});
