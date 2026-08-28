/**
 * The all-WebGPU phone runtime is deliberately limited to the local development build that owns
 * the audited `/hf-model` proxy and patched Adreno graph routes. Production cannot enable this
 * merely by exporting the flag: its asset pipeline does not distribute those model artifacts.
 */
export function transformersWebGpuFeatureEnabled(environment) {
    return (
        environment?.OC_BUILD_ENV === "development" &&
        environment?.OC_DFX_NETWORK === "local" &&
        environment?.OC_TRANSFORMERS_WEBGPU_IMAGE_SPIKE === "true"
    );
}
