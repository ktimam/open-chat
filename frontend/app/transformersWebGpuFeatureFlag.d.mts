export function transformersWebGpuFeatureEnabled(
    environment:
        | {
              readonly [key: string]: string | undefined;
              readonly OC_BUILD_ENV?: string;
              readonly OC_DFX_NETWORK?: string;
              readonly OC_TRANSFORMERS_WEBGPU_IMAGE_SPIKE?: string;
          }
        | undefined,
): boolean;
