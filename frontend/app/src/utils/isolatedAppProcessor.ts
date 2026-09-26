import { snapshotLocalDraftJson } from "./localAppDrafts";
import type { LocalProcessorArtifactDescriptor } from "./localAppCatalog";

export interface ImportedLocalProcessor extends LocalProcessorArtifactDescriptor {
    readonly source: string;
}

export type IsolatedAppProcessorResult =
    | { kind: "candidates"; candidates: Record<string, unknown>[]; sourceIndexes?: number[] }
    | { kind: "none" | "ambiguous" }
    | { kind: "error"; error: string };

// Static trusted code ONLY. App code is received as data and executes solely inside a DedicatedWorker.
// Keep its exact hash allowed by the embedding document CSP as srcdoc inherits the parent's CSP.
export const LOCAL_PROCESSOR_BOOTSTRAP = String.raw`(() => {
    "use strict";
    let worker;
    let workerUrl;
    let nonce;
    let started = false;
    const stop = () => {
        if (worker) worker.terminate();
        if (workerUrl) URL.revokeObjectURL(workerUrl);
        worker = undefined;
        workerUrl = undefined;
    };
    addEventListener("pagehide", stop);
    addEventListener("message", (event) => {
        if (event.source !== parent) return;
        const data = event.data;
        if (!data || data.version !== 1) return;
        if (started && data.type === "oc:local-process:stop" && data.nonce === nonce) {
            stop();
            return;
        }
        if (started || data.type !== "oc:local-process:start" || typeof data.nonce !== "string" ||
            !/^[A-Za-z0-9_-]{43}$/.test(data.nonce) || typeof data.source !== "string") return;
        started = true;
        nonce = data.nonce;
        const send = (output) => parent.postMessage({ type: "oc:local-process:result", version: 1, nonce, output }, "*");
        const prelude = '"use strict";\n' +
            'for (const name of ["Worker", "SharedWorker", "BroadcastChannel"]) Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });\n' +
            'Object.defineProperty(globalThis, "console", { value: Object.freeze(Object.fromEntries(["log","error","warn","info","debug","trace","table","dir","group","groupEnd","time","timeEnd","assert","clear"].map(name => [name, () => {}]))), writable: false, configurable: false });\n' +
            'addEventListener("unhandledrejection", event => event.preventDefault());\n';
        try {
            workerUrl = URL.createObjectURL(new Blob([prelude, data.source], { type: "text/javascript" }));
            worker = new Worker(workerUrl);
            worker.onmessage = (message) => { send(message.data); stop(); };
            worker.onerror = (event) => { event.preventDefault(); send({ kind: "error" }); stop(); };
            worker.onmessageerror = () => { send({ kind: "error" }); stop(); };
            worker.postMessage(data.request);
        } catch { send({ kind: "error" }); stop(); }
    });
    parent.postMessage({ type: "oc:local-process:ready", version: 1 }, "*");
})();`;

const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_INPUT_TEXT_BYTES = 32 * 1024;
const MAX_ACTIVE = 2;
const active = new Set<() => void>();

