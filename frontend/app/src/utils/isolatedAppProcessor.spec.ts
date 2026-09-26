import { afterEach, describe, expect, it, vi } from "vitest";
import {
    LOCAL_PROCESSOR_BOOTSTRAP,
    abortIsolatedAppProcessors,
    localProcessorBootstrapCspSource,
    parseIsolatedProcessorOutput,
    runIsolatedAppProcessor,
    verifyImportedLocalProcessor,
    type ImportedLocalProcessor,
} from "./isolatedAppProcessor";

async function artifact(
    source = 'onmessage = () => postMessage({kind:"none"});',
): Promise<ImportedLocalProcessor> {
    const bytes = new TextEncoder().encode(source);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return {
        source,
        byteLength: bytes.byteLength,
        sha256: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(
            "",
        ),
    };
}

function fakeDom(output: unknown = { kind: "none" }, wrongOrigin = false) {
    let receiver: ((event: MessageEvent) => void) | undefined;
    const attributes = new Map<string, string>();
    const frame = {
        srcdoc: "",
        hidden: false,
        referrerPolicy: "",
        setAttribute: (key: string, value: string) => attributes.set(key, value),
        addEventListener: vi.fn(),
        remove: vi.fn(),
        contentWindow: {
            postMessage: vi.fn((message: Record<string, unknown>) => {
                if (message.type === "oc:local-process:start" && output !== undefined)
                    queueMicrotask(() =>
                        receiver?.({
                            source: frame.contentWindow,
                            origin: wrongOrigin ? "https://untrusted.invalid" : "null",
                            data: {
                                type: "oc:local-process:result",
                                version: 1,
                                nonce: message.nonce,
                                output,
                            },
                        } as unknown as MessageEvent),
                    );
            }),
        },
    };
    const createElement = vi.fn(() => frame);
    vi.stubGlobal("window", {
        addEventListener: (_kind: string, callback: (event: MessageEvent) => void) => {
            receiver = callback;
        },
        removeEventListener: () => {
            receiver = undefined;
        },
    });
    vi.stubGlobal("document", {
        createElement,
        body: {
            append: vi.fn(() =>
                queueMicrotask(() =>
                    receiver?.({
                        source: frame.contentWindow,
                        origin: "null",
                        data: { type: "oc:local-process:ready", version: 1 },
                    } as unknown as MessageEvent),
                ),
            ),
        },
    });
    return { frame, attributes, createElement };
}

afterEach(() => {
    abortIsolatedAppProcessors();
    vi.unstubAllGlobals();
});

