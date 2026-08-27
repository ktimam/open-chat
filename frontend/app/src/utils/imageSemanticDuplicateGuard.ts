import type { RunAiActionResult } from "@shared";
import { sha256 } from "@noble/hashes/sha2.js";

const MAX_CANONICAL_SEMANTIC_BYTES = 64 * 1024;
const MAX_CANONICAL_DEPTH = 16;
const MAX_CANONICAL_NODES = 4_096;
const SHA256_HEX = /^[0-9a-f]{64}$/u;

export interface BrowserModelImageEvidence {
    requestId: number;
    selectionGeneration: number;
    selectedModelId: string | undefined;
    structuredJsonAction: boolean;
    effectiveImageSha256: string;
}

export interface SemanticImageActionScope {
    appId?: number;
    appRevision?: bigint;
    actionId: string;
}

type SemanticGuardRecord = {
    scopeSha256: string;
    modelSha256: string;
    selectionGeneration: number;
    imageSha256: string;
    semanticSha256: string;
    requestId: number;
};

let previous: SemanticGuardRecord | undefined;

function digest(bytes: Uint8Array): string {
    return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function digestText(value: string): string {
    return digest(new TextEncoder().encode(value));
}

function canonicalJson(value: unknown): string | undefined {
    let nodes = 0;
    const ancestors = new Set<object>();
    const visit = (entry: unknown, depth: number): unknown => {
        nodes += 1;
        if (nodes > MAX_CANONICAL_NODES || depth > MAX_CANONICAL_DEPTH) throw new Error("bounded");
        if (
            entry === null ||
            typeof entry === "string" ||
            typeof entry === "boolean" ||
            (typeof entry === "number" && Number.isFinite(entry))
        ) {
            return entry;
        }
        if (typeof entry !== "object") throw new Error("non-json");
        if (ancestors.has(entry)) throw new Error("cycle");
        ancestors.add(entry);
        try {
            if (Array.isArray(entry)) return entry.map((item) => visit(item, depth + 1));
            const prototype = Object.getPrototypeOf(entry);
            if (prototype !== Object.prototype && prototype !== null) throw new Error("non-plain");
            const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
            for (const key of Object.keys(entry as Record<string, unknown>).sort()) {
                const child = (entry as Record<string, unknown>)[key];
                // Match JSON object semantics: undefined/function/symbol properties do not reach the
                // action's frozen confirm payload and therefore are not part of its visible meaning.
                if (["undefined", "function", "symbol"].includes(typeof child)) continue;
                out[key] = visit(child, depth + 1);
            }
            return out;
        } finally {
            ancestors.delete(entry);
        }
    };

    try {
        const json = JSON.stringify(visit(value, 0));
        if (new TextEncoder().encode(json).byteLength > MAX_CANONICAL_SEMANTIC_BYTES)
            return undefined;
        return json;
    } catch {
        return undefined;
    }
}

function readyCandidates(result: RunAiActionResult): Record<string, unknown>[] | undefined {
    if (result.kind === "ready") return [result.extracted];
    if (result.kind === "ready_multi") return result.extracted;
    return undefined;
}

/**
 * One-session, one-record semantic replay detector for browser MODEL image results.
 *
 * The caller supplies the runtime-owned effective image digest. This function stores only SHA-256
 * digests plus bounded numeric ids; pixels, prompts, model output, notes, and canonical JSON are
 * discarded before it returns. A rejected distinct image becomes the current record so retrying
 * that same image is allowed and the selected model is never disabled or poisoned.
 */
export function isSemanticDuplicateBrowserImageResult(
    scope: SemanticImageActionScope,
    evidence: BrowserModelImageEvidence,
    result: RunAiActionResult,
): boolean {
    const candidates = readyCandidates(result);
    if (
        candidates === undefined ||
        evidence.structuredJsonAction !== true ||
        !Number.isSafeInteger(evidence.requestId) ||
        evidence.requestId < 1 ||
        !Number.isSafeInteger(evidence.selectionGeneration) ||
        evidence.selectionGeneration < 0 ||
        !SHA256_HEX.test(evidence.effectiveImageSha256) ||
        scope.actionId.length === 0 ||
        scope.actionId.length > 256 ||
        (evidence.selectedModelId !== undefined && evidence.selectedModelId.length > 256)
    ) {
        return false;
    }
    const canonical = canonicalJson(candidates);
    if (canonical === undefined) return false;
    const current: SemanticGuardRecord = {
        scopeSha256: digestText(
            JSON.stringify([
                scope.appId ?? null,
                scope.appRevision?.toString() ?? null,
                scope.actionId,
            ]),
        ),
        modelSha256: digestText(evidence.selectedModelId ?? ""),
        selectionGeneration: evidence.selectionGeneration,
        imageSha256: evidence.effectiveImageSha256,
        semanticSha256: digestText(canonical),
        requestId: evidence.requestId,
    };
    const duplicate =
        previous !== undefined &&
        previous.scopeSha256 === current.scopeSha256 &&
        previous.modelSha256 === current.modelSha256 &&
        previous.selectionGeneration === current.selectionGeneration &&
        previous.imageSha256 !== current.imageSha256 &&
        previous.semanticSha256 === current.semanticSha256;
    previous = current;
    return duplicate;
}

/** Test isolation only; production never clears the record as a side effect of a rejection. */
export function resetSemanticImageDuplicateGuardForTests(): void {
    previous = undefined;
}
