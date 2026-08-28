import { get, writable, type Subscriber } from "svelte/store";

export type BrowserImageActionMode =
    | "model_only"
    | "model_with_local_verification"
    | "local_reader_only";

// localStorage is scoped to the current origin, matching the browser model cache/selection. This is
// a user invocation choice, never an app capability grant. In local_reader_only mode image actions
// may use only an app-declared source-grounded local reader; they never invoke the selected model.
// model_only is the inverse hard boundary. The default asks the runner to reconcile a selected
// all-WebGPU image model with independent local source reading; the runner owns that policy.
const STORAGE_KEY = "openchat_browser_image_action_mode";
const LEGACY_LOCAL_READER_FIRST = "local_reader_first";

function storedMode(): BrowserImageActionMode {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (
            stored === "local_reader_only" ||
            stored === "model_only" ||
            stored === "model_with_local_verification"
        ) {
            return stored;
        }
        if (stored === LEGACY_LOCAL_READER_FIRST) {
            // Preserve the user's enabled choice while retiring the misleading "first" contract.
            localStorage.setItem(STORAGE_KEY, "local_reader_only");
            return "local_reader_only";
        }
        return "model_with_local_verification";
    } catch {
        return "model_with_local_verification";
    }
}

const value = writable<BrowserImageActionMode>(storedMode());

export const browserImageActionMode = {
    subscribe: (subscriber: Subscriber<BrowserImageActionMode>, invalidate?: () => void) =>
        value.subscribe(subscriber, invalidate),
    set: (mode: BrowserImageActionMode): void => {
        value.set(mode);
        try {
            localStorage.setItem(STORAGE_KEY, mode);
        } catch {
            // Storage-disabled/private contexts still retain the choice for this tab.
        }
    },
};

export function browserUsesLocalReaderOnly(): boolean {
    return get(value) === "local_reader_only";
}

export function browserUsesModelWithLocalVerification(): boolean {
    return get(value) === "model_with_local_verification";
}

/**
 * Whether the shared proposal flow must probe the selected model before it starts. Both browser
 * image modes with a declared local path enter the runner without the generic outer gate: OCR-only
 * never probes a model, while verification mode performs its own model readiness check and can
 * recover a failed/unavailable model only from a complete source-grounded local card. Text, native
 * proposals and browser model-only retain the outer readiness gate.
 */
export function browserImageProposalRequiresModelReadiness(
    isImage: boolean,
    nativeClient: boolean,
): boolean {
    return (
        nativeClient ||
        !isImage ||
        (!browserUsesLocalReaderOnly() && !browserUsesModelWithLocalVerification())
    );
}
