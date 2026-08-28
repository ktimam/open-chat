<script lang="ts">
    import {
        browserImageActionMode,
        type BrowserImageActionMode,
    } from "../stores/browserImageActionMode";
    import { prepareBrowserImageModelFirst } from "../utils/webInference";

    let changing = $state(false);
    let readinessError = $state("");

    const choices: {
        value: BrowserImageActionMode;
        title: string;
        detail: string;
        recommended?: boolean;
    }[] = [
        {
            value: "model_only",
            title: "Model only",
            detail: "The selected Qwen3-VL 2B all-WebGPU model receives the original image directly. The local reader/OCR is never invoked in this mode.",
            recommended: true,
        },
        {
            value: "model_with_local_verification",
            title: "Model + local verification",
            detail: "Local OCR reads the image first and remains authoritative. After a complete read, the selected Qwen3-VL 2B all-WebGPU model checks only bounded private OCR evidence; it does not receive the original image in this mode. A mismatch or incomplete read stops the proposal. If model verification cannot finish, only the complete source-grounded OCR card is returned.",
        },
        {
            value: "local_reader_only",
            title: "Local reader (OCR) only",
            detail: "Only local OCR and the source-grounded parser run. The selected model is never invoked, even when local reading is incomplete or unavailable.",
        },
    ];

    async function choose(mode: BrowserImageActionMode) {
        if (changing || mode === $browserImageActionMode) return;
        readinessError = "";
        browserImageActionMode.set(mode);
        // Verification must not pre-load the image runtime: OCR may stop the request before any
        // model work, and model verification receives only bounded private text evidence.
        if (mode !== "model_only") return;

        changing = true;
        try {
            if (
                !(await prepareBrowserImageModelFirst({
                    retryAfterRecentFailure: true,
                }))
            ) {
                readinessError =
                    "The current image model or WebGPU profile is not ready. Model-only keeps OCR disabled, so the proposal will stop.";
            }
        } catch {
            readinessError =
                "Image-model readiness could not be checked. Model-only keeps OCR disabled; reopen OpenChat and check the selected model below.";
        } finally {
            changing = false;
        }
    }
</script>

<fieldset class="image-action-modes" disabled={changing}>
    <legend>App image action mode</legend>
    {#each choices as choice (choice.value)}
        <label class:current={$browserImageActionMode === choice.value}>
            <input
                type="radio"
                name="browser-image-action-mode"
                value={choice.value}
                checked={$browserImageActionMode === choice.value}
                onchange={() => choose(choice.value)}
            />
            <span class="choice-copy">
                <span class="choice-title">
                    {choice.title}
                    {#if choice.recommended}<span class="recommended">recommended</span>{/if}
                </span>
                <span class="choice-detail">{choice.detail}</span>
            </span>
        </label>
    {/each}
</fieldset>

<p class="mode-boundary">
    This setting applies only to app actions proposed from images. Text messages are unchanged, and
    neither isolation mode silently falls back to the other engine.
</p>

{#if readinessError !== ""}
    <p class="mode-error" role="status">{readinessError}</p>
{/if}

<style lang="scss">
    .image-action-modes {
        min-width: 0;
        margin: 0;
        padding: 0;
        border: 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    legend {
        padding: 0;
        margin-bottom: 8px;
        font-weight: 700;
    }
    label {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 10px;
        border: 1px solid var(--bd, rgba(127, 127, 127, 0.35));
        border-radius: 10px;
        cursor: pointer;
    }
    label.current {
        border-color: var(--accent, #4a90d9);
        background: color-mix(in srgb, var(--accent, #4a90d9) 8%, transparent);
    }
    input {
        margin-top: 3px;
        accent-color: var(--accent, #4a90d9);
    }
    .choice-copy {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 3px;
    }
    .choice-title {
        font-weight: 700;
    }
    .choice-detail,
    .mode-boundary,
    .mode-error {
        margin: 0;
        color: var(--txt-light, var(--text-secondary));
        font-size: 0.85rem;
        line-height: 1.35;
    }
    .recommended {
        display: inline-block;
        margin-inline-start: 6px;
        padding: 1px 6px;
        border-radius: 999px;
        color: var(--accent, #4a90d9);
        border: 1px solid currentColor;
        font-size: 0.72rem;
        font-weight: 600;
    }
    .mode-boundary {
        margin-top: 8px;
    }
    .mode-error {
        margin-top: 8px;
        color: var(--error, #b00020);
    }
</style>
