import { get, writable, type Subscriber } from "svelte/store";

export type BrowserImageActionMode =
    | "model_only"
    | "model_with_local_verification"
    | "local_reader_only";

// localStorage is scoped to the current origin, matching the browser model cache/selection. This is
// a user invocation choice, never an app capability grant. In local_reader_only mode image actions
// use app-declared OCR profiles plus the app's own parser, without loading or running a model.
// model_only is the inverse hard boundary and the default: a fresh browser follows the selected
// all-WebGPU image-model path without silently introducing OCR. The two local-reader modes remain
// explicit, persisted user choices; the runner owns those policies once selected.
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
        return "model_only";
    } catch {
        return "model_only";
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

export function browserUsesModelOnly(): boolean {
    return get(value) === "model_only";
}

export function browserUsesModelWithLocalVerification(): boolean {
    return get(value) === "model_with_local_verification";
}

/**
 * OCR-only image actions use the app's own local parser in browsers and WebGPU Android builds.
 * Other image modes and non-image model actions retain the normal readiness check.
 */
export function browserImageProposalRequiresModelReadiness(
    isImage: boolean,
    _nativeClient: boolean,
): boolean {
    return !isImage || !browserUsesLocalReaderOnly();
}