function error(): IsolatedAppProcessorResult {
    return {
        kind: "error",
        error: "The app's isolated local processor could not complete. No external processor was contacted.",
    };
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseInput(json: string): Record<string, unknown> {
    if (typeof json !== "string" || new TextEncoder().encode(json).byteLength > 64 * 1024)
        throw new Error("Invalid local processor input");
    const input = snapshotLocalDraftJson(JSON.parse(json));
    if (
        !record(input) ||
        Object.keys(input).some(
            (key) =>
                ![
                    "operation",
                    "modality",
                    "text",
                    "ocrTranscripts",
                    "sourceTimestamp",
                    "candidates",
                ].includes(key),
        ) ||
        !["extract", "normalize", "normalize_raw"].includes(input.operation as string) ||
        !["text", "image", "audio"].includes(input.modality as string)
    )
        throw new Error("Invalid local processor input");
    if (
        input.text !== undefined &&
        (typeof input.text !== "string" ||
            new TextEncoder().encode(input.text).byteLength > MAX_INPUT_TEXT_BYTES)
    )
        throw new Error("Invalid local processor input");
    if (
        input.sourceTimestamp !== undefined &&
        (typeof input.sourceTimestamp !== "number" ||
            !Number.isFinite(input.sourceTimestamp) ||
            Math.abs(input.sourceTimestamp) > 8.64e15)
    )
        throw new Error("Invalid local processor input");
    if (
        input.candidates !== undefined &&
        (!Array.isArray(input.candidates) ||
            input.candidates.length === 0 ||
            input.candidates.length > 32 ||
            !input.candidates.every(record))
    )
        throw new Error("Invalid local processor input");
    if (
        input.ocrTranscripts !== undefined &&
        (!Array.isArray(input.ocrTranscripts) ||
            input.ocrTranscripts.length === 0 ||
            input.ocrTranscripts.length > 4 ||
            input.ocrTranscripts.some(
                (entry) =>
                    !record(entry) ||
                    Object.keys(entry).sort().join(",") !== "profile,text" ||
                    typeof entry.profile !== "string" ||
                    entry.profile.length > 64 ||
                    typeof entry.text !== "string",
            ))
    )
        throw new Error("Invalid local processor input");
    if (input.operation !== "extract" && input.candidates === undefined)
        throw new Error("Invalid local processor input");
    if (input.operation === "extract" && input.candidates !== undefined)
        throw new Error("Invalid local processor input");
    if (
        input.operation === "normalize_raw" &&
        (input.modality !== "image" || input.ocrTranscripts !== undefined)
    )
        throw new Error("Invalid local processor input");
    return input;
}

export function parseIsolatedProcessorOutput(
    output: unknown,
    input: Record<string, unknown>,
): IsolatedAppProcessorResult {
    try {
        const value = snapshotLocalDraftJson(output);
        if (!record(value)) return error();
        if (value.kind === "candidates") {
            if (
                Object.keys(value).some(
                    (key) => !["kind", "candidates", "sourceIndexes"].includes(key),
                ) ||
                !Array.isArray(value.candidates) ||
                value.candidates.length === 0 ||
                value.candidates.length > 32 ||
                !value.candidates.every(record)
            )
                return error();
            if (input.operation === "normalize_raw") {
                if (
                    !Array.isArray(input.candidates) ||
                    value.candidates.length !== input.candidates.length ||
                    !Array.isArray(value.sourceIndexes) ||
                    value.sourceIndexes.length !== value.candidates.length ||
                    value.sourceIndexes.some((index, position) => index !== position)
                )
                    return error();
            } else if (value.sourceIndexes !== undefined) return error();
            return value as unknown as IsolatedAppProcessorResult;
        }
        if (Object.keys(value).length !== 1) return error();
        if (value.kind === "none" || value.kind === "ambiguous") return { kind: value.kind };
        return error();
    } catch {
        return error();
    }
}

export async function localProcessorBootstrapCspSource(): Promise<string> {
    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(LOCAL_PROCESSOR_BOOTSTRAP),
    );
    return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
}

/** Verify imported bytes BEFORE creating any execution context or passing source data. */
export async function verifyImportedLocalProcessor(
    artifact: ImportedLocalProcessor,
): Promise<boolean> {
    const { source, sha256, byteLength } = artifact;
    if (
        typeof source !== "string" ||
        !/^[a-f0-9]{64}$/.test(sha256) ||
        !Number.isSafeInteger(byteLength) ||
        byteLength < 1 ||
        byteLength > MAX_SOURCE_BYTES
    )
        return false;
    const bytes = new TextEncoder().encode(source);
    if (bytes.byteLength !== byteLength) return false;
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return (
        Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
            "",
        ) === sha256
    );
}

export function abortIsolatedAppProcessors(): void {
    for (const cancel of [...active]) cancel();
}