describe("isolated app processor", () => {
    it("pins the bootstrap hash that the static parent CSP must authorize", async () => {
        // Changing trusted bootstrap bytes requires updating the deployment CSP in the same change.
        expect(await localProcessorBootstrapCspSource()).toBe(
            "'sha256-I/prlf8CUg20D4Y+eHWS9nTAgsMREJwX8s/3ln5NZms='",
        );
    });
    it("checks exact imported source hash and byte length without loading a remote URL", async () => {
        const value = await artifact();
        expect(await verifyImportedLocalProcessor(value)).toBe(true);
        expect(await verifyImportedLocalProcessor({ ...value, source: value.source + " " })).toBe(
            false,
        );
        expect(await verifyImportedLocalProcessor({ ...value, sha256: "0".repeat(64) })).toBe(
            false,
        );
        expect(
            await verifyImportedLocalProcessor({ ...value, byteLength: value.byteLength + 1 }),
        ).toBe(false);
    });
    it("uses exact bootstrap hash, opaque origin and no-network CSP; app source is data, not frame HTML", async () => {
        const { frame, attributes } = fakeDom({
            kind: "candidates",
            candidates: [{ label: "synthetic" }],
        });
        const value = await artifact(
            'onmessage = () => postMessage({kind:"none"}); // ARTIFACT_ONLY',
        );
        const result = await runIsolatedAppProcessor(
            value,
            "sample.save",
            JSON.stringify({
                operation: "extract",
                modality: "text",
                text: "SYNTHETIC_PRIVATE_MARKER",
            }),
        );
        expect(result.kind).toBe("candidates");
        expect(attributes.get("sandbox")).toBe("allow-scripts");
        expect(frame.srcdoc).toContain("connect-src 'none'");
        expect(frame.srcdoc).toContain(await localProcessorBootstrapCspSource());
        expect(frame.srcdoc).toContain(LOCAL_PROCESSOR_BOOTSTRAP);
        expect(frame.srcdoc).not.toContain("ARTIFACT_ONLY");
        expect(frame.srcdoc).not.toContain("SYNTHETIC_PRIVATE_MARKER");
        const start = frame.contentWindow.postMessage.mock.calls.find(
            ([message]) => message.type === "oc:local-process:start",
        )![0];
        expect(start.source).toBe(value.source);
        expect(start.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(frame.remove).toHaveBeenCalledOnce();
    });
    it("rejects hash failure before constructing a frame or sending source input", async () => {
        const { createElement } = fakeDom();
        const value = await artifact();
        const result = await runIsolatedAppProcessor(
            { ...value, sha256: "0".repeat(64) },
            "sample.save",
            '{"operation":"extract","modality":"text","text":"PRIVATE"}',
        );
        expect(result.kind).toBe("error");
        expect(createElement).not.toHaveBeenCalled();
    });
    it("passes explicitly imported app context separately from source input and frame HTML", async () => {
        const { frame } = fakeDom();
        await runIsolatedAppProcessor(
            await artifact(),
            "sample.save",
            '{"operation":"extract","modality":"text","text":"SYNTHETIC_SOURCE"}',
            { contextJson: '{"labels":["SYNTHETIC_IMPORTED_CONTEXT"]}' },
        );
        const start = frame.contentWindow.postMessage.mock.calls.find(
            ([message]) => message.type === "oc:local-process:start",
        )![0];
        expect(start.request).toMatchObject({
            context: { labels: ["SYNTHETIC_IMPORTED_CONTEXT"] },
            input: { text: "SYNTHETIC_SOURCE" },
        });
        expect(frame.srcdoc).not.toContain("SYNTHETIC_IMPORTED_CONTEXT");
    });
    it("never accepts output from another frame origin and times out without fallback", async () => {
        const { frame } = fakeDom({ kind: "none" }, true);
        const result = await runIsolatedAppProcessor(
            await artifact(),
            "sample.save",
            '{"operation":"extract","modality":"text"}',
            { timeoutMs: 100 },
        );
        expect(result.kind).toBe("error");
        expect(frame.remove).toHaveBeenCalledOnce();
    });
    it("honors cancellation before creating the sandbox", async () => {
        const { createElement } = fakeDom();
        const controller = new AbortController();
        controller.abort();
        expect(
            (
                await runIsolatedAppProcessor(await artifact(), "sample.save", "{}", {
                    signal: controller.signal,
                })
            ).kind,
        ).toBe("error");
        expect(createElement).not.toHaveBeenCalled();
    });
    it("rejects malformed input before entering the app worker", async () => {
        const { createElement } = fakeDom();
        expect(
            (
                await runIsolatedAppProcessor(
                    await artifact(),
                    "sample.save",
                    '{"operation":"normalize_raw","modality":"text","candidates":[{}]}',
                )
            ).kind,
        ).toBe("error");
        expect(createElement).not.toHaveBeenCalled();
    });
    it("checks raw normalization cardinality and source index mapping", () => {
        const input = { operation: "normalize_raw", candidates: [{ raw: "x" }, { raw: "y" }] };
        expect(
            parseIsolatedProcessorOutput(
                {
                    kind: "candidates",
                    candidates: [{ label: "a" }, { label: "b" }],
                    sourceIndexes: [0, 1],
                },
                input,
            ).kind,
        ).toBe("candidates");
        expect(
            parseIsolatedProcessorOutput(
                { kind: "candidates", candidates: [{ label: "a" }], sourceIndexes: [0] },
                input,
            ).kind,
        ).toBe("error");
        expect(
            parseIsolatedProcessorOutput(
                { kind: "candidates", candidates: [{}, {}], sourceIndexes: [1, 0] },
                input,
            ).kind,
        ).toBe("error");
    });
    it("bounds returned values and never exposes raw app errors", () => {
        expect(
            parseIsolatedProcessorOutput({ kind: "error", message: "SECRET" }, {}),
        ).not.toHaveProperty("message");
        expect(
            parseIsolatedProcessorOutput(
                { kind: "candidates", candidates: [{ label: "x".repeat(65_537) }] },
                {},
            ).kind,
        ).toBe("error");
        expect(
            parseIsolatedProcessorOutput({ kind: "candidates", candidates: [{ x: () => 1 }] }, {})
                .kind,
        ).toBe("error");
    });
});
