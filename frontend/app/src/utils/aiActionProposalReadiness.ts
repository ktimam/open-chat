import { isNativeClient, onDeviceInferenceReadiness } from "./onDeviceInference";
import { browserImageModelFirstReadiness } from "./webInference";

/**
 * Readiness used by the shared Propose flow before it invokes a candidate.
 *
 * Browser model-only images need the image runtime's revision-aware answer; the generic facade also
 * counts browser OCR as locally available and therefore cannot distinguish a stale selected Qwen
 * cache. The caller bypasses this helper entirely for both explicit local-reader image modes.
 */
export function aiActionProposalReadiness(isImage: boolean) {
    return !isNativeClient() && isImage
        ? browserImageModelFirstReadiness({ retryAfterRecentFailure: true })
        : onDeviceInferenceReadiness();
}