/**
 * Source is an explicitly imported, hash-pinned app artifact; never a URL. The bootstrap runs in
 * opaque srcdoc with restrictive CSP and creates the app worker there, not in the host origin.
 * Callers abort on account/source/config changes. A CSP-blocked platform fails closed, no iframe
 * URL/network fallback. Runtime-specific browser/APK isolation tests are required for release.
 */
export async function runIsolatedAppProcessor(
    artifact: ImportedLocalProcessor,
    actionId: string,
    inputJson: string,
    options: { signal?: AbortSignal; timeoutMs?: number; contextJson?: string } = {},
): Promise<IsolatedAppProcessorResult> {
    let input: Record<string, unknown>;
    let context: unknown;
    let cspSource: string;
    const source = artifact.source; // Pin caller-owned artifact fields before the async digest.
    const sha256 = artifact.sha256;
    const byteLength = artifact.byteLength;
    try {
        if (
            options.signal?.aborted ||
            active.size >= MAX_ACTIVE ||
            typeof actionId !== "string" ||
            !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(actionId)
        )
            return error();
        input = parseInput(inputJson);
        if (options.contextJson !== undefined) {
            if (new TextEncoder().encode(options.contextJson).byteLength > 64 * 1024)
                return error();
            context = snapshotLocalDraftJson(JSON.parse(options.contextJson));
        }
        if (!(await verifyImportedLocalProcessor({ source, sha256, byteLength }))) return error();
        cspSource = await localProcessorBootstrapCspSource();
    } catch {
        return error();
    }
    if (options.signal?.aborted || active.size >= MAX_ACTIVE) return error();
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    const timeoutMs = Math.max(100, Math.min(30_000, options.timeoutMs ?? 30_000));
    return new Promise((resolve) => {
        const frame = document.createElement("iframe");
        frame.setAttribute("sandbox", "allow-scripts");
        frame.setAttribute("credentialless", "");
        frame.setAttribute("aria-hidden", "true");
        frame.referrerPolicy = "no-referrer";
        frame.hidden = true;
        let finished = false;
        let started = false;
        const finish = (result: IsolatedAppProcessorResult) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            window.removeEventListener("message", receive);
            options.signal?.removeEventListener("abort", cancel);
            try {
                frame.contentWindow?.postMessage(
                    { type: "oc:local-process:stop", version: 1, nonce },
                    "*",
                );
            } catch {
                /* Teardown must still complete. */
            }
            frame.remove();
            active.delete(cancel);
            resolve(result);
        };
        const cancel = () => finish(error());
        const receive = (event: MessageEvent) => {
            if (
                finished ||
                event.source !== frame.contentWindow ||
                event.origin !== "null" ||
                !record(event.data)
            )
                return;
            const data = event.data;
            if (
                !started &&
                data.type === "oc:local-process:ready" &&
                data.version === 1 &&
                Object.keys(data).length === 2
            ) {
                started = true;
                frame.contentWindow?.postMessage(
                    {
                        type: "oc:local-process:start",
                        version: 1,
                        nonce,
                        source,
                        request: {
                            type: "oc:local-process:request",
                            version: 1,
                            actionId,
                            input,
                            ...(context === undefined ? {} : { context }),
                        },
                    },
                    "*",
                );
            } else if (
                started &&
                data.type === "oc:local-process:result" &&
                data.version === 1 &&
                data.nonce === nonce &&
                Object.keys(data).length === 4
            ) {
                finish(parseIsolatedProcessorOutput(data.output, input));
            }
        };
        const timer = setTimeout(cancel, timeoutMs);
        active.add(cancel);
        options.signal?.addEventListener("abort", cancel, { once: true });
        window.addEventListener("message", receive);
        frame.addEventListener("error", cancel, { once: true });
        const policy = `default-src 'none'; connect-src 'none'; script-src ${cspSource}; worker-src blob:; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'`;
        frame.srcdoc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><script>${LOCAL_PROCESSOR_BOOTSTRAP}</script>`;
        document.body.append(frame);
        if (options.signal?.aborted) cancel();
    });
}
